const DEFAULT_TIMEOUT_MS = 55_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_URI_BYTES = 32_768;

export class ManualNaultInputError extends Error {
  constructor(code) {
    super(`Manual Nault input refused (${code})`);
    this.name = 'ManualNaultInputError';
    this.code = code;
  }
}

/**
 * Read one hidden, bounded ASCII line using Node's public TTY/readable APIs.
 * This function never writes input, stores a file, or controls a wallet. The
 * caller must be the operator running the entire live purchase themselves.
 *
 * A raw TTY prevents the terminal driver from echoing the signed payment. We do
 * not use readline, private methods, prototype overrides or output redaction.
 * Refuse another active reader rather than silently sharing spendable input.
 * Completion, cancellation, EOF, stream failures and timeout all remove our
 * listeners and restore the prior raw/flow state. An OS kill or broken TTY can
 * prevent restoration; a restoration failure is reported without input data.
 */
export function readSignedNaultURI({
  input,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_URI_BYTES,
  signal,
} = {}) {
  const reject = (code) => Promise.reject(new ManualNaultInputError(code));
  if (!input || input.isTTY !== true || typeof input.isRaw !== 'boolean' ||
      typeof input.setRawMode !== 'function' || typeof input.isPaused !== 'function' ||
      typeof input.resume !== 'function' || typeof input.pause !== 'function' ||
      typeof input.on !== 'function' || typeof input.removeListener !== 'function' ||
      typeof input.listenerCount !== 'function') return reject('TTY_REQUIRED');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_URI_BYTES) {
    return reject('INVALID_LIMITS');
  }
  if (input.listenerCount('data') || input.listenerCount('readable')) {
    return reject('TTY_IN_USE');
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    return reject('INVALID_ABORT_SIGNAL');
  }
  if (signal?.aborted) return reject('CANCELED');

  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  return new Promise((resolve, rejectPromise) => {
    let settled = false;
    let timer;
    let rawChanged = false;
    const bytes = [];

    function cleanup() {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      bytes.fill(0);
      bytes.length = 0;
      let restored = true;
      if (rawChanged) {
        try { input.setRawMode(wasRaw); } catch { restored = false; }
      }
      try { if (wasPaused) input.pause(); else input.resume(); }
      catch { restored = false; }
      return restored;
    }

    function finish(errorCode, value) {
      if (settled) return;
      settled = true;
      if (!cleanup()) {
        rejectPromise(new ManualNaultInputError('TTY_RESTORE_FAILED'));
      } else if (errorCode) {
        rejectPromise(new ManualNaultInputError(errorCode));
      } else {
        resolve(value);
      }
    }

    function onAbort() { finish('CANCELED'); }
    function onEnd() { finish('INPUT_ENDED'); }
    function onError() { finish('INPUT_FAILED'); }
    function onData(chunk) {
      try {
        const data = Buffer.isBuffer(chunk) ? chunk :
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : null;
        if (!data) { finish('INVALID_INPUT'); return; }
        for (const byte of data) {
          if (byte === 3) { finish('CANCELED'); return; } // Ctrl-C in raw mode.
          if (byte === 4) { finish('INPUT_ENDED'); return; } // Ctrl-D/EOF.
          if (byte === 8 || byte === 127) { bytes.pop(); continue; }
          if (byte === 10 || byte === 13) {
            const value = Buffer.from(bytes).toString('ascii').trim();
            if (!value.startsWith('nanoprocess:') || value.length <= 'nanoprocess:'.length) {
              finish('INVALID_URI');
            } else {
              finish(undefined, value);
            }
            return;
          }
          // One-line Nault URIs are printable ASCII. Refuse terminal escape
          // sequences, non-ASCII text and unexpected control characters.
          if (byte < 32 || byte > 126) { finish('INVALID_ASCII'); return; }
          if (bytes.length >= maxBytes) { finish('INPUT_TOO_LONG'); return; }
          bytes.push(byte);
        }
      } catch {
        finish('INPUT_FAILED');
      }
    }

    try {
      // Public Node TTY API: setRawMode(true) disables canonical input and echo.
      // Mark the restoration obligation before the call in case a TTY reports
      // a setup failure after partially changing its mode.
      if (!wasRaw) { rawChanged = true; input.setRawMode(true); }
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('close', onEnd);
      input.on('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      // The AbortSignal may have changed during setup; never wait after abort.
      if (signal?.aborted) { finish('CANCELED'); return; }
      timer = setTimeout(() => finish('TIMED_OUT'), timeoutMs);
      input.resume();
    } catch {
      finish('TTY_SETUP_FAILED');
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readSignedNaultURI } from './manual-nault-tty.mjs';

class FakeTTY extends EventEmitter {
  constructor({ raw = false, paused = true } = {}) {
    super();
    this.isTTY = true;
    this.isRaw = raw;
    this.paused = paused;
    this.rawCalls = [];
    this.flowCalls = [];
    this.echoWrites = [];
  }
  setRawMode(value) { this.rawCalls.push(value); this.isRaw = value; return this; }
  isPaused() { return this.paused; }
  resume() { this.flowCalls.push('resume'); this.paused = false; return this; }
  pause() { this.flowCalls.push('pause'); this.paused = true; return this; }
  write(value) { this.echoWrites.push(value); return true; }
  send(value) { this.emit('data', Buffer.from(value)); }
}

class FakeAbortSignal extends EventEmitter {
  aborted = false;
  addEventListener(event, listener) { this.on(event, listener); }
  removeEventListener(event, listener) { this.removeListener(event, listener); }
  abort() { this.aborted = true; this.emit('abort'); }
}

const URI = 'nanoprocess:{"block":{"signature":"SYNTHETIC_INPUT_NOT_A_SIGNATURE"}}';
const events = ['data', 'end', 'close', 'error'];
function cleaned(tty, { raw = false, paused = true } = {}) {
  for (const event of events) assert.equal(tty.listenerCount(event), 0, event);
  assert.equal(tty.isRaw, raw);
  assert.equal(tty.isPaused(), paused);
  assert.deepEqual(tty.echoWrites, []);
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error.code === code &&
    !error.message.includes('SYNTHETIC_INPUT') && !error.message.includes('SECRET_SENTINEL'));
}

test('hidden input preserves exact URI without writing it and restores terminal state', async () => {
  const tty = new FakeTTY();
  const result = readSignedNaultURI({ input: tty });
  assert.equal(tty.isRaw, true);
  tty.send(URI.slice(0, 15));
  tty.send(URI.slice(15) + '\r\n');
  assert.equal(await result, URI);
  assert.deepEqual(tty.rawCalls, [true, false]);
  cleaned(tty);
});

test('backspace and delete edit hidden bytes, including at an empty buffer', async () => {
  const tty = new FakeTTY();
  const result = readSignedNaultURI({ input: tty });
  tty.send('\b\x7f' + URI + 'xy\b\x7f\n');
  assert.equal(await result, URI);
  cleaned(tty);
});

test('already-raw flowing terminals are left raw and flowing', async () => {
  const tty = new FakeTTY({ raw: true, paused: false });
  const result = readSignedNaultURI({ input: tty });
  tty.send(URI + '\n');
  assert.equal(await result, URI);
  assert.deepEqual(tty.rawCalls, []);
  cleaned(tty, { raw: true, paused: false });
});

test('Ctrl-C, Ctrl-D, EOF and close discard partial signed input and clean up', async () => {
  for (const mode of ['ctrl-c', 'ctrl-d', 'end', 'close']) {
    const tty = new FakeTTY();
    const result = readSignedNaultURI({ input: tty });
    const rejected = rejectsCode(result, mode === 'ctrl-c' ? 'CANCELED' : 'INPUT_ENDED');
    tty.send(URI);
    if (mode === 'ctrl-c') tty.send('\x03');
    else if (mode === 'ctrl-d') tty.send('\x04');
    else tty.emit(mode);
    await rejected;
    cleaned(tty);
  }
});

test('stream errors are sanitized and terminal state is restored', async () => {
  const tty = new FakeTTY();
  const result = readSignedNaultURI({ input: tty });
  const rejected = rejectsCode(result, 'INPUT_FAILED');
  tty.send(URI);
  tty.emit('error', new Error('SECRET_SENTINEL'));
  await rejected;
  cleaned(tty);
});

test('finite timeout removes readers and restores the TTY', async () => {
  const tty = new FakeTTY();
  await rejectsCode(readSignedNaultURI({ input: tty, timeoutMs: 1 }), 'TIMED_OUT');
  cleaned(tty);
});

test('AbortSignal cancels hidden input without exposing its reason', async () => {
  const tty = new FakeTTY();
  const signal = new FakeAbortSignal();
  const result = readSignedNaultURI({ input: tty, signal });
  const rejected = rejectsCode(result, 'CANCELED');
  tty.send(URI);
  signal.abort('SECRET_SENTINEL');
  await rejected;
  assert.equal(signal.listenerCount('abort'), 0);
  cleaned(tty);
  // The removed abort handler must not change state after completion.
  tty.send(URI + '\n');
  cleaned(tty);
});

test('pre-aborted input does not touch raw mode or add readers', async () => {
  const tty = new FakeTTY();
  const controller = new AbortController(); controller.abort();
  await rejectsCode(readSignedNaultURI({ input: tty, signal: controller.signal }), 'CANCELED');
  assert.deepEqual(tty.rawCalls, []);
  cleaned(tty);
});

test('invalid limits, non-TTY input and existing readers are refused before mode changes', async () => {
  for (const options of [{ timeoutMs: Infinity }, { timeoutMs: 60001 }, { timeoutMs: 0 },
    { maxBytes: 32769 }, { maxBytes: 0 }]) {
    const tty = new FakeTTY();
    await rejectsCode(readSignedNaultURI({ input: tty, ...options }), 'INVALID_LIMITS');
    assert.deepEqual(tty.rawCalls, []);
    cleaned(tty);
  }
  const nonTTY = new FakeTTY(); nonTTY.isTTY = false;
  await rejectsCode(readSignedNaultURI({ input: nonTTY }), 'TTY_REQUIRED');
  assert.deepEqual(nonTTY.rawCalls, []);
  const shared = new FakeTTY(); const otherReader = () => {};
  shared.on('data', otherReader);
  await rejectsCode(readSignedNaultURI({ input: shared }), 'TTY_IN_USE');
  assert.equal(shared.listeners('data')[0], otherReader);
  assert.deepEqual(shared.rawCalls, []);
  shared.removeListener('data', otherReader);
});

test('oversized, non-ASCII, escape-sequence and wrong-scheme input are discarded', async () => {
  for (const [data, code, maxBytes] of [
    [URI, 'INPUT_TOO_LONG', 12],
    ['nanoprocess:é\n', 'INVALID_ASCII'],
    ['\x1b[200~' + URI + '\n', 'INVALID_ASCII'],
    ['nanosign:{}\n', 'INVALID_URI'],
    ['nanoprocess:\n', 'INVALID_URI'],
  ]) {
    const tty = new FakeTTY();
    const result = readSignedNaultURI({ input: tty, ...(maxBytes ? { maxBytes } : {}) });
    const rejected = rejectsCode(result, code);
    tty.send(data);
    await rejected;
    cleaned(tty);
  }
});

test('setup and restoration failures remove every temporary listener without raw errors', async () => {
  const partialSetupFailure = new FakeTTY();
  partialSetupFailure.setRawMode = function (value) {
    this.isRaw = value;
    if (value) throw new Error('SECRET_SENTINEL');
    return this;
  };
  await rejectsCode(readSignedNaultURI({ input: partialSetupFailure }), 'TTY_SETUP_FAILED');
  cleaned(partialSetupFailure);
  const setupFailure = new FakeTTY();
  setupFailure.resume = () => { throw new Error('SECRET_SENTINEL'); };
  await rejectsCode(readSignedNaultURI({ input: setupFailure }), 'TTY_SETUP_FAILED');
  for (const event of events) assert.equal(setupFailure.listenerCount(event), 0);
  assert.equal(setupFailure.isRaw, false);
  const restoreFailure = new FakeTTY();
  restoreFailure.setRawMode = function (value) {
    if (value === false) throw new Error('SECRET_SENTINEL');
    this.isRaw = value; return this;
  };
  const result = readSignedNaultURI({ input: restoreFailure });
  const rejected = rejectsCode(result, 'TTY_RESTORE_FAILED');
  restoreFailure.send(URI + '\n');
  await rejected;
  for (const event of events) assert.equal(restoreFailure.listenerCount(event), 0);
  assert.deepEqual(restoreFailure.echoWrites, []);
});

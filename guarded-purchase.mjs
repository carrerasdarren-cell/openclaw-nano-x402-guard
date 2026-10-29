// All I/O and payment creation are injected. This module never loads a wallet/key.
const MAX_RAW = (1n << 128n) - 1n;
const MAX_QUOTE_BYTES = 32_768;
const MAX_REDIRECTS = 5;
const MAX_EXPIRY_REFRESHES = 2;
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const NANO_ADDRESS = /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export class PurchaseError extends Error {
  constructor(code) { super(code); this.name = 'PurchaseError'; this.code = code; }
}
const fail = code => { throw new PurchaseError(code); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const keysOnly = (v, keys, code) => {
  if (!plain(v) || Object.keys(v).some(k => FORBIDDEN.has(k) || !keys.includes(k))) fail(code);
};
function validateSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.aborted !== 'boolean'
      || typeof signal.throwIfAborted !== 'function'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function') fail('INVALID_ABORT_SIGNAL');
}
function checkAbort(signal) {
  if (signal === undefined) return;
  try {
    if (signal.aborted) fail('ABORTED');
    signal.throwIfAborted();
  } catch { fail('ABORTED'); } // Never expose the possibly-sensitive abort reason.
}
function rawAmount(value, code) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,38}$/.test(value)) fail(code);
  const n = BigInt(value);
  if (n > MAX_RAW) fail(code);
  return n;
}
function safeURL(value) {
  if (typeof value !== 'string') fail('INVALID_URL');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('INVALID_URL');
  return url;
}
function decodeBase64JSON(value, code) {
  if (typeof value !== 'string' || !value || value.length > MAX_QUOTE_BYTES * 2
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(code);
  let bytes, decoded;
  try {
    bytes = Buffer.from(value, 'base64');
    if (bytes.length > MAX_QUOTE_BYTES || bytes.toString('base64') !== value) fail(code);
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail(code); }
  return decoded;
}
function freezeResource(resource, url) {
  keysOnly(resource, ['url', 'description', 'mimeType', 'serviceName', 'tags', 'iconUrl'], 'MALFORMED_RESOURCE');
  if (resource.url !== url) fail('RESOURCE_URL_MISMATCH');
  const copy = { url };
  for (const k of ['description', 'mimeType', 'serviceName', 'iconUrl']) {
    if (resource[k] !== undefined) {
      if (typeof resource[k] !== 'string' || resource[k].length > 2048) fail('MALFORMED_RESOURCE');
      copy[k] = resource[k];
    }
  }
  if (copy.serviceName !== undefined && !/^[\x20-\x7e]{1,32}$/.test(copy.serviceName)) fail('MALFORMED_RESOURCE');
  if (resource.tags !== undefined) {
    if (!Array.isArray(resource.tags) || resource.tags.length > 5
        || resource.tags.some(x => typeof x !== 'string' || !/^[\x20-\x7e]{1,32}$/.test(x))) fail('MALFORMED_RESOURCE');
    copy.tags = Object.freeze([...resource.tags]);
  }
  return Object.freeze(copy);
}
function validateQuote(required, url, allowedPayTo, fetchedAt) {
  keysOnly(required, ['x402Version', 'resource', 'accepts', 'error', 'extensions'], 'MALFORMED_QUOTE');
  if (required.x402Version !== 2 || !Array.isArray(required.accepts) || required.accepts.length !== 1) fail('AMBIGUOUS_QUOTE');
  const resource = freezeResource(required.resource, url);
  const a = required.accepts[0];
  keysOnly(a, ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra'], 'MALFORMED_QUOTE');
  if (a.scheme !== 'exact' || a.network !== 'nano:mainnet' || a.asset !== 'XNO') fail('UNSUPPORTED_PAYMENT');
  if (typeof a.payTo !== 'string' || !NANO_ADDRESS.test(a.payTo)) fail('INVALID_PAY_TO');
  if (!allowedPayTo.has(a.payTo)) fail('PAY_TO_NOT_ALLOWED');
  const amount = rawAmount(a.amount, 'INVALID_AMOUNT');
  if (typeof a.maxTimeoutSeconds !== 'number' || !Number.isFinite(a.maxTimeoutSeconds)
      || a.maxTimeoutSeconds <= 0 || a.maxTimeoutSeconds * 1000 > Number.MAX_SAFE_INTEGER - fetchedAt) fail('INVALID_TIMEOUT');
  const accepted = { scheme: a.scheme, network: a.network, asset: a.asset,
    amount: a.amount, payTo: a.payTo, maxTimeoutSeconds: a.maxTimeoutSeconds };
  if (a.extra !== undefined) {
    keysOnly(a.extra, ['work', 'workOptional', 'workThreshold', 'session'], 'UNSUPPORTED_QUOTE_EXTRA');
    if (a.extra.work !== undefined && !['optional', 'required'].includes(a.extra.work)) fail('MALFORMED_QUOTE');
    if (a.extra.workOptional !== undefined && typeof a.extra.workOptional !== 'boolean') fail('MALFORMED_QUOTE');
    if (a.extra.work !== undefined && a.extra.workOptional !== undefined
        && a.extra.workOptional !== (a.extra.work === 'optional')) fail('MALFORMED_QUOTE');
    if (a.extra.workThreshold !== undefined && (typeof a.extra.workThreshold !== 'string'
        || !/^[0-9a-fA-F]{16}$/.test(a.extra.workThreshold))) fail('MALFORMED_QUOTE');
    // Current owner challenge uses a 32-lowercase-hex replay-binding session.
    // Echo the validated value exactly; never create, drop or reuse a session.
    if (a.extra.session !== undefined && (typeof a.extra.session !== 'string'
        || !/^[0-9a-f]{32}$/.test(a.extra.session))) fail('MALFORMED_QUOTE');
    accepted.extra = Object.freeze({ ...a.extra });
  }
  return { required: Object.freeze({ x402Version: 2, resource,
    accepts: Object.freeze([Object.freeze(accepted)]) }), amount,
    fetchedAt, expiresAt: fetchedAt + a.maxTimeoutSeconds * 1000 };
}
function cleanBody(value, paymentHeader, depth = 0) {
  if (depth > 20) return '[redacted: depth limit]';
  if (typeof value === 'string') {
    let s = paymentHeader ? value.split(paymentHeader).join('[redacted payment]') : value;
    return s.replace(/\b[0-9a-fA-F]{128}\b/g, '[redacted signature]');
  }
  if (Array.isArray(value)) return value.map(v => cleanBody(v, paymentHeader, depth + 1));
  if (plain(value)) {
    const out = Object.create(null);
    for (const [k,v] of Object.entries(value)) {
      if (FORBIDDEN.has(k)) continue;
      out[k] = /^(payload|block|signature|payment[-_]?signature|private[-_]?key|seed|secret)$/i.test(k)
        ? '[redacted]' : cleanBody(v, paymentHeader, depth + 1);
    }
    return out;
  }
  return value;
}
async function responseBody(response, paymentHeader, signal) {
  let text;
  try { text = await response.text(); }
  catch { checkAbort(signal); fail('RESPONSE_BODY_FAILED'); }
  checkAbort(signal);
  let body = text;
  try { body = JSON.parse(text); } catch { /* A non-JSON resource is valid. */ }
  return cleanBody(body, paymentHeader);
}

/**
 * spentRaw is conservative reserved exposure, not confirmed chain settlement.
 * paid means a payment-bearing HTTP request was sent, not that it settled.
 * requestId is lifetime-idempotent within this instance, including failures.
 * One instance must own a paying account; cross-process wallet locks belong to
 * the injected signer. Bodies are immutable strings (or absent), GET/POST only.
 * Address syntax is checked here; the injected official client also validates
 * the Nano checksum while preparing the block.
 */
export function createGuardedPurchase({ allowPayTo, allowedOrigins, maxPerCallRaw,
  maxTotalRaw, createPaymentPayload, fetchImpl, now = Date.now }) {
  const payees = new Set(allowPayTo);
  if (!payees.size || [...payees].some(x => typeof x !== 'string' || !NANO_ADDRESS.test(x))) fail('INVALID_PAY_TO_CONFIG');
  const origins = new Set(allowedOrigins);
  if (!origins.size || [...origins].some(x => safeURL(x).origin !== x)) fail('INVALID_ORIGIN_CONFIG');
  const perCall = rawAmount(maxPerCallRaw, 'INVALID_CAP');
  const total = rawAmount(maxTotalRaw, 'INVALID_CAP');
  if (typeof createPaymentPayload !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function') fail('INVALID_ADAPTER');
  let reserved = 0n;
  let queue = Promise.resolve();
  const requests = new Map();
  function time() {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) fail('INVALID_CLOCK');
    return t;
  }
  async function call(url, options) {
    let response;
    checkAbort(options.signal);
    try { response = await fetchImpl(url, options); }
    catch { checkAbort(options.signal); fail('TRANSPORT_FAILED'); }
    checkAbort(options.signal);
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599
        || typeof response.headers?.get !== 'function') fail('INVALID_RESPONSE');
    if (response.url && response.url !== url) fail('UNEXPECTED_RESPONSE_URL');
    return response;
  }
  async function probe(input) {
    let url = input.url;
    const origin = new URL(url).origin;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const fetchedAt = time();
      const response = await call(url, { method: input.method, body: input.body,
        redirect: 'manual', signal: input.signal });
      if (REDIRECT.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) fail('MALFORMED_REDIRECT');
        let next;
        try { next = safeURL(new URL(location, url).href); } catch { fail('UNSAFE_REDIRECT'); }
        // Even another configured origin must never receive this request/body.
        if (next.origin !== origin) fail('CROSS_ORIGIN_REDIRECT');
        if (hop === MAX_REDIRECTS) fail('TOO_MANY_REDIRECTS');
        url = next.href;
        continue;
      }
      if (response.status !== 402) return { response, url };
      const header = response.headers.get('payment-required');
      let required;
      if (header !== null) required = decodeBase64JSON(header, 'MALFORMED_PAYMENT_HEADER');
      else {
        let body;
        try {
          const text = await response.text();
          checkAbort(input.signal);
          if (Buffer.byteLength(text, 'utf8') > MAX_QUOTE_BYTES) fail('MALFORMED_QUOTE_BODY');
          body = JSON.parse(text);
        } catch { checkAbort(input.signal); fail('MALFORMED_QUOTE_BODY'); }
        if (!plain(body) || !plain(body.x402)) fail('MALFORMED_QUOTE_BODY');
        required = body.x402;
      }
      return { quote: validateQuote(required, url, payees, fetchedAt), url };
    }
    fail('TOO_MANY_REDIRECTS');
  }
  async function execute(input) {
    checkAbort(input.signal);
    let found, signTime;
    for (let refresh = 0; refresh <= MAX_EXPIRY_REFRESHES; refresh++) {
      found = await probe(input);
      checkAbort(input.signal);
      if (!found.quote) return { status: found.response.status,
        body: await responseBody(found.response, undefined, input.signal), paid: false };
      if (found.quote.amount > perCall) fail('PER_CALL_CAP');
      if (reserved + found.quote.amount > total) fail('TOTAL_CAP');
      signTime = time();
      if (signTime < found.quote.fetchedAt) fail('CLOCK_REVERSED');
      if (signTime < found.quote.expiresAt) break;
      if (refresh === MAX_EXPIRY_REFRESHES) fail('QUOTE_EXPIRED');
    }
    const { quote, url } = found;
    // No await between the final expiry/cap check, reservation, and signer call.
    checkAbort(input.signal);
    reserved += quote.amount;
    let payload;
    checkAbort(input.signal);
    try { payload = await createPaymentPayload(quote.required); }
    catch { checkAbort(input.signal); fail('PAYMENT_PREPARATION_FAILED'); }
    // The signer may already have produced a spendable block. Cancellation
    // prevents its transmission but never releases its reserved exposure.
    checkAbort(input.signal);
    // A slow signer may already have signed: retain reservation, never send stale.
    const afterSign = time();
    if (afterSign < signTime || afterSign >= quote.expiresAt) fail('QUOTE_EXPIRED_DURING_PREPARATION');
    let paymentHeader;
    try {
      if (!plain(payload)) fail('INVALID_PAYMENT_PAYLOAD');
      paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');
      if (paymentHeader.length > 131_072) fail('INVALID_PAYMENT_PAYLOAD');
    } catch { fail('INVALID_PAYMENT_PAYLOAD'); }
    const response = await call(url, { method: input.method, body: input.body,
      redirect: 'manual', signal: input.signal, headers: { 'PAYMENT-SIGNATURE': paymentHeader } });
    // Deliberately no retry/follow-up for 3xx, 402, 4xx, 5xx or lost responses.
    const result = { status: response.status,
      body: await responseBody(response, paymentHeader, input.signal), paid: true };
    const settle = response.headers.get('payment-response');
    if (settle) {
      try {
        const info = decodeBase64JSON(settle, 'INVALID_SETTLEMENT');
        if (info.success === true && info.network === 'nano:mainnet'
            && typeof info.transaction === 'string' && /^[0-9a-fA-F]{64}$/.test(info.transaction)) result.transaction = info.transaction;
      } catch { /* Untrusted settlement metadata is never payment proof. */ }
    }
    return result;
  }
  function purchase({ requestId, url, method = 'GET', body, signal } = {}) {
    let input, identity;
    try {
      if (typeof requestId !== 'string' || !requestId || requestId.length > 256) fail('INVALID_REQUEST_ID');
      const target = safeURL(url);
      if (!origins.has(target.origin)) fail('ORIGIN_NOT_ALLOWED');
      if (typeof method !== 'string' || !['GET', 'POST'].includes(method.toUpperCase())) fail('INVALID_METHOD');
      method = method.toUpperCase();
      if (body === null) body = undefined;
      if (body !== undefined && typeof body !== 'string') fail('INVALID_BODY');
      if (method === 'GET' && body !== undefined) fail('GET_BODY_NOT_ALLOWED');
      validateSignal(signal);
      input = Object.freeze({ url: target.href, method, body, signal });
      identity = JSON.stringify([input.url, method, body ?? null]);
      const prior = requests.get(requestId);
      if (prior) {
        if (prior.identity !== identity) fail('REQUEST_ID_REBOUND');
        return prior.promise;
      }
    } catch (error) {
      return Promise.reject(error instanceof PurchaseError ? error : new PurchaseError('INVALID_REQUEST'));
    }
    // Enqueue the entire operation, not only the cap update/signing segment.
    const promise = queue.then(() => execute(input));
    queue = promise.catch(() => {});
    requests.set(requestId, { identity, promise });
    return promise;
  }
  return Object.freeze({ purchase, get spentRaw() { return reserved.toString(); } });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedPurchase } from './guarded-purchase.mjs';

const URL_A = 'https://seller.example/resource';
const PAY_TO = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const OTHER_PAY_TO = 'nano_3111111111111111111111111111111111111111111111111111hifc8npp';
const encode = x => Buffer.from(JSON.stringify(x)).toString('base64');
const required = (accept = {}, resource = {}) => ({ x402Version: 2,
  resource: { url: URL_A, ...resource }, accepts: [{ scheme: 'exact', network: 'nano:mainnet',
    asset: 'XNO', amount: '5', payTo: PAY_TO, maxTimeoutSeconds: 60, ...accept }] });
const quote = (value = required(), bodyMode = false) => new Response(
  bodyMode ? JSON.stringify({ x402: value }) : '', { status: 402,
    headers: bodyMode ? { 'content-type': 'application/json' } : { 'payment-required': encode(value) } });
const ok = () => new Response('{"answer":42}', { status: 200 });
function harness({ responses, signer, ...options } = {}) {
  const calls = [], signed = [];
  const remaining = responses ?? [quote(), ok()];
  const purchase = createGuardedPurchase({ allowPayTo: [PAY_TO],
    allowedOrigins: ['https://seller.example'], maxPerCallRaw: '10', maxTotalRaw: '20',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const response = remaining.shift();
      if (typeof response === 'function') return response(url, init);
      if (response instanceof Error) throw response;
      if (!response) throw Error('unexpected mock request');
      return response;
    },
    createPaymentPayload: async value => {
      signed.push(value);
      return signer ? signer(value) : { x402Version: 2, resource: value.resource,
        accepted: value.accepts[0], payload: { block: { signature: 'a'.repeat(128) } } };
    }, ...options });
  return { ...purchase, get spentRaw() { return purchase.spentRaw; }, calls, signed };
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}

test('exact quote is handed to signer once; paid body and settlement are sanitized', async () => {
  let exposed;
  const h = harness({ responses: [quote(), (url, init) => {
    exposed = init.headers['PAYMENT-SIGNATURE'];
    return new Response(JSON.stringify({ answer: 42, signature: 'a'.repeat(128),
      payload: { block: 'do not expose' }, echo: exposed }), { status: 200,
      headers: { 'payment-response': encode({ success: true, network: 'nano:mainnet', transaction: 'b'.repeat(64) }) } });
  }] });
  const r = await h.purchase({ requestId: 'one', url: URL_A });
  assert.equal(h.signed.length, 1);
  assert.equal(h.signed[0].accepts.length, 1);
  assert.deepEqual(h.signed[0].accepts[0], required().accepts[0]);
  assert.equal(h.calls[1].init.redirect, 'manual');
  assert.equal(r.transaction, 'b'.repeat(64));
  assert.equal(r.body.answer, 42);
  assert.equal(r.body.signature, '[redacted]');
  assert.equal(r.body.payload, '[redacted]');
  assert.equal(r.body.echo, '[redacted payment]');
  assert.equal(h.spentRaw, '5');
  assert.ok(!JSON.stringify(r).includes(exposed));
});

test('body.x402 challenge and free resource work without an automatic payment retry', async () => {
  const paid = harness({ responses: [quote(required(), true), ok()] });
  assert.equal((await paid.purchase({ requestId: 'body', url: URL_A })).paid, true);
  const free = harness({ responses: [ok()] });
  assert.equal((await free.purchase({ requestId: 'free', url: URL_A })).paid, false);
  assert.equal(free.signed.length, 0);
});

test('documented work metadata and synthetic replay session are preserved exactly for the signer', async () => {
  const extra = { work: 'optional', workOptional: true,
    workThreshold: 'fffffff800000000', session: '0123456789abcdef0123456789abcdef' };
  const h = harness({ responses: [quote(required({ extra })), ok()] });
  await h.purchase({ requestId: 'session', url: URL_A });
  assert.deepEqual(h.signed[0].accepts[0].extra, extra);
  assert.ok(Object.isFrozen(h.signed[0].accepts[0].extra));
  const sent = JSON.parse(Buffer.from(h.calls[1].init.headers['PAYMENT-SIGNATURE'], 'base64').toString('utf8'));
  assert.deepEqual(sent.accepted.extra, extra);
});

for (const [label, change, code] of [
  ['wrong network', { network: 'eip155:8453' }, 'UNSUPPORTED_PAYMENT'],
  ['wrong scheme', { scheme: 'upto' }, 'UNSUPPORTED_PAYMENT'],
  ['wrong asset', { asset: 'USDC' }, 'UNSUPPORTED_PAYMENT'],
  ['wrong payee', { payTo: OTHER_PAY_TO }, 'PAY_TO_NOT_ALLOWED'],
  ['invalid address format', { payTo: 'nano_invalid' }, 'INVALID_PAY_TO'],
  ['zero', { amount: '0' }, 'INVALID_AMOUNT'],
  ['decimal', { amount: '0.1' }, 'INVALID_AMOUNT'],
  ['number amount', { amount: 5 }, 'INVALID_AMOUNT'],
  ['leading zero', { amount: '05' }, 'INVALID_AMOUNT'],
  ['uint128 overflow', { amount: (1n << 128n).toString() }, 'INVALID_AMOUNT'],
  ['invalid expiry', { maxTimeoutSeconds: 0 }, 'INVALID_TIMEOUT'],
  ['infinite expiry', { maxTimeoutSeconds: Infinity }, 'INVALID_TIMEOUT'],
  ['extra payment field', { signer: 'untrusted' }, 'MALFORMED_QUOTE'],
  ['invalid workOptional', { extra: { workOptional: 'yes' } }, 'MALFORMED_QUOTE'],
  ['unknown extra field', { extra: { paymentHook: 'untrusted' } }, 'UNSUPPORTED_QUOTE_EXTRA'],
  ['invalid work kind', { extra: { work: 'free-for-all' } }, 'MALFORMED_QUOTE'],
  ['conflicting work metadata', { extra: { work: 'required', workOptional: true } }, 'MALFORMED_QUOTE'],
  ['invalid work threshold', { extra: { workThreshold: '0x1234' } }, 'MALFORMED_QUOTE'],
  ['invalid session type', { extra: { session: {} } }, 'MALFORMED_QUOTE'],
  ['invalid session length', { extra: { session: 'a'.repeat(4096) } }, 'MALFORMED_QUOTE'],
]) test(`refuses ${label} before signing or paid fetch`, async () => {
  const h = harness({ responses: [quote(required(change))] });
  await rejectsCode(h.purchase({ requestId: label, url: URL_A }), code);
  assert.equal(h.signed.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.spentRaw, '0');
});

test('rejects multiple offers, wrong bound resource, malformed base64/body', async () => {
  const multiple = required(); multiple.accepts.push(required().accepts[0]);
  for (const [response, code] of [
    [quote(multiple), 'AMBIGUOUS_QUOTE'],
    [quote(required({}, { url: 'https://seller.example/other' })), 'RESOURCE_URL_MISMATCH'],
    [new Response('', { status: 402, headers: { 'payment-required': '%%%garbage' } }), 'MALFORMED_PAYMENT_HEADER'],
    [new Response('{"x402":null}', { status: 402 }), 'MALFORMED_QUOTE_BODY'],
  ]) {
    const h = harness({ responses: [response] });
    await rejectsCode(h.purchase({ requestId: code, url: URL_A }), code);
    assert.equal(h.signed.length, 0);
  }
});

test('only HTTPS configured origins; cross-origin unsigned redirect is not requested, even if configured', async () => {
  for (const url of ['http://seller.example/resource', 'https://user:pass@seller.example/resource', `${URL_A}#fragment`, 'https://other.example/resource']) {
    const h = harness(); await assert.rejects(h.purchase({ requestId: url, url }));
    assert.equal(h.calls.length, 0);
  }
  const h = harness({ allowedOrigins: ['https://seller.example', 'https://other.example'],
    responses: [new Response('', { status: 307, headers: { location: 'https://other.example/take-body' } })] });
  await rejectsCode(h.purchase({ requestId: 'redirect', url: URL_A, method: 'POST', body: 'bound-body' }), 'CROSS_ORIGIN_REDIRECT');
  assert.equal(h.calls.length, 1); assert.equal(h.signed.length, 0);
});

test('same-origin unsigned redirect binds final resource and preserves POST/body', async () => {
  const final = 'https://seller.example/final';
  const h = harness({ responses: [new Response('', { status: 307, headers: { location: '/final' } }), quote(required({}, { url: final })), ok()] });
  await h.purchase({ requestId: 'post', url: URL_A, method: 'POST', body: '{"value":1}' });
  assert.deepEqual(h.calls.map(x => x.url), [URL_A, final, final]);
  assert.ok(h.calls.every(x => x.init.method === 'POST' && x.init.body === '{"value":1}' && x.init.redirect === 'manual'));
});

test('paid redirect/non-2xx is returned once and never followed/retried', async () => {
  for (const status of [307, 400, 402, 500]) {
    const h = harness({ responses: [quote(), new Response('refused', { status, headers: { location: 'https://other.example/' } })] });
    const r = await h.purchase({ requestId: String(status), url: URL_A });
    assert.equal(r.status, status); assert.equal(r.paid, true);
    assert.equal(h.calls.length, 2); assert.equal(h.signed.length, 1); assert.equal(h.spentRaw, '5');
  }
});

test('per-call and cumulative limits checked before signing', async () => {
  const tooBig = harness({ maxPerCallRaw: '4', responses: [quote()] });
  await rejectsCode(tooBig.purchase({ requestId: 'large', url: URL_A }), 'PER_CALL_CAP');
  assert.equal(tooBig.signed.length, 0);
  const h = harness({ maxTotalRaw: '5', responses: [quote(), ok(), quote()] });
  await h.purchase({ requestId: 'first', url: URL_A });
  await rejectsCode(h.purchase({ requestId: 'second', url: URL_A }), 'TOTAL_CAP');
  assert.equal(h.signed.length, 1); assert.equal(h.spentRaw, '5');
});

test('duplicate request reuses the exact promise and enforces immutable URL/method/body identity', async () => {
  const h = harness(); const args = { requestId: 'same', url: URL_A };
  const first = h.purchase(args); assert.equal(h.purchase(args), first);
  await first; assert.equal(h.purchase(args), first);
  for (const change of [{ url: `${URL_A}?different` }, { method: 'POST' }, { method: 'POST', body: 'new' }]) {
    await rejectsCode(h.purchase({ ...args, ...change }), 'REQUEST_ID_REBOUND');
  }
  assert.equal(h.signed.length, 1); assert.equal(h.calls.length, 2);
});

test('a POST requestId cannot be rebound to another body, even before the first request resolves', async () => {
  const h = harness();
  const first = h.purchase({ requestId: 'post-body', url: URL_A, method: 'POST', body: '{"a":1}' });
  await rejectsCode(h.purchase({ requestId: 'post-body', url: URL_A, method: 'POST', body: '{"a":2}' }), 'REQUEST_ID_REBOUND');
  await first;
  assert.equal(h.signed.length, 1);
  assert.ok(h.calls.every(x => x.init.body === '{"a":1}'));
});

test('all payment attempts serialize; concurrent requests cannot race cumulative caps', async () => {
  let unblock; const blocked = new Promise(resolve => { unblock = resolve; });
  const h = harness({ maxTotalRaw: '5', responses: [quote(), ok(), quote()], signer: async value => {
    await blocked; return { accepted: value.accepts[0], payload: { block: {} } };
  } });
  const first = h.purchase({ requestId: 'a', url: URL_A });
  const second = h.purchase({ requestId: 'b', url: URL_A });
  // Let fetch + quote parsing progress without a wall-clock sleep.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.signed.length, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.spentRaw, '5'); unblock(); await first;
  await rejectsCode(second, 'TOTAL_CAP'); assert.equal(h.signed.length, 1);
});

test('failed signer and ambiguous lost response retain exposure and never re-sign the request', async () => {
  for (const mode of ['signer', 'transport']) {
    const h = harness({ responses: [quote(), new Error('secret transport detail')],
      ...(mode === 'signer' ? { signer: async () => { throw Error('private key SECRET'); } } : {}) });
    const args = { requestId: mode, url: URL_A }; const first = h.purchase(args);
    await rejectsCode(first, mode === 'signer' ? 'PAYMENT_PREPARATION_FAILED' : 'TRANSPORT_FAILED');
    assert.equal(h.purchase(args), first); assert.equal(h.spentRaw, '5'); assert.equal(h.signed.length, 1);
    await assert.rejects(first, error => !error.message.includes('SECRET') && !error.message.includes('secret transport'));
  }
});

test('stale unsigned quote is refetched within a finite bound; new exact amount is used', async () => {
  let time = 1000;
  const h = harness({ now: () => time, responses: [() => { time = 3000; return quote(required({ maxTimeoutSeconds: 1 })); }, quote(required({ amount: '6' })), ok()] });
  await h.purchase({ requestId: 'expiry', url: URL_A });
  assert.equal(h.calls.length, 3); assert.equal(h.signed[0].accepts[0].amount, '6'); assert.equal(h.spentRaw, '6');
  const alwaysStale = harness({ now: () => time, responses: Array.from({ length: 3 }, () => () => { time += 2000; return quote(required({ maxTimeoutSeconds: 1 })); }) });
  await rejectsCode(alwaysStale.purchase({ requestId: 'stale', url: URL_A }), 'QUOTE_EXPIRED');
  assert.equal(alwaysStale.calls.length, 3); assert.equal(alwaysStale.signed.length, 0);
});

test('slow signer cannot cause expired signed payload to be sent; reservation remains', async () => {
  let time = 1000;
  const h = harness({ now: () => time, responses: [quote(required({ maxTimeoutSeconds: 1 }))], signer: async () => { time = 2000; return { payload: { block: {} } }; } });
  await rejectsCode(h.purchase({ requestId: 'slow', url: URL_A }), 'QUOTE_EXPIRED_DURING_PREPARATION');
  assert.equal(h.calls.length, 1); assert.equal(h.signed.length, 1); assert.equal(h.spentRaw, '5');
});

test('invalid method/mutable object body is refused before network I/O', async () => {
  const h = harness();
  await rejectsCode(h.purchase({ requestId: 'object', url: URL_A, method: 'POST', body: { value: 1 } }), 'INVALID_BODY');
  await rejectsCode(h.purchase({ requestId: 'delete', url: URL_A, method: 'DELETE' }), 'INVALID_METHOD');
  await rejectsCode(h.purchase({ requestId: 'get-body', url: URL_A, body: 'not allowed' }), 'GET_BODY_NOT_ALLOWED');
  assert.equal(h.calls.length, 0);
});

test('invalid abort signal is refused before network; pre-aborted request never signs', async () => {
  const h = harness();
  await rejectsCode(h.purchase({ requestId: 'bad-signal', url: URL_A, signal: { aborted: false } }), 'INVALID_ABORT_SIGNAL');
  const controller = new AbortController(); controller.abort('private operator reason');
  await rejectsCode(h.purchase({ requestId: 'already-aborted', url: URL_A, signal: controller.signal }), 'ABORTED');
  assert.equal(h.calls.length, 0); assert.equal(h.signed.length, 0); assert.equal(h.spentRaw, '0');
});

test('request aborted while queued does not fetch or sign when its turn arrives', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ signer: async value => {
    await blocked; return { accepted: value.accepts[0], payload: { block: {} } };
  } });
  const first = h.purchase({ requestId: 'queue-first', url: URL_A });
  const controller = new AbortController();
  const second = h.purchase({ requestId: 'queue-aborted', url: URL_A, signal: controller.signal });
  const secondRejected = rejectsCode(second, 'ABORTED');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort('secret cancellation detail'); release(); await first; await secondRejected;
  assert.equal(h.calls.length, 2); assert.equal(h.signed.length, 1); assert.equal(h.spentRaw, '5');
  // The original canceled request remains idempotently failed with a fresh signal.
  assert.equal(h.purchase({ requestId: 'queue-aborted', url: URL_A, signal: new AbortController().signal }), second);
});

test('abort during a pending 402 response prevents signing even if fetch ignores cancellation', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const h = harness({ responses: [async (url, init) => {
    assert.equal(init.signal, controller.signal);
    await blocked; return quote();
  }] });
  const pending = h.purchase({ requestId: 'quote-abort', url: URL_A, signal: controller.signal });
  const rejected = rejectsCode(pending, 'ABORTED');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort('do not leak this reason'); release(); await rejected;
  assert.equal(h.calls.length, 1); assert.equal(h.signed.length, 0); assert.equal(h.spentRaw, '0');
  await assert.rejects(pending, error => error.message === 'ABORTED');
});

test('abort during signer preparation retains exposure and never sends or signs again', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const h = harness({ responses: [quote()], signer: async value => {
    await blocked; return { accepted: value.accepts[0], payload: { block: {} } };
  } });
  const args = { requestId: 'sign-abort', url: URL_A, signal: controller.signal };
  const pending = h.purchase(args); const rejected = rejectsCode(pending, 'ABORTED');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.spentRaw, '5'); assert.equal(h.signed.length, 1);
  controller.abort('operator canceled'); release(); await rejected;
  assert.equal(h.calls.length, 1); assert.equal(h.signed.length, 1); assert.equal(h.spentRaw, '5');
  assert.equal(h.purchase({ ...args, signal: new AbortController().signal }), pending);
});

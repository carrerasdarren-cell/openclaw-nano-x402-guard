import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createModelFreeExample, runModelFreeExample, OWNER_ORIGIN, OWNER_PAY_TO, ModelFreeExampleError } from './examples/model-free.mjs';
import { createOfflineTransport, offlineSignerStats, EXAMPLE_CAP_RAW, OFFLINE_URL } from './examples/offline-signer.fixture.mjs';

// Existing unshipped public dummy block fixture. Live-mode tests inject their
// transport in memory: there is no RPC, provider, wallet or real HTTP request.
const TEST_SIGNER = fileURLToPath(new URL('./mock-helper.fixture.mjs', import.meta.url));
const REQUEST_URL = OWNER_ORIGIN + '/v1/hash';
const liveArgs = ['--live', '--url', REQUEST_URL, '--method', 'POST', '--body', 'synthetic test body'];
function liveTransport({ amount = EXAMPLE_CAP_RAW, payTo = OWNER_PAY_TO, status = 200, lost = false } = {}) {
  const calls = [];
  const required = { x402Version: 2, resource: { url: REQUEST_URL }, accepts: [{
    scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', amount, payTo,
    maxTimeoutSeconds: 60, extra: { workOptional: true, session: '1'.repeat(32) },
  }] };
  async function fetchImpl(url, options) {
    assert.equal(url, REQUEST_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.body, 'synthetic test body');
    assert.equal(options.redirect, 'manual');
    const header = new Headers(options.headers).get('payment-signature');
    calls.push({ paid: Boolean(header), payload: header ? JSON.parse(Buffer.from(header, 'base64').toString()) : null });
    if (!header) return new Response(JSON.stringify({ x402: required }), { status: 402 });
    if (lost) throw new Error('secret-error-sentinel-must-not-be-exposed');
    return new Response(JSON.stringify({ value: 'synthetic result' }), { status });
  }
  return { calls, fetchImpl };
}

const refuses = (code) => (error) => error instanceof ModelFreeExampleError && error.code === code;

test('default offline runs the actual registered native tool and official scheme without reading environment or network', async () => {
  const env = new Proxy({}, { get() { throw new Error('Ambient environment must not be read'); } });
  const before = offlineSignerStats();
  const savedFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async () => { network++; throw new Error('No network in default mode'); };
  try {
    const result = await runModelFreeExample({ env });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'offline');
    assert.equal(result.frameworkPath, 'native-sdk-registration');
    assert.equal(result.agentLoop, false);
    assert.equal(result.status, 200);
    assert.equal(result.paidRequestSent, true); // Synthetic transport exposure only.
    assert.deepEqual(result.body, { resource: 'offline-fixture-result', synthetic: true });
    assert.equal('reportedTransaction' in result, false);
    assert.equal(network, 0);
    assert.deepEqual(offlineSignerStats(), { helperLoads: before.helperLoads + 1, signedBlocks: before.signedBlocks + 1 });
  } finally { globalThis.fetch = savedFetch; }
});

test('explicit offline ignores signer/key/model-looking environment and makes one synthetic challenge/payment exchange', async () => {
  const f = createOfflineTransport();
  const result = await runModelFreeExample({ argv: ['--offline'],
    env: { NANO_SIGNER_MODULE: '/must/not/load.mjs', NANO_ACCOUNT_PRIVATE_KEY: 'not-a-key', OPENAI_API_KEY: 'not-a-model-key' },
    fetchImpl: f.fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(f.observations, { unsignedRequests: 1, paymentRequests: 1 });
  assert.equal(JSON.stringify(result).includes('not-a-key'), false);
  assert.equal(JSON.stringify(result).includes('not-a-model-key'), false);
});

test('explicit live mode injects an absolute environment signer through unchanged lazy client and SDK-native tool', async () => {
  const f = liveTransport();
  const example = createModelFreeExample({ argv: liveArgs, env: { NANO_SIGNER_MODULE: TEST_SIGNER }, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 0); // No transport/signing during registration.
  const result = await example.invoke();
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'live');
  assert.equal(result.agentLoop, false);
  assert.equal(f.calls.length, 2);
  const payload = f.calls[1].payload;
  assert.equal(payload.accepted.amount, EXAMPLE_CAP_RAW);
  assert.equal(payload.accepted.payTo, OWNER_PAY_TO);
  assert.equal(payload.payload.block.signature, 'B'.repeat(128)); // Existing injected fixture's marker.
  assert.equal(payload.resource.url, REQUEST_URL);
});

test('fixed 0.001 XNO per-call/total caps refuse a larger quote before the operator module loads', async () => {
  const f = liveTransport({ amount: (BigInt(EXAMPLE_CAP_RAW) + 1n).toString() });
  const example = createModelFreeExample({ argv: liveArgs,
    env: { NANO_SIGNER_MODULE: '/nonexistent/signer-must-not-load.mjs' }, fetchImpl: f.fetchImpl });
  const result = await example.invoke();
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls.map((call) => call.paid), [false]);
  await assert.rejects(example.invoke(), refuses('ONE_SHOT'));
  assert.equal(f.calls.length, 1);
});

test('a completed example cannot make a second purchase or reset its one-call budget', async () => {
  const f = createOfflineTransport();
  const example = createModelFreeExample({ fetchImpl: f.fetchImpl });
  assert.equal((await example.invoke()).ok, true);
  await assert.rejects(example.invoke(), refuses('ONE_SHOT'));
  assert.deepEqual(f.observations, { unsignedRequests: 1, paymentRequests: 1 });
});

test('a wrong recipient is refused before any environment signer is loaded', async () => {
  const f = liveTransport({ payTo: 'nano_1111111111111111111111111111111111111111111111111111hifc8npp' });
  const result = await runModelFreeExample({ argv: liveArgs,
    env: { NANO_SIGNER_MODULE: '/nonexistent/must-not-import.mjs' }, fetchImpl: f.fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls.map((call) => call.paid), [false]);
});

test('paid 302/402/500 responses produce no second signature, HTTP retry or redirect follow', async () => {
  for (const status of [302, 402, 500]) {
    const f = liveTransport({ status });
    const result = await runModelFreeExample({ argv: liveArgs, env: { NANO_SIGNER_MODULE: TEST_SIGNER }, fetchImpl: f.fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.paidRequestSent, true);
    assert.deepEqual(f.calls.map((call) => call.paid), [false, true]);
  }
});

test('ambiguous lost paid response is sanitized, consumes the attempt and is never retried', async () => {
  const f = liveTransport({ lost: true });
  const example = createModelFreeExample({ argv: liveArgs, env: { NANO_SIGNER_MODULE: TEST_SIGNER }, fetchImpl: f.fetchImpl });
  const result = await example.invoke();
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('secret-error-sentinel'), false);
  assert.equal('reportedTransaction' in result, false);
  await assert.rejects(example.invoke(), refuses('ONE_SHOT'));
  assert.deepEqual(f.calls.map((call) => call.paid), [false, true]);
});

test('invalid or absent mode/request flags fail closed before any transport', () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not run'); };
  for (const argv of [
    ['--unknown'], ['--offline', '--live'], ['--live'],
    ['--live', '--url', REQUEST_URL], ['--live', '--url', REQUEST_URL, '--method', 'get'],
    ['--live', '--url', REQUEST_URL, '--method', 'GET', '--body', 'not valid for GET'],
    ['--live', '--url', REQUEST_URL, '--method', 'POST'],
    [...liveArgs, '--url', REQUEST_URL], [...liveArgs, '--maxTotalRaw', '99999'],
    ['--live', '--url', REQUEST_URL, '--method', 'GET', '--signer', TEST_SIGNER],
  ]) {
    assert.throws(() => createModelFreeExample({ argv, env: { NANO_SIGNER_MODULE: TEST_SIGNER }, fetchImpl }), ModelFreeExampleError);
  }
  assert.equal(calls, 0);
});

test('live mode has no fallback to a missing, relative, URI, nul, or public offline fixture signer', () => {
  const offlinePath = fileURLToPath(new URL('./examples/offline-signer.fixture.mjs', import.meta.url));
  for (const signer of [undefined, '', 'relative.mjs', 'file:///tmp/module.mjs', '/tmp/nul\0.mjs', offlinePath]) {
    assert.throws(() => createModelFreeExample({ argv: liveArgs, env: { NANO_SIGNER_MODULE: signer } }), refuses('INVALID_SIGNER_MODULE'));
  }
});

test('live request accepts only the exact owner HTTPS origin without credentials, fragments, normalization or overrides', () => {
  for (const url of [OFFLINE_URL, 'http://pursekeeper.dev/v1/hash', 'https://pursekeeper.dev.evil.invalid/v1/hash',
    'https://user:secret@pursekeeper.dev/v1/hash', REQUEST_URL + '#fragment',
    'https://pursekeeper.dev:443/v1/hash', 'https://pursekeeper.dev/a/../v1/hash']) {
    assert.throws(() => createModelFreeExample({ argv: ['--live', '--url', url, '--method', 'POST', '--body', 'x'],
      env: { NANO_SIGNER_MODULE: TEST_SIGNER } }), refuses('ORIGIN_NOT_ALLOWED'));
  }
});

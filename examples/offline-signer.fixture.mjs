// PUBLIC SYNTHETIC TEST MATERIAL ONLY. Never use this module as a live signer.
// The fake frontier is not read from a chain. This fixture has no network I/O,
// environment access, RPC calls, wallet access, prompts or persisted payloads.
import { createSendBlock } from 'nano-sdk/blocks';
import { deriveAccountFromPrivateKey, hashBlock, verifyBlock } from 'nano-sdk/crypto';

export const EXAMPLE_CAP_RAW = '1000000000000000000000000000'; // 0.001 XNO.
export const OFFLINE_URL = 'https://merchant.invalid/deterministic-resource';
export const OFFLINE_PAY_TO = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const PUBLIC_TEST_KEY = '0'.repeat(64);
const account = deriveAccountFromPrivateKey({ privateKey: PUBLIC_TEST_KEY });
const frontier = Object.freeze({
  type: 'state', account, previous: '0'.repeat(64), representative: OFFLINE_PAY_TO,
  balance: (BigInt(EXAMPLE_CAP_RAW) * 2n).toString(), link: '0'.repeat(64),
  link_as_account: OFFLINE_PAY_TO, signature: '0'.repeat(128), work: '0'.repeat(16),
});
let helperLoads = 0;
let signedBlocks = 0;

export function offlineSignerStats() {
  return Object.freeze({ helperLoads, signedBlocks });
}

// Same createHelper contract as the operator-owned environment adapter. The
// unchanged production client imports this lazily after its guard accepts 402.
export function createHelper() {
  helperLoads++;
  let attempted = false;
  return Object.freeze({
    async generateSendBlock({ payTo, amount } = {}) {
      if (attempted) throw new Error('Offline fixture is one-shot');
      attempted = true;
      if (payTo !== OFFLINE_PAY_TO || amount !== EXAMPLE_CAP_RAW) {
        throw new Error('Offline fixture refuses a non-fixture payment');
      }
      const block = createSendBlock({
        amount, destination: payTo, frontierBlock: { ...frontier },
        privateKey: PUBLIC_TEST_KEY,
      });
      signedBlocks++;
      return block;
    },
  });
}

// A deterministic in-memory seller, not HTTP, a Nano node or settlement proof.
export function createOfflineTransport({ paidStatus = 200, quoteAmount = EXAMPLE_CAP_RAW,
  paidFailure = false, payTo = OFFLINE_PAY_TO } = {}) {
  const observations = { unsignedRequests: 0, paymentRequests: 0 };
  const required = {
    x402Version: 2,
    resource: { url: OFFLINE_URL, description: 'Synthetic offline fixture', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', amount: quoteAmount,
      payTo, maxTimeoutSeconds: 60,
      extra: { work: 'optional', workOptional: true, workThreshold: 'fffffff800000000', session: '1'.repeat(32) } }],
  };
  async function fetchImpl(url, options = {}) {
    if (url !== OFFLINE_URL || options.method !== 'GET' || options.body !== undefined || options.redirect !== 'manual') {
      throw new Error('Offline fixture refuses an unexpected request');
    }
    const payment = new Headers(options.headers).get('payment-signature');
    if (!payment) {
      observations.unsignedRequests++;
      return new Response(JSON.stringify({ x402: required }), { status: 402 });
    }
    observations.paymentRequests++;
    const payload = JSON.parse(Buffer.from(payment, 'base64').toString('utf8'));
    const block = payload?.payload?.block;
    if (JSON.stringify(payload.accepted) !== JSON.stringify(required.accepts[0]) ||
        JSON.stringify(payload.resource) !== JSON.stringify(required.resource) ||
        payload.x402Version !== 2 || !block || block.account !== account ||
        block.previous !== hashBlock({ block: frontier }) ||
        block.balance !== EXAMPLE_CAP_RAW || block.link !== '0'.repeat(64) ||
        block.link_as_account !== OFFLINE_PAY_TO || !verifyBlock({ block })) {
      throw new Error('Offline fixture refuses an incorrectly bound payment');
    }
    if (paidFailure) throw new Error('Synthetic lost payment response');
    return new Response(JSON.stringify({ resource: 'offline-fixture-result', synthetic: true }), {
      status: paidStatus, headers: { 'content-type': 'application/json' },
    });
  }
  return Object.freeze({ fetchImpl, observations });
}

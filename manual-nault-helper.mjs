import { createSendBlock } from 'nano-sdk/blocks';
import { deriveAccountFromLink, hashBlock, verifyBlock } from 'nano-sdk/crypto';

const FINANCIAL_FIELDS = ['account', 'previous', 'representative', 'balance', 'link'];
const BLOCK_FIELDS = new Set([
  'type', ...FINANCIAL_FIELDS, 'link_as_account', 'signature', 'work',
]);
const ENVELOPE_FIELDS = new Set(['block', 'previous']);
const SEND_FIELDS = new Set(['payTo', 'amount']);
const ZERO_WORK = '0'.repeat(16);
const FAIL = 'Manual Nault signing failed; no automatic retry';
const MAX_URI_BYTES = 32_768;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function onlyKeys(value, allowed) {
  if (!plainObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(FAIL);
  }
}

function publicBlock(input) {
  onlyKeys(input, BLOCK_FIELDS);
  if (input.type !== undefined && input.type !== 'state') throw new Error(FAIL);
  for (const field of [...FINANCIAL_FIELDS, 'signature']) {
    if (typeof input[field] !== 'string') throw new Error(FAIL);
  }
  if (!input.account.startsWith('nano_') || !input.representative.startsWith('nano_')) {
    throw new Error(FAIL);
  }
  const linkedAccount = deriveAccountFromLink({ link: input.link });
  if (input.link_as_account !== undefined && input.link_as_account !== linkedAccount) {
    throw new Error(FAIL);
  }
  const work = input.work === undefined || input.work === '0' ? ZERO_WORK : input.work;
  if (typeof work !== 'string' || !/^[0-9a-fA-F]{16}$/.test(work)) throw new Error(FAIL);
  // Copy only public state-block fields; the caller's object is never retained.
  const block = {
    type: 'state',
    ...Object.fromEntries(FINANCIAL_FIELDS.map((field) => [field, input[field]])),
    link_as_account: linkedAccount,
    signature: input.signature,
    work,
  };
  if (verifyBlock({ block }) !== true) throw new Error(FAIL);
  return Object.freeze(block);
}

function sameFinancialFields(actual, expected) {
  return FINANCIAL_FIELDS.every((field) => actual[field] === expected[field]);
}

function signedBlockFromURI(value, proposal, previous) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_URI_BYTES) {
    throw new Error(FAIL);
  }
  const uri = value.trim();
  if (!uri.startsWith('nanoprocess:')) throw new Error(FAIL);
  const envelope = JSON.parse(uri.slice('nanoprocess:'.length));
  onlyKeys(envelope, ENVELOPE_FIELDS);
  onlyKeys(envelope.block, BLOCK_FIELDS);

  const raw = envelope.block;
  if (!sameFinancialFields(raw, proposal) ||
      (raw.type !== undefined && raw.type !== 'state')) throw new Error(FAIL);
  // This manual adapter is intentionally for workOptional quotes only. It does
  // not claim to validate or compute PoW. The parent client refuses zero work
  // for required-work quotes, for which its official Helper remains available.
  if (raw.work !== undefined && raw.work !== '0' && raw.work !== ZERO_WORK) {
    throw new Error(FAIL);
  }
  const block = publicBlock({ ...raw, type: 'state', work: ZERO_WORK });
  if (!sameFinancialFields(block, proposal)) throw new Error(FAIL);
  if (hashBlock({ block }) !== hashBlock({ block: { ...proposal } })) throw new Error(FAIL);
  if (envelope.previous !== undefined) {
    const returnedPrevious = publicBlock(envelope.previous);
    if (!sameFinancialFields(returnedPrevious, previous) ||
        returnedPrevious.signature !== previous.signature ||
        hashBlock({ block: returnedPrevious }) !== hashBlock({ block: previous })) {
      throw new Error(FAIL);
    }
  }
  return block;
}

/**
 * Pure, one-shot bridge to Nault's documented manual remote-signing format.
 * No wallet, credential, UI, network, persistence or broadcast operation exists
 * here. The operator supplies a current PUBLIC signed frontier block and a
 * callback that lets the operator review and sign in their own Nault wallet.
 *
 * A helper instance is consumed by its first generateSendBlock attempt, even
 * on failure. Request-id retries belong to the outer guard's cached promise.
 * A later purchase needs a fresh helper and independently refreshed frontier.
 */
export function createManualNaultHelper({ previousBlock, requestSignature } = {}) {
  let previous;
  try {
    if (typeof requestSignature !== 'function') throw new Error(FAIL);
    previous = publicBlock(previousBlock);
  } catch {
    throw new Error('Invalid public frontier block or manual signing callback');
  }

  let attempted = false;
  return Object.freeze({
    async generateSendBlock(params = {}) {
      if (attempted) throw new Error(FAIL);
      attempted = true;
      try {
        onlyKeys(params, SEND_FIELDS);
        const { payTo, amount } = params;
        if (typeof payTo !== 'string' || !payTo.startsWith('nano_') ||
            typeof amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(amount)) {
          throw new Error(FAIL);
        }
        const unsigned = createSendBlock({
          amount,
          destination: payTo,
          frontierBlock: previous,
          representative: previous.representative,
        });
        const proposal = Object.freeze(Object.fromEntries(
          FINANCIAL_FIELDS.map((field) => [field, unsigned[field]]),
        ));
        if (proposal.previous !== hashBlock({ block: previous })) throw new Error(FAIL);
        const unsignedURI = 'nanosign:' + JSON.stringify({ block: proposal, previous });
        const returned = await requestSignature(Object.freeze({ unsignedURI, proposal }));
        return signedBlockFromURI(returned, proposal, previous);
      } catch {
        // Callback errors may contain private UI or wallet information. Never
        // propagate a raw exception, stack, signed payload or secret here.
        throw new Error(FAIL);
      }
    },
  });
}

import { ExactNanoScheme } from '@x402nano/exact/client';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEX_64 = /^[A-Fa-f0-9]{64}$/;
const HEX_128 = /^[A-Fa-f0-9]{128}$/;

// The published Nano scheme owns block construction/signing. This binding never
// reads wallet credentials and never calls processBlock/broadcasts to a node.
export function createNanoPaymentPayload({ helper }) {
  if (!helper || typeof helper.generateSendBlock !== 'function') {
    throw new Error('A Nano helper with generateSendBlock is required');
  }
  const scheme = new ExactNanoScheme(helper);
  return async function createPaymentPayload(required) {
    const accepted = required?.accepts?.[0];
    if (required?.x402Version !== 2 || required.accepts.length !== 1 ||
        accepted.scheme !== 'exact' || accepted.network !== 'nano:mainnet' ||
        accepted.asset !== 'XNO') throw new Error('Unsupported payment requirement');
    let signed;
    try { signed = await scheme.createPaymentPayload(2, accepted); }
    catch { throw new Error('Nano block creation failed; no automatic retry'); }
    const block = signed?.payload?.block;
    const optionalWork = accepted.extra?.workOptional === true;
    if (!block || block.type !== 'state' || !HEX_64.test(block.previous) ||
        !HEX_64.test(block.link) || !HEX_128.test(block.signature) ||
        typeof block.account !== 'string' || !block.account.startsWith('nano_') ||
        !/^(0|[1-9]\d*)$/.test(block.balance) ||
        !(typeof block.work === 'string' && (/^[A-Fa-f0-9]{16}$/.test(block.work) ||
          (optionalWork && block.work === '0'))) ||
        (!optionalWork && /^0+$/.test(block.work))) {
      throw new Error('Nano helper returned an invalid block or missing work');
    }
    return { x402Version: 2, resource: required.resource, accepted, payload: { block } };
  };
}

// A trusted local operator chooses this module in plugin configuration. Loading
// is lazy: merely registering the plugin or refusing a quote cannot load a key.
export function createOperatorPaymentFactory({ signerModule }) {
  if (typeof signerModule !== 'string' || !isAbsolute(signerModule)) {
    throw new Error('signerModule must be an absolute path to an operator-owned module');
  }
  let client;
  return async function createPaymentPayload(required) {
    if (!client) {
      client = (async () => {
        const module = await import(pathToFileURL(signerModule).href);
        if (typeof module.createHelper !== 'function') throw new Error('Missing createHelper');
        return createNanoPaymentPayload({ helper: await module.createHelper() });
      })();
    }
    try { return await (await client)(required); }
    catch { throw new Error('Operator payment helper failed; no automatic retry'); }
  };
}

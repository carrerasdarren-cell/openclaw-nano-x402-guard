import test from 'node:test';
import assert from 'node:assert/strict';
import { createSendBlock } from 'nano-sdk/blocks';
import { deriveAccountFromPrivateKey, hashBlock, signBlock, verifyBlock } from 'nano-sdk/crypto';
import { createManualNaultHelper } from './manual-nault-helper.mjs';

// Published synthetic keys for offline regression fixtures only. Never funded,
// read from user configuration, or transmitted to any wallet or network.
const SYNTHETIC_KEY = '0'.repeat(64);
const OTHER_SYNTHETIC_KEY = '1'.repeat(64);
const ACCOUNT = deriveAccountFromPrivateKey({ privateKey: SYNTHETIC_KEY });
const OTHER_ACCOUNT = deriveAccountFromPrivateKey({ privateKey: OTHER_SYNTHETIC_KEY });
const PAY_TO = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const ZERO_WORK = '0'.repeat(16);
const financialFields = ['account', 'previous', 'representative', 'balance', 'link'];

function previousBlock() {
  const block = {
    type: 'state', account: ACCOUNT, previous: '0'.repeat(64),
    representative: PAY_TO, balance: '5000', link: '0'.repeat(64),
    link_as_account: PAY_TO, signature: '0'.repeat(128), work: ZERO_WORK,
  };
  block.signature = signBlock({ block, privateKey: SYNTHETIC_KEY });
  assert.equal(verifyBlock({ block }), true);
  return block;
}

function signedReturn(proposal, prior, { omitType = true, omitWork = true } = {}) {
  const block = createSendBlock({
    amount: (BigInt(prior.balance) - BigInt(proposal.balance)).toString(),
    destination: PAY_TO, frontierBlock: prior, privateKey: SYNTHETIC_KEY,
  });
  if (omitType) delete block.type;
  if (omitWork) delete block.work;
  return { block, previous: prior };
}

function callbackFixture(transform = (value) => value) {
  const prior = previousBlock();
  const calls = [];
  const requestSignature = async (input) => {
    calls.push(input);
    return 'nanoprocess:' + JSON.stringify(transform(signedReturn(input.proposal, prior), input));
  };
  return { prior, calls, requestSignature };
}

async function rejectsSafely(promise) {
  await assert.rejects(promise, (error) => error.message === 'Manual Nault signing failed; no automatic retry');
}

test('builds documented unsigned Nault input and verifies a real synthetic Nano signature', async () => {
  const f = callbackFixture();
  const helper = createManualNaultHelper({ previousBlock: f.prior, requestSignature: f.requestSignature });
  const block = await helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' });
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].unsignedURI.startsWith('nanosign:'));
  const envelope = JSON.parse(f.calls[0].unsignedURI.slice('nanosign:'.length));
  assert.deepEqual(Object.keys(envelope.block).sort(), [...financialFields].sort());
  assert.equal(envelope.block.balance, '4000');
  assert.equal(envelope.block.previous, hashBlock({ block: f.prior }));
  assert.equal(envelope.previous.signature, f.prior.signature);
  assert.equal(block.type, 'state');
  assert.equal(block.balance, '4000');
  assert.equal(block.link_as_account, PAY_TO);
  assert.equal(block.work, ZERO_WORK);
  assert.equal(verifyBlock({ block }), true);
});

test('captures immutable public frontier/proposal before invoking the callback', async () => {
  const prior = previousBlock();
  const savedPrior = { ...prior };
  const helper = createManualNaultHelper({
    previousBlock: prior,
    requestSignature: async (input) => {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.proposal), true);
      assert.throws(() => { input.proposal.balance = '0'; }, TypeError);
      const envelope = JSON.parse(input.unsignedURI.slice('nanosign:'.length));
      assert.equal(envelope.previous.balance, '5000');
      return 'nanoprocess:' + JSON.stringify(signedReturn(input.proposal, savedPrior));
    },
  });
  prior.balance = '999999';
  prior.signature = '0'.repeat(128);
  const block = await helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' });
  assert.equal(block.balance, '4000');
});

test('missing, altered, unsigned or foreign frontier is refused before callback', () => {
  const good = previousBlock();
  const cases = [undefined, null, {}, { ...good, signature: '0'.repeat(128) },
    { ...good, balance: '9000' }, { ...good, type: 'send' },
    { ...good, account: OTHER_ACCOUNT }, { ...good, privateKey: 'forbidden-field' },
  ];
  let calls = 0;
  for (const prior of cases) {
    assert.throws(() => createManualNaultHelper({ previousBlock: prior, requestSignature: async () => { calls++; } }),
      /Invalid public frontier/);
  }
  assert.equal(calls, 0);
});

test('invalid or insufficient amount and invalid recipient never request a signature', async () => {
  for (const args of [
    { payTo: PAY_TO, amount: '5001' }, { payTo: PAY_TO, amount: '0' },
    { payTo: PAY_TO, amount: '-1' }, { payTo: PAY_TO, amount: 1000 },
    { payTo: 'nano_invalid', amount: '1000' },
  ]) {
    let calls = 0;
    const helper = createManualNaultHelper({ previousBlock: previousBlock(), requestSignature: async () => { calls++; } });
    await rejectsSafely(helper.generateSendBlock(args));
    assert.equal(calls, 0);
  }
});

test('every financial field must exactly match the approved proposal', async () => {
  for (const change of [
    { account: OTHER_ACCOUNT }, { previous: 'F'.repeat(64) },
    { representative: OTHER_ACCOUNT }, { balance: '3000' }, { link: 'F'.repeat(64) },
  ]) {
    const f = callbackFixture((value) => ({ ...value, block: { ...value.block, ...change } }));
    const helper = createManualNaultHelper({ previousBlock: f.prior, requestSignature: f.requestSignature });
    await rejectsSafely(helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' }));
  }
});

test('a changed destination with its own valid signature is still refused', async () => {
  const f = callbackFixture((value) => {
    value.block = createSendBlock({ amount: '1000', destination: OTHER_ACCOUNT,
      frontierBlock: f.prior, privateKey: SYNTHETIC_KEY });
    return value;
  });
  const helper = createManualNaultHelper({ previousBlock: f.prior, requestSignature: f.requestSignature });
  await rejectsSafely(helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' }));
});

test('wrong signature, foreign previous block, wrong type and extra fields are refused', async () => {
  for (const change of [
    (v) => { v.block.signature = '0'.repeat(128); return v; },
    (v) => { v.block.type = 'send'; return v; },
    (v) => { v.block.privateKey = 'not-a-real-key'; return v; },
    (v) => { v.block.link_as_account = OTHER_ACCOUNT; return v; },
    (v) => { v.foreignBlock = {}; return v; },
    (v) => { v.previous = { ...v.previous, balance: '9000' }; return v; },
  ]) {
    const f = callbackFixture(change);
    const helper = createManualNaultHelper({ previousBlock: f.prior, requestSignature: f.requestSignature });
    await rejectsSafely(helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' }));
  }
});

test('only documented bounded nanoprocess JSON strings are accepted', async () => {
  for (const value of [
    {}, [], null, '', 'nanosign:{}', 'nanoprocess:%7B%7D',
    'nanoprocess:{bad-json}', 'nanoprocess:{"block":[]}',
    'nanoprocess:' + ' '.repeat(32769),
  ]) {
    const helper = createManualNaultHelper({ previousBlock: previousBlock(), requestSignature: async () => value });
    await rejectsSafely(helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' }));
  }
});

test('omitted, short-zero and sixteen-zero work normalize only to optional-work placeholder', async () => {
  for (const work of [undefined, '0', ZERO_WORK]) {
    const f = callbackFixture((value) => {
      if (work !== undefined) value.block.work = work;
      return value;
    });
    const helper = createManualNaultHelper({ previousBlock: f.prior, requestSignature: f.requestSignature });
    assert.equal((await helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' })).work, ZERO_WORK);
  }
  for (const work of ['1234567890abcdef', 'invalid', 0]) {
    const f = callbackFixture((value) => { value.block.work = work; return value; });
    const helper = createManualNaultHelper({ previousBlock: f.prior, requestSignature: f.requestSignature });
    await rejectsSafely(helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' }));
  }
});

test('one-shot helper never requests a second signature after success or failure', async () => {
  for (const fail of [false, true]) {
    const f = callbackFixture((value) => {
      if (fail) value.block.signature = '0'.repeat(128);
      return value;
    });
    const helper = createManualNaultHelper({ previousBlock: f.prior, requestSignature: f.requestSignature });
    const first = helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' });
    await rejectsSafely(helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' }));
    if (fail) await rejectsSafely(first); else await first;
    await rejectsSafely(helper.generateSendBlock({ payTo: PAY_TO, amount: '1001' }));
    assert.equal(f.calls.length, 1);
  }
});

test('callback errors never expose its message, keys, response or stack', async () => {
  const helper = createManualNaultHelper({
    previousBlock: previousBlock(),
    requestSignature: async () => { throw new Error('PRIVATE_NAULT_DETAIL_SENTINEL'); },
  });
  await assert.rejects(helper.generateSendBlock({ payTo: PAY_TO, amount: '1000' }),
    (error) => error.message === 'Manual Nault signing failed; no automatic retry' &&
      !error.message.includes('PRIVATE_NAULT_DETAIL_SENTINEL'));
});

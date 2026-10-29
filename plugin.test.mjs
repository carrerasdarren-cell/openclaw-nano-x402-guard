import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPluginApi } from 'openclaw/plugin-sdk/plugin-test-api';
import { getToolPluginMetadata } from 'openclaw/plugin-sdk/tool-plugin';
import { createPlugin } from './index.mjs';
import { fileURLToPath } from 'node:url';

// Synthetic public zero account; no key, real wallet or network is used.
const PAY_TO = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const URL = 'https://merchant.example/v1/hash';
const config = {
  allowPayTo: [PAY_TO],
  allowedOrigins: ['https://merchant.example'],
  maxPerCallRaw: '1',
  maxTotalRaw: '1',
  signerModule: '/operator-owned/not-loaded-in-tests.mjs',
};

function quote() {
  return {
    x402Version: 2,
    resource: { url: URL },
    accepts: [{
      scheme: 'exact', network: 'nano:mainnet', asset: 'XNO',
      amount: '1', payTo: PAY_TO, maxTimeoutSeconds: 60,
      extra: { workOptional: true },
    }],
  };
}

function fixture() {
  const calls = { fetch: [], sign: [] };
  const fetchImpl = async (url, options) => {
    calls.fetch.push({ url, options });
    if (new Headers(options?.headers).has('payment-signature')) {
      return new Response(JSON.stringify({ value: 'mock-resource' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ x402: quote() }), {
      status: 402,
      headers: { 'payment-required': Buffer.from(JSON.stringify(quote())).toString('base64') },
    });
  };
  const createPaymentPayload = async (required) => {
    calls.sign.push(required);
    return {
      x402Version: 2, resource: required.resource, accepted: required.accepts[0],
      payload: { block: {
        type: 'state', account: PAY_TO, representative: PAY_TO,
        previous: 'A'.repeat(64), balance: '9', link: '0'.repeat(64),
        signature: 'B'.repeat(128), work: '0',
      } },
    };
  };
  return { calls, fetchImpl, createPaymentPayload };
}

function registeredTool(plugin, pluginConfig = config) {
  const registered = [];
  const api = createTestPluginApi({
    pluginConfig,
    registerTool: (tool, options) => registered.push({ tool, options }),
  });
  plugin.register(api);
  assert.equal(registered.length, 1);
  const { tool, options } = registered[0];
  assert.equal(typeof tool, 'object');
  assert.equal(options.optional, true);
  return tool;
}

function resultOf(result) {
  const text = result.content.find((part) => part.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

test('production defaults use fetch and the lazy official-client helper path without injected adapters',async()=>{
  const f=fixture();const savedFetch=globalThis.fetch;
  globalThis.fetch=f.fetchImpl;
  try{
    const tool=registeredTool(createPlugin(),{...config,signerModule:fileURLToPath(new globalThis.URL('./mock-helper.fixture.mjs',import.meta.url))});
    const result=resultOf(await tool.execute('default-path',{requestId:'default-path',url:URL}));
    assert.equal(result.result.status,200);
    assert.equal(f.calls.fetch.length,2);
    const encoded=new Headers(f.calls.fetch[1].options.headers).get('payment-signature');
    const payload=JSON.parse(Buffer.from(encoded,'base64').toString());
    assert.equal(payload.accepted.payTo,PAY_TO);
    assert.equal(payload.accepted.amount,'1');
    assert.equal(payload.payload.block.signature,'B'.repeat(128));
  }finally{globalThis.fetch=savedFetch;}
});

test('actual OpenClaw SDK exposes one optional native tool and strict operator config', () => {
  const f = fixture();
  const plugin = createPlugin(f);
  const metadata = getToolPluginMetadata(plugin);
  assert.equal(metadata.id, 'nano-x402-guard');
  assert.equal(metadata.tools.length, 1);
  assert.equal(metadata.tools[0].name, 'nano_x402_purchase');
  assert.equal(metadata.tools[0].optional, true);
  assert.equal(metadata.configSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(metadata.tools[0].parameters.properties).sort(), ['body', 'method', 'requestId', 'url']);
  assert.equal(metadata.tools[0].parameters.additionalProperties, false);
  const tool = registeredTool(plugin);
  assert.equal(tool.name, 'nano_x402_purchase');
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.sign.length, 0);
});

test('native registered tool invokes guarded payment and marks merchant content untrusted', async () => {
  const f = fixture();
  const tool = registeredTool(createPlugin(f));
  const result = resultOf(await tool.execute('call-1', { requestId: 'purchase-1', url: URL }));
  assert.equal(result.trust, 'untrusted-merchant-content');
  assert.equal(f.calls.sign.length, 1);
  assert.equal(f.calls.fetch.length, 2);
  assert.equal(f.calls.sign[0].accepts[0].amount, '1');
});

test('re-registering the same plugin/config does not reset the cumulative budget', async () => {
  const f = fixture();
  const plugin = createPlugin(f);
  const first = registeredTool(plugin);
  await first.execute('call-1', { requestId: 'purchase-1', url: URL });
  const nextSession = registeredTool(plugin, { ...config, allowPayTo: [...config.allowPayTo] });
  const result = resultOf(await nextSession.execute('call-2', { requestId: 'purchase-2', url: URL }));
  assert.equal(result.ok, false);
  assert.equal(f.calls.sign.length, 1);
});

test('repeated request id through another registration cannot sign a second block', async () => {
  const f = fixture();
  const plugin = createPlugin(f);
  await registeredTool(plugin).execute('call-1', { requestId: 'purchase-1', url: URL });
  await registeredTool(plugin).execute('call-2', { requestId: 'purchase-1', url: URL });
  assert.equal(f.calls.sign.length, 1);
});

test('unapproved origin cannot reach the operator payment factory', async () => {
  const f = fixture();
  const tool = registeredTool(createPlugin(f));
  const result = resultOf(await tool.execute('call-1', { requestId: 'purchase-1', url: 'https://other.example/v1/hash' }));
  assert.equal(result.ok, false);
  assert.equal(f.calls.sign.length, 0);
  assert.equal(f.calls.fetch.length, 0);
});

test('model arguments cannot override a signer or spend cap even if direct calls bypass schema', async () => {
  const f = fixture();
  const tool = registeredTool(createPlugin(f));
  for (const override of [
    { maxTotalRaw: '999999' }, { signerModule: '/attacker.mjs' },
    { allowedOrigins: ['https://other.example'] }, { createPaymentPayload: 'fake' },
  ]) {
    const result = resultOf(await tool.execute('call-1', { requestId: 'purchase-1', url: URL, ...override }));
    assert.equal(result.ok, false);
  }
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.sign.length, 0);
});

test('invalid operator configuration and GET bodies refuse before network or signing', async () => {
  const f = fixture();
  for (const bad of [
    { ...config, maxTotalRaw: 1 }, { ...config, maxPerCallRaw: '0' },
    { ...config, signerModule: 'relative.mjs' }, { ...config, allowedOrigins: [] },
  ]) {
    const tool = registeredTool(createPlugin(f), bad);
    assert.equal(resultOf(await tool.execute('call-1', { requestId: 'purchase-1', url: URL })).ok, false);
  }
  const tool = registeredTool(createPlugin(f));
  assert.equal(resultOf(await tool.execute('call-1', { requestId: 'purchase-1', url: URL, body: 'body' })).ok, false);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.sign.length, 0);
});

test('upstream error messages and stack traces are not exposed as tool output', async () => {
  const plugin = createPlugin({
    fetchImpl: async () => { throw new Error('private-secret-sentinel'); },
    createPaymentPayload: async () => { throw new Error('never called'); },
  });
  const tool = registeredTool(plugin);
  const result = await tool.execute('call-1', { requestId: 'purchase-1', url: URL });
  assert.equal(resultOf(result).ok, false);
  assert.equal(JSON.stringify(result).includes('private-secret-sentinel'), false);
  assert.equal(JSON.stringify(result).includes('stack'), false);
});

test('aborted invocation refuses before quote fetch and signer loading', async () => {
  const f = fixture();
  const tool = registeredTool(createPlugin(f));
  const controller = new AbortController();
  controller.abort(new Error('private-abort-sentinel'));
  const result = await tool.execute('call-1', { requestId: 'purchase-1', url: URL }, controller.signal);
  assert.equal(resultOf(result).ok, false);
  assert.equal(JSON.stringify(result).includes('private-abort-sentinel'), false);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.sign.length, 0);
});

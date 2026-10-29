import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeterministicProvider, FIXTURE_MODEL } from './examples/fixture-provider/index.mjs';
import { parseNativeOptions, nativeLoopConfig, nativeChildEnvironment, nativeCliArguments, runNativeLoop } from './examples/native-loop.mjs';

const directory = '/operator/isolated-fixture';
const request = { requestId: 'offline-test', url: 'https://denied.invalid/test', method: 'GET' };
const tools = [{ name: 'nano_x402_purchase' }];
async function streamResult(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

test('supported provider emits one actual tool call without transport, prompt or model credential', async () => {
  const savedFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('No model network'); };
  try {
    const provider = createDeterministicProvider(request);
    assert.deepEqual(provider.auth, []);
    assert.deepEqual(provider.resolveSyntheticAuth(), {
      apiKey: 'PUBLIC_FIXTURE_NOT_A_CREDENTIAL', source: 'local deterministic fixture', mode: 'token',
    });
    const stream = provider.createStreamFn()(FIXTURE_MODEL, { messages: [], tools });
    const { events, message } = await streamResult(stream);
    assert.equal(events[0].type, 'start');
    assert.equal(events.at(-1).type, 'done');
    assert.equal(message.stopReason, 'toolUse');
    assert.deepEqual(message.content[0].arguments, request);
    assert.equal(message.content[0].name, 'nano_x402_purchase');
    assert.equal(fetches, 0);
    assert.equal(message.usage.totalTokens, 0);
    // OpenClaw wraps this public method; the returned stream stays mutable.
    const originalResult = stream.result;
    stream.result = () => originalResult();
    assert.equal((await stream.result()).stopReason, 'toolUse');
  } finally { globalThis.fetch = savedFetch; }
});

test('native tool result is observed and summarized; no payment or settlement is invented', async () => {
  const provider = createDeterministicProvider(request);
  const streamFn = provider.createStreamFn();
  const first = await streamResult(streamFn(FIXTURE_MODEL, { messages: [], tools }));
  const call = first.message.content[0];
  const result = { role: 'toolResult', toolCallId: call.id, toolName: call.name, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Guard refused' }) }] };
  const last = await streamResult(streamFn(FIXTURE_MODEL, { messages: [first.message, result], tools }));
  assert.equal(last.message.stopReason, 'stop');
  const summary = JSON.parse(last.message.content[0].text);
  assert.equal(summary.toolResultObserved, true);
  assert.equal(summary.outcome, 'guard-refused-or-failed');
  assert.equal(summary.remoteModel, false);
  assert.equal('reportedTransaction' in summary, false);
  assert.equal('paidRequestSent' in summary, false);
});

test('provider recreating stream factory does not repeat a call after an ambiguous result or loop retry', async () => {
  const provider = createDeterministicProvider(request);
  await streamResult(provider.createStreamFn()(FIXTURE_MODEL, { messages: [], tools }));
  const result = await streamResult(provider.createStreamFn()(FIXTURE_MODEL, { messages: [], tools }));
  assert.equal(result.message.stopReason, 'stop');
  assert.equal(result.message.content.some((part) => part.type === 'toolCall'), false);
  assert.equal(JSON.parse(result.message.content[0].text).toolResultObserved, false);
});

test('missing native tool and pre-aborted stream stop without fabricating tool results', async () => {
  for (const ctx of [{ messages: [], tools: [] }, { messages: [], tools }]) {
    const provider = createDeterministicProvider(request);
    const result = await streamResult(provider.createStreamFn()(FIXTURE_MODEL, ctx,
      ctx.tools.length ? { signal: { aborted: true } } : undefined));
    assert.equal(result.message.stopReason, 'stop');
    assert.equal(result.message.content.some((part) => part.type === 'toolCall'), false);
    assert.equal(JSON.parse(result.message.content[0].text).toolResultObserved, false);
  }
});

test('provider snapshots request arguments and rejects malformed or spend-override fields', async () => {
  const original = { ...request };
  const provider = createDeterministicProvider(original);
  original.url = 'https://changed.invalid/';
  const result = await streamResult(provider.createStreamFn()(FIXTURE_MODEL, { messages: [], tools }));
  assert.equal(result.message.content[0].arguments.url, request.url);
  for (const bad of [undefined, {}, { ...request, maxTotalRaw: '99999' }, { ...request, method: 'DELETE' },
    { ...request, body: 'GET body' }]) assert.throws(() => createDeterministicProvider(bad), /Invalid deterministic/);
});

test('offline native config uses actual tool plugin, isolated real fixture provider and denied origin with fixed caps', () => {
  const options = parseNativeOptions([]);
  const config = nativeLoopConfig({ directory, options });
  assert.equal(config.agents.defaults.agentRuntime.id, 'pi');
  assert.equal(config.agents.defaults.model.primary, 'nano-fixture/deterministic');
  assert.deepEqual(config.agents.defaults.model.fallbacks, []);
  assert.equal(config.env.shellEnv.enabled, false);
  assert.deepEqual(config.tools.allow, ['nano_x402_purchase']);
  assert.deepEqual(config.plugins.allow, ['nano-fixture-provider', 'nano-x402-guard']);
  const args = config.plugins.entries['nano-fixture-provider'].config.request;
  const guard = config.plugins.entries['nano-x402-guard'].config;
  assert.equal(guard.maxPerCallRaw, '1000000000000000000000000000');
  assert.equal(guard.maxTotalRaw, guard.maxPerCallRaw);
  assert.equal(guard.allowedOrigins.includes(new URL(args.url).origin), false);
  assert.equal(args.method, 'GET');
  assert.equal(config.models.providers['nano-fixture'].baseUrl, 'https://fixture.invalid/v1');
});

test('operator live config chooses exactly one canonical owner POST hash call and environment signer', () => {
  const options = parseNativeOptions(['--live'], { NANO_SIGNER_MODULE: '/operator/unattended.mjs' });
  const config = nativeLoopConfig({ directory, options });
  const req = config.plugins.entries['nano-fixture-provider'].config.request;
  assert.equal(req.url, 'https://pursekeeper.dev/v1/hash');
  assert.equal(req.method, 'POST');
  assert.equal(req.body, 'hello');
  assert.equal(config.plugins.entries['nano-x402-guard'].config.signerModule, '/operator/unattended.mjs');
  assert.equal(nativeCliArguments().includes('--local'), true);
  assert.equal(nativeCliArguments()[nativeCliArguments().indexOf('--timeout') + 1], '70');
  assert.equal(nativeCliArguments().includes('--deliver'), false);
});

test('child environment drops remote model credentials, existing OpenClaw paths and node preloads; live only forwards Nano values', () => {
  const env = { PATH: '/trusted/bin', HOME: '/actual/user', OPENCLAW_CONFIG_PATH: '/actual/config',
    OPENAI_API_KEY: 'secret-model-key', ANTHROPIC_API_KEY: 'secret-model-key2', NODE_OPTIONS: '--require /untrusted.js',
    NANO_ACCOUNT_PRIVATE_KEY: 'synthetic-secret-sentinel', NANO_SIGNER_MODULE: '/operator/helper.mjs' };
  const offline = nativeChildEnvironment({ directory, options: parseNativeOptions([]), env });
  assert.equal(offline.HOME, directory);
  assert.equal(offline.OPENCLAW_CONFIG_PATH, join(directory, 'openclaw.json'));
  assert.equal('OPENAI_API_KEY' in offline, false);
  assert.equal('NODE_OPTIONS' in offline, false);
  assert.equal('NANO_ACCOUNT_PRIVATE_KEY' in offline, false);
  const live = nativeChildEnvironment({ directory, options: parseNativeOptions(['--live'], env), env });
  assert.equal(live.NANO_ACCOUNT_PRIVATE_KEY, env.NANO_ACCOUNT_PRIVATE_KEY);
  assert.equal('ANTHROPIC_API_KEY' in live, false);
});

test('malformed native modes and environment signer fail closed', () => {
  for (const args of [['--unknown'], ['--live', '--offline'], ['--offline', '--offline'],
    ['--state-root', 'relative'], ['--openclaw-bin', 'relative'], ['--live', '--url', 'https://other.invalid']]) {
    assert.throws(() => parseNativeOptions(args, { NANO_SIGNER_MODULE: '/operator/signer.mjs' }), /Invalid/);
  }
  for (const signer of [undefined, '', 'relative', '/nul\0path']) {
    assert.throws(() => parseNativeOptions(['--live'], { NANO_SIGNER_MODULE: signer }), /Invalid/);
  }
});

test('wrapper spawns exactly one isolated no-delivery native CLI child and persists no signer key', async () => {
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.native-loop-test-'));
  const calls = [];
  try {
    const result = await runNativeLoop({ argv: ['--state-root', root], env: { PATH: '/trusted/bin', OPENAI_API_KEY: 'NEVER_SERIALIZE' },
      spawnImpl(binary, args, options) {
        calls.push({ binary, args, options });
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => { child.stdout.emit('data', Buffer.from('{"synthetic-child":true}\n')); child.emit('close', 1); });
        return child;
      } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(calls[0].args.includes('--local'), true);
    assert.equal(calls[0].args.includes('--deliver'), false);
    assert.equal(result.code, 1); // A failed child is not rerun.
    const configText = await readFile(join(result.directory, 'openclaw.json'), 'utf8');
    assert.equal(configText.includes('NEVER_SERIALIZE'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stable tool-call identity survives the actual strict alphanumeric replay transformation', async () => {
  const provider = createDeterministicProvider(request);
  const streamFn = provider.createStreamFn();
  const first = await streamResult(streamFn(FIXTURE_MODEL, { messages: [], tools }));
  const call = first.message.content[0];
  // OpenClaw's openai-completions fallback transforms paired replay IDs this
  // way before the live StreamFn, while its transcript retains the original.
  const replayId = call.id.replace(/[^a-zA-Z0-9]/g, '');
  assert.equal(call.id, replayId);
  const replay = { role: 'toolResult', toolCallId: replayId, toolName: call.name, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'Actual guard refusal shape' }) }] };
  const last = await streamResult(streamFn(FIXTURE_MODEL, { messages: [first.message, replay], tools }));
  assert.equal(JSON.parse(last.message.content[0].text).toolResultObserved, true);
  const wrong = { ...replay, toolCallId: 'othercall' };
  const mismatch = await streamResult(streamFn(FIXTURE_MODEL, { messages: [first.message, wrong], tools }));
  assert.equal(JSON.parse(mismatch.message.content[0].text).toolResultObserved, false);
});

test('operator TTY flag is live-only and cannot silently turn offline review into an interactive payment', () => {
  for (const argv of [['--operator-tty'], ['--offline', '--operator-tty'], ['--operator-tty', '--offline']]) {
    assert.throws(() => parseNativeOptions(argv, { NANO_SIGNER_MODULE: '/operator/helper.mjs' }), /Invalid/);
  }
  const options = parseNativeOptions(['--operator-tty', '--live'], { NANO_SIGNER_MODULE: '/operator/helper.mjs' });
  assert.equal(options.live, true);
  assert.equal(options.operatorTty, true);
  assert.equal(parseNativeOptions(['--live'], { NANO_SIGNER_MODULE: '/operator/helper.mjs' }).operatorTty, false);
});

test('live operator TTY inherits all terminal streams and never captures private child output', async () => {
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.native-loop-test-'));
  const calls = [];
  let child;
  try {
    const result = await runNativeLoop({ argv: ['--live', '--operator-tty', '--state-root', root],
      env: { PATH: '/trusted/bin', NANO_SIGNER_MODULE: '/operator/helper.mjs', NANO_PUBLIC_FRONTIER_FILE: '/operator/public-frontier.json' },
      spawnImpl(binary, args, options) {
        calls.push({ binary, args, options });
        child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('PRIVATE_SIGNED_INPUT_SENTINEL_NOT_A_REAL_SIGNATURE'));
          child.stderr.emit('data', Buffer.from('PRIVATE_OPERATOR_DIAGNOSTIC_SENTINEL'));
          child.emit('close', 0);
        });
        return child;
      } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.stdio, 'inherit');
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.equal(result.inheritedTty, true);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
    const configText = await readFile(join(result.directory, 'openclaw.json'), 'utf8');
    assert.equal(configText.includes('PRIVATE_'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('catchable cancellation forwards once and waits for native child closure before resolving', async () => {
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.native-cancel-test-'));
  const signals = new EventEmitter(); const kills = []; let child; let settled = false;
  try {
    const done = runNativeLoop({ argv: ['--state-root', root], env: {}, signalSource: signals,
      spawnImpl() {
        child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = (signal) => kills.push(signal);
        queueMicrotask(() => { signals.emit('SIGINT'); signals.emit('SIGTERM'); });
        return child;
      } });
    done.finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(kills, ['SIGINT']); assert.equal(settled, false);
    child.emit('close', null); const result = await done;
    assert.equal(result.cancelled, true); assert.equal(result.code, 130);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execution timeout escalates to bounded kill and rejects only after child closure', async () => {
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.native-timeout-test-'));
  const signals = new EventEmitter(); const kills = [];
  try {
    await assert.rejects(runNativeLoop({ argv: ['--state-root', root], env: {}, signalSource: signals,
      executionTimeoutMs: 5, terminationGraceMs: 5,
      spawnImpl() {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = (signal) => { kills.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null)); };
        return child;
      } }), /Native example failed/);
    assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']); assert.equal(signals.listenerCount('SIGTERM'), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

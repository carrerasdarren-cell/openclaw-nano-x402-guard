#!/usr/bin/env node
// Primary reviewer example: run OpenClaw's documented LOCAL native agent loop
// with a deterministic provider plugin, no remote model or model credentials.
// Default calls the native tool with a denied origin: guard refusal occurs
// before any network or signer. --live is an operator-only one-payment mode.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { FIXTURE_MODEL } from './fixture-provider/index.mjs';

const CAP_RAW = '1000000000000000000000000000';
const OWNER = 'https://pursekeeper.dev';
const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const PROVIDER_DIR = fileURLToPath(new URL('./fixture-provider/', import.meta.url));
const FAILURE = 'Native example failed; no automatic retry. Check payment status before another operator run.';
function fail() { throw new Error('Invalid native-loop example configuration'); }

export function parseNativeOptions(argv = [], env = {}) {
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) fail();
  let live = false, operatorTty = false, stateRoot = tmpdir(), binary = 'openclaw';
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) fail();
    seen.add(arg);
    if (arg === '--live') live = true;
    else if (arg === '--operator-tty') operatorTty = true;
    else if (arg === '--offline') { /* explicit default */ }
    else if (arg === '--state-root' || arg === '--openclaw-bin') {
      const value = argv[++i];
      if (!value || !isAbsolute(value) || value.includes('\0')) fail();
      if (arg === '--state-root') stateRoot = value; else binary = value;
    } else fail();
  }
  if ((seen.has('--live') && seen.has('--offline')) || (operatorTty && !live)) fail();
  let signerModule = '/operator-unused/offline-denied-signer.mjs';
  if (live) {
    signerModule = env.NANO_SIGNER_MODULE;
    if (typeof signerModule !== 'string' || !isAbsolute(signerModule) || signerModule.includes('\0')) fail();
  }
  return Object.freeze({ live, operatorTty, stateRoot, binary, signerModule });
}

export function nativeLoopConfig({ directory, options }) {
  if (!isAbsolute(directory)) fail();
  const workspace = join(directory, 'workspace');
  const model = { ...FIXTURE_MODEL };
  delete model.provider; delete model.api; delete model.baseUrl;
  const request = Object.freeze({ requestId: 'native-fixture-one-purchase-v1',
    url: options.live ? OWNER + '/v1/hash' : 'https://denied.invalid/native-offline',
    method: options.live ? 'POST' : 'GET', ...(options.live ? { body: 'hello' } : {}) });
  return {
    env: { shellEnv: { enabled: false } },
    agents: { defaults: { workspace, skipBootstrap: true, skills: [], memorySearch: { enabled: false },
      model: { primary: 'nano-fixture/deterministic', fallbacks: [] }, agentRuntime: { id: 'pi' } },
      list: [{ id: 'fixture', default: true, workspace, agentRuntime: { id: 'pi' }, model: 'nano-fixture/deterministic' }] },
    models: { mode: 'replace', providers: { 'nano-fixture': { api: 'openai-completions',
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'PUBLIC_FIXTURE_NOT_A_CREDENTIAL', models: [model] } } },
    tools: { allow: ['nano_x402_purchase'] },
    skills: { allowBundled: [] },
    plugins: { enabled: true, allow: ['nano-fixture-provider', 'nano-x402-guard'], bundledDiscovery: 'allowlist',
      load: { paths: [PACKAGE_DIR, PROVIDER_DIR] }, entries: {
        'nano-fixture-provider': { enabled: true, config: { request } },
        'nano-x402-guard': { enabled: true, config: { allowPayTo: [PAY_TO], allowedOrigins: [OWNER],
          maxPerCallRaw: CAP_RAW, maxTotalRaw: CAP_RAW, signerModule: options.signerModule } },
      } },
  };
}

export function nativeChildEnvironment({ directory, options, env = {} }) {
  // Explicit allowlist prevents importing model keys/auth, node preloads or
  // another OpenClaw profile. Pass Nano-specific values only for operator live
  // signing, never serialize or print them. Existing env-helper expects these.
  const child = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']) {
    if (typeof env[key] === 'string') child[key] = env[key];
  }
  if (options.live) for (const [key, value] of Object.entries(env)) {
    if (/^NANO_[A-Z0-9_]+$/.test(key) && typeof value === 'string') child[key] = value;
  }
  return Object.assign(child, { HOME: directory, USERPROFILE: directory, OPENCLAW_HOME: directory,
    OPENCLAW_STATE_DIR: join(directory, 'state'), OPENCLAW_CONFIG_PATH: join(directory, 'openclaw.json'),
    OPENCLAW_AGENT_DIR: join(directory, 'state', 'agents', 'fixture', 'agent') });
}

export function nativeCliArguments() {
  return ['agent', '--local', '--agent', 'fixture', '--model', 'nano-fixture/deterministic',
    '--message', 'Run the one deterministic native Nano fixture, then stop.',
    '--thinking', 'off', '--timeout', '70', '--json'];
}

export async function prepareNativeLoop({ argv = [], env = process.env } = {}) {
  const options = parseNativeOptions(argv, env);
  await mkdir(options.stateRoot, { recursive: true });
  const directory = await mkdtemp(join(options.stateRoot, 'openclaw-nano-native-'));
  await mkdir(join(directory, 'workspace'), { recursive: true });
  const config = nativeLoopConfig({ directory, options });
  await writeFile(join(directory, 'openclaw.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { options, directory, config,
    childEnv: nativeChildEnvironment({ directory, options, env }), args: nativeCliArguments() };
}

export async function runNativeLoop({ argv = [], env = process.env, spawnImpl = spawn,
  signalSource = process, executionTimeoutMs = 90_000, terminationGraceMs = 1_500 } = {}) {
  if (!Number.isInteger(executionTimeoutMs) || executionTimeoutMs < 1 || executionTimeoutMs > 90_000 ||
      !Number.isInteger(terminationGraceMs) || terminationGraceMs < 1 || terminationGraceMs > 5_000) fail();
  const prepared = await prepareNativeLoop({ argv, env });
  // One CLI child. Cancellation waits for its closure before an outer operator
  // can clean temporary state; cancellation never proves no payment was sent.
  return new Promise((resolve, reject) => {
    let finished = false, stopping = false, pendingError, cancelledSignal;
    let timer, forceTimer, child;
    let stdout = '', stderr = '';
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const listeners = new Map();
    const finish = (error, code) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      for (const [signal, listener] of listeners) signalSource.off(signal, listener);
      if (error || pendingError) return reject(new Error(FAILURE));
      const cancelledCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[cancelledSignal];
      resolve({ code: cancelledCode ?? code ?? 1, stdout, stderr, directory: prepared.directory,
        live: prepared.options.live, inheritedTty: prepared.options.operatorTty,
        ...(cancelledSignal ? { cancelled: true } : {}) });
    };
    const stop = (signal, error) => {
      pendingError ??= error;
      if (finished || stopping) return;
      stopping = true; cancelledSignal = signal;
      try { child.kill(signal); } catch { /* closure remains authoritative */ }
      forceTimer = setTimeout(() => {
        if (!finished) try { child.kill('SIGKILL'); } catch { /* retain wait */ }
      }, terminationGraceMs);
      forceTimer.unref?.();
    };
    try { child = spawnImpl(prepared.options.binary, prepared.args, {
      env: prepared.childEnv, cwd: join(prepared.directory, 'workspace'), shell: false,
      stdio: prepared.options.operatorTty ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    }); } catch { reject(new Error(FAILURE)); return; }
    for (const signal of signals) {
      const listener = () => stop(signal);
      listeners.set(signal, listener); signalSource.on(signal, listener);
    }
    timer = setTimeout(() => stop('SIGTERM', new Error(FAILURE)), executionTimeoutMs);
    timer.unref?.();
    // Private mode never captures input or child output.
    if (!prepared.options.operatorTty) child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 1_048_576) stop('SIGTERM', new Error(FAILURE));
    });
    if (!prepared.options.operatorTty) child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > 1_048_576) stop('SIGTERM', new Error(FAILURE));
    });
    child.once('error', (error) => {
      if (!child.pid) finish(error); else stop('SIGTERM', error);
    });
    child.once('close', (code) => finish(undefined, code));
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await runNativeLoop({ argv: process.argv.slice(2) });
    process.stdout.write(result.stdout);
    // Do not repeat arbitrary child errors that could come from an operator's
    // signer. The API caller can inspect child stderr privately if needed.
    process.stderr.write(`Isolated native-loop state: ${result.directory}\n`);
    if (result.code !== 0) process.stderr.write(FAILURE + '\n');
    process.exitCode = result.code;
  } catch { process.stderr.write(FAILURE + '\n'); process.exitCode = 1; }
}

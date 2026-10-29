#!/usr/bin/env node
// Supplemental deterministic native-SDK fixture, NOT an OpenClaw Gateway,
// LLM turn, or the framework's own agent loop. See README for that distinction.
// Default is entirely offline, with public synthetic signing material. Only an
// operator may deliberately choose --live and supply their trusted signer.
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPlugin } from 'openclaw-nano-x402-guard';
import { EXAMPLE_CAP_RAW, OFFLINE_URL, OFFLINE_PAY_TO, createOfflineTransport } from './offline-signer.fixture.mjs';

export const OWNER_ORIGIN = 'https://pursekeeper.dev';
export const OWNER_PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const FIXTURE_MODULE = fileURLToPath(new URL('./offline-signer.fixture.mjs', import.meta.url));
const REQUEST_ID = 'model-free-one-purchase-v1';
const FAILURE = 'Model-free example refused or failed; no automatic retry. Check payment status before another operator run.';

export class ModelFreeExampleError extends Error {
  constructor(code) {
    super(`Model-free example refused (${code})`);
    this.name = 'ModelFreeExampleError';
    this.code = code;
  }
}
const fail = (code) => { throw new ModelFreeExampleError(code); };

function parseOptions(argv, env) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) fail('INVALID_ARGUMENTS');
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--offline')) {
    // Deliberately do not read any environment field in the default mode.
    return { mode: 'offline', signerModule: FIXTURE_MODULE, url: OFFLINE_URL,
      method: 'GET', payTo: OFFLINE_PAY_TO, origin: new URL(OFFLINE_URL).origin };
  }
  if (argv[0] !== '--live') fail('INVALID_MODE');
  const values = Object.create(null);
  for (let n = 1; n < argv.length; n += 2) {
    const name = argv[n];
    if (!['--url', '--method', '--body'].includes(name) || name in values ||
        argv[n + 1] === undefined || argv[n + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    values[name] = argv[n + 1];
  }
  if (typeof values['--url'] !== 'string' || !['GET', 'POST'].includes(values['--method']) ||
      (values['--method'] === 'GET' && values['--body'] !== undefined) ||
      (values['--method'] === 'POST' && values['--body'] === undefined)) fail('INVALID_REQUEST');
  let target;
  try { target = new URL(values['--url']); } catch { fail('INVALID_REQUEST'); }
  if (target.origin !== OWNER_ORIGIN || target.protocol !== 'https:' || target.username ||
      target.password || target.hash || target.href !== values['--url']) fail('ORIGIN_NOT_ALLOWED');
  const signerModule = env?.NANO_SIGNER_MODULE;
  if (typeof signerModule !== 'string' || !isAbsolute(signerModule) || signerModule.includes('\0') ||
      signerModule === FIXTURE_MODULE) fail('INVALID_SIGNER_MODULE');
  return { mode: 'live', signerModule, url: target.href, method: values['--method'],
    ...(values['--body'] !== undefined ? { body: values['--body'] } : {}),
    payTo: OWNER_PAY_TO, origin: OWNER_ORIGIN };
}

function decodeToolResult(response) {
  if (!Array.isArray(response?.content)) fail('INVALID_TOOL_RESULT');
  const parts = response.content.filter((part) => part?.type === 'text');
  if (parts.length !== 1 || typeof parts[0].text !== 'string') fail('INVALID_TOOL_RESULT');
  let result;
  try { result = JSON.parse(parts[0].text); } catch { fail('INVALID_TOOL_RESULT'); }
  return result;
}

export function createModelFreeExample({ argv = [], env = process.env, fetchImpl } = {}) {
  let options;
  try { options = parseOptions(argv, env); }
  catch (error) { throw error instanceof ModelFreeExampleError ? error : new ModelFreeExampleError('INVALID_CONFIGURATION'); }
  const transport = options.mode === 'offline' ? createOfflineTransport() : undefined;
  // A test can inject an in-memory transport in either mode. The CLI never
  // passes one in live mode; only explicit --live reaches globalThis.fetch.
  const entry = createPlugin({ fetchImpl: fetchImpl ?? transport?.fetchImpl ?? globalThis.fetch });
  const pluginConfig = Object.freeze({
    allowPayTo: Object.freeze([options.payTo]), allowedOrigins: Object.freeze([options.origin]),
    maxPerCallRaw: EXAMPLE_CAP_RAW, maxTotalRaw: EXAMPLE_CAP_RAW, signerModule: options.signerModule,
  });
  const tools = [];
  // Deliberately small registrar fixture. The unchanged plugin's actual pinned
  // OpenClaw SDK wrapper registers the same native tool and calls its execute.
  entry.register({ pluginConfig, registerTool(tool, metadata) { tools.push({ tool, metadata }); } });
  if (tools.length !== 1 || tools[0].tool?.name !== 'nano_x402_purchase' ||
      tools[0].metadata?.optional !== true || typeof tools[0].tool.execute !== 'function') fail('INVALID_REGISTRATION');
  let attempted = false;
  return Object.freeze({
    mode: options.mode,
    frameworkPath: 'native-sdk-registration',
    agentLoop: false,
    async invoke() {
      if (attempted) fail('ONE_SHOT');
      attempted = true; // Failures also consume this example's single attempt.
      const params = { requestId: REQUEST_ID, url: options.url, method: options.method,
        ...(options.body !== undefined ? { body: options.body } : {}) };
      let result;
      try { result = decodeToolResult(await tools[0].tool.execute('model-free-call', params)); }
      catch { return { ok: false, mode: options.mode, frameworkPath: 'native-sdk-registration', agentLoop: false, error: FAILURE }; }
      const resource = result?.result;
      return {
        ok: result?.trust === 'untrusted-merchant-content' && Number.isInteger(resource?.status) &&
          resource.status >= 200 && resource.status < 300,
        mode: options.mode, frameworkPath: 'native-sdk-registration', agentLoop: false,
        // paidRequestSent is transport exposure, not confirmed chain settlement.
        ...(resource ? { status: resource.status, paidRequestSent: resource.paid === true,
          ...(typeof resource.transaction === 'string' ? { reportedTransaction: resource.transaction } : {}),
          bodyTrust: 'untrusted-merchant-content', body: resource.body } : { error: FAILURE }),
      };
    },
  });
}

export async function runModelFreeExample(options) {
  return createModelFreeExample(options).invoke();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await runModelFreeExample({ argv: process.argv.slice(2) });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write(FAILURE + '\n');
    process.exitCode = 1;
  }
}

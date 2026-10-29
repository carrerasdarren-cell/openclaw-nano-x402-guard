// Supported OpenClaw provider hooks, replacing inference with a deterministic
// local StreamFn. No HTTP client, socket, model credential, or wallet lives here.
import { definePluginEntry, buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';

export const FIXTURE_MODEL = Object.freeze({
  id: 'deterministic', name: 'Local deterministic fixture (not a remote model)',
  provider: 'nano-fixture', api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1',
  reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
// OpenClaw's openai-completions replay policy strips non-alphanumeric IDs.
// Keep this stable ID already canonical so exact result matching survives.
const CALL_ID = 'nanofixturesinglecall';
const ZERO_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }) });

function validRequest(request) {
  return request && typeof request === 'object' && !Array.isArray(request) &&
    Object.keys(request).every((k) => ['requestId', 'url', 'method', 'body'].includes(k)) &&
    typeof request.requestId === 'string' && request.requestId.length > 0 && request.requestId.length <= 200 &&
    typeof request.url === 'string' && ['GET', 'POST'].includes(request.method) &&
    (request.body === undefined || (request.method === 'POST' && typeof request.body === 'string'));
}
function summary(toolResult) {
  let decoded;
  try {
    const text = toolResult?.content?.find((part) => part.type === 'text')?.text;
    decoded = JSON.parse(text);
  } catch { return { toolResultObserved: false, outcome: 'unrecognized-tool-result' }; }
  if (toolResult.isError === true) return { toolResultObserved: false, outcome: 'framework-tool-error' };
  if (decoded?.ok === false) return { toolResultObserved: true, outcome: 'guard-refused-or-failed' };
  const result = decoded?.result;
  if (decoded?.trust !== 'untrusted-merchant-content' || !Number.isInteger(result?.status)) {
    return { toolResultObserved: false, outcome: 'unrecognized-tool-result' };
  }
  return { toolResultObserved: true, outcome: 'resource-response', status: result.status,
    paidRequestSent: result.paid === true,
    ...(typeof result.transaction === 'string' && /^[A-Fa-f0-9]{64}$/.test(result.transaction)
      ? { reportedTransaction: result.transaction } : {}) };
}
function streamMessage(message, toolCall) {
  // Structural public AssistantMessageEventStream contract: mutable because
  // OpenClaw may wrap result(). No private SDK imports or remote transport.
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial: message };
      if (toolCall) {
        yield { type: 'toolcall_start', contentIndex: 0, partial: message };
        yield { type: 'toolcall_end', contentIndex: 0, toolCall, partial: message };
      }
      yield { type: 'done', reason: message.stopReason, message };
    },
    async result() { return message; },
  };
}
export function createDeterministicProvider(request) {
  if (!validRequest(request)) throw new Error('Invalid deterministic fixture request');
  const immutableRequest = Object.freeze({ ...request });
  let issued = false;
  const streamFn = (model, context, options) => {
    const result = context?.messages?.findLast((item) => item.role === 'toolResult' &&
      item.toolName === 'nano_x402_purchase' && item.toolCallId === CALL_ID);
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      usage: ZERO_USAGE, timestamp: Date.now(), content: [], stopReason: 'stop' };
    if (options?.signal?.aborted) {
      message.content = [{ type: 'text', text: JSON.stringify({ nativeFixture: true, remoteModel: false,
        toolResultObserved: false, outcome: 'aborted' }) }];
      return streamMessage(message);
    }
    if (result || issued) {
      message.content = [{ type: 'text', text: JSON.stringify({ nativeFixture: true, remoteModel: false,
        ...(result ? summary(result) : { toolResultObserved: false, outcome: 'no-tool-result-no-retry' }) }) }];
      return streamMessage(message);
    }
    if (!context?.tools?.some((tool) => tool.name === 'nano_x402_purchase')) {
      message.content = [{ type: 'text', text: JSON.stringify({ nativeFixture: true, remoteModel: false,
        toolResultObserved: false, outcome: 'native-tool-unavailable' }) }];
      return streamMessage(message);
    }
    issued = true; // Across all stream factory calls/retries in this process.
    const toolCall = { type: 'toolCall', id: CALL_ID, name: 'nano_x402_purchase', arguments: { ...immutableRequest } };
    message.content = [toolCall]; message.stopReason = 'toolUse';
    return streamMessage(message, toolCall);
  };
  return {
    id: 'nano-fixture', label: 'Deterministic local fixture (no model)', auth: [],
    resolveSyntheticAuth: () => ({ apiKey: 'PUBLIC_FIXTURE_NOT_A_CREDENTIAL', source: 'local deterministic fixture', mode: 'token' }),
    resolveDynamicModel: ({ modelId }) => modelId === 'deterministic' ? { ...FIXTURE_MODEL } : undefined,
    createStreamFn: () => streamFn,
  };
}
export default definePluginEntry({
  id: 'nano-fixture-provider', name: 'Deterministic local Nano fixture provider',
  description: 'Runs one fixed native tool invocation without a model service.',
  configSchema: buildJsonPluginConfigSchema({ type: 'object', additionalProperties: false, required: ['request'],
    properties: { request: { type: 'object', additionalProperties: false, required: ['requestId', 'url', 'method'],
      properties: { requestId: { type: 'string', minLength: 1, maxLength: 200 }, url: { type: 'string', minLength: 1 },
        method: { type: 'string', enum: ['GET', 'POST'] }, body: { type: 'string' } } } } }),
  register(api) { api.registerProvider(createDeterministicProvider(api.pluginConfig?.request)); },
});

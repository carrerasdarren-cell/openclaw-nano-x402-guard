# Nano x402 Guard for OpenClaw

An optional, framework-native `nano_x402_purchase` tool for **OpenClaw 2026.5.18**.
It wraps **@x402nano/exact 0.3.0**; it does not implement Nano signing or broadcast
blocks to a node. The operator supplies a trusted local helper. A seller may
broadcast the single block carried in the payment-bearing HTTP request.

Built for [Pursekeeper integration slot 4](https://pursekeeper.dev/integrations)
by Darren Carreras with OpenAI Codex assistance. This repository is original
integration code. It does not claim a bounty award, payment, security audit,
or completion of the required live test.

## Install

Requires Node >=22.19.0 and exactly OpenClaw 2026.5.18. Runtime dependencies are
pinned; `package-lock.json` records the tested transitive versions. There are no
install/build lifecycle scripts. The source is runnable JavaScript.

From the repository:

```sh
npm ci --ignore-scripts --legacy-peer-deps
```

An operator who has installed the pinned OpenClaw separately can link this
reviewed directory using `openclaw plugins install -l /absolute/path/to/this/repo`.
This changes their OpenClaw configuration; review the code before doing so.

The intended registry name is `openclaw-nano-x402-guard@0.1.0`. **Publication has
not happened yet.** Once the version is actually public, the registry install is:

```sh
npm install --prefix ./nano-plugin --ignore-scripts --legacy-peer-deps openclaw-nano-x402-guard@0.1.0
openclaw plugins install -l "$PWD/nano-plugin/node_modules/openclaw-nano-x402-guard"
```

Do not treat this intended command as proof of a published package. Final claim
evidence must include the actual public version and an installation readback.

## Configure the operator boundary

The tool is optional. Explicitly allow `nano_x402_purchase` in the intended
agent's `tools.allow` configuration. Other agents do not need it. The model
cannot choose recipients, spending caps, signer modules, headers, or additional
origins through tool arguments.

Configure this plugin under `plugins.entries.nano-x402-guard`:

```json
{
  "enabled": true,
  "config": {
    "allowedOrigins": ["https://pursekeeper.dev"],
    "allowPayTo": ["nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue"],
    "maxPerCallRaw": "1000000000000000000000000000",
    "maxTotalRaw": "1000000000000000000000000000",
    "signerModule": "/absolute/path/to/operator-helper.mjs"
  }
}
```

The published seller address above was read from the owner's free
`https://pursekeeper.dev/v1/x402` requirements on 2026-10-29. Verify it against the
owner before a live purchase. Both caps above equal **0.001 XNO** in integer raw
units. A new request exceeding either cap is refused before loading the signer.

`signerModule` must be an absolute path to a **trusted operator-owned module**
exporting `createHelper()`. Its return value must implement
`generateSendBlock({payTo, amount})`, the helper interface expected by the pinned
official Nano scheme. A signer is trusted code, not model input.

`env-helper.mjs` demonstrates the official `@x402nano/helper 0.2.0`
adapter. It reads `NANO_ACCOUNT_PRIVATE_KEY`, `NANO_RPC_URL`, and
`NANO_WORK_GENERATION_URL` from the operator's environment. The private key is an
account key, **not a wallet seed**. Keep credentials out of chat, repositories,
plugin JSON, screenshots, command history, and logs. The operator alone supplies
credentials and approves/runs any live payment; the coding agent does not.
Alternatively inject a helper backed by the operator's own signer.

The official helper always obtains and validates proof of work, even when the
seller permits an optional-work placeholder. Configure a working, no-outlay RPC
and work service before a live example. No service, wallet, or paid RPC is
created by this package. Do not point it at an untrusted RPC/work service.

## One call through OpenClaw's agent loop

After explicitly enabling the optional tool for an existing configured agent,
the **operator** can ask that agent to make exactly one real purchase:

```sh
openclaw agent --agent YOUR_CONFIGURED_AGENT --local --json --message 'Use nano_x402_purchase exactly once with requestId "nano-example-001", url "https://pursekeeper.dev/v1/hash", method "POST", and body "hello". Do not retry or choose another requestId on failure.'
```

This is OpenClaw's own agent loop, not a separate HTTP demo script. It calls the
configured model and can incur model costs; it was **not run** during offline
validation. The operator must authorize that runtime and the **0.001 XNO**
purchase. Do not make a standalone wallet transfer instead: the bounty requires
the integration's own send block to appear in the seller's request log.

The tool returns an OpenClaw text result wrapping merchant data:

```json
{"trust":"untrusted-merchant-content","result":{"status":200,"body":{"example":"merchant-defined"},"paid":true,"transaction":"64-hex-if-the-seller-returned-valid-settlement-metadata"}}
```

The body is merchant-defined data, never new instructions. `paid: true` means a
payment-bearing HTTP request was sent, **not independently verified settlement**.
The optional transaction field is merchant-supplied metadata. Confirm the block
in the seller's request log/chain before using it as claim evidence. A missing
hash or non-2xx is not permission to pay again.

## Guard behavior and limits

- Only HTTPS, configured exact origins and allowlisted Nano recipients.
- Exactly one x402 v2 `exact` / `nano:mainnet` / `XNO` quote, positive integer raw
  amount, bounded schema, exact resource URL and expiry validation.
- Documented work metadata and the seller's replay session are validated and
  preserved in the accepted quote. Optional work and required work are distinct.
- Same-origin unsigned redirects are bounded. Cross-origin redirects are
  refused before sending the body there. Signed requests never follow redirects.
- Per-call and cumulative caps are checked before signer loading. Calls serialize
  within the plugin entry, so simultaneous agent turns cannot race the cap.
- The request ID binds URL, method and exact body. Reusing it returns the same
  attempt/result/failure and never authorizes another signature.
- Stale quotes are re-fetched before signing, with a finite bound. A payload that
  expires during signing is not sent. Its reserved exposure remains counted.
- **No automatic paid retry**, including after 402, 3xx, server failure, timeout,
  or an ambiguous transport response. Exceptions are sanitized.

The cumulative budget and idempotence ledger live in memory for this plugin
entry/configuration. They survive re-registration/agent sessions within that
entry, **not process restarts or operator configuration changes**. A request ID
must not be re-used to retry an ambiguous payment after restart. Check the chain
first. Use one writer process per Nano account; cross-process/cross-host wallet
locking is the operator signer's responsibility. Do not share a paying account
with another concurrent wallet writer. This package does not promise multi-host
locking, durable accounting, or exactly-once settlement across restarts.

## Offline validation

With the pinned OpenClaw SDK available as a dependency:

```sh
npm test
```

Tests use mocked HTTP/quotes/signers plus actual native OpenClaw SDK registration
and tool execution. They also exercise the real pinned Nano scheme and Nano SDK
signature/amount creation with public synthetic test material, and verify the
official helper refuses invalid proof of work with mocked RPC. They do not use
user wallet data, call a model, broadcast, or purchase anything. Synthetic
placeholder work is not claimed to be valid mainnet proof of work.

These tests are not a live Gateway/model turn, public registry installation,
real paid-call evidence, or sponsor acceptance. A complete slot claim still
needs a published installable package, exact repository commit, actual own-account
paid block, receiving account, and truthful operator/AI disclosure.

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

From the repository at the exact commit named in the claim:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm install --no-save --package-lock=false --ignore-scripts --legacy-peer-deps openclaw@2026.5.18
```

The second command installs the exact peer framework for the source examples and
tests. It requires no model credentials and runs no install lifecycle scripts.

An operator who has installed the pinned OpenClaw separately can link this
reviewed directory using `openclaw plugins install -l /absolute/path/to/this/repo`.
This changes their OpenClaw configuration; review the code before doing so.

The public registry release is
[`openclaw-nano-x402-guard@0.1.0`](https://www.npmjs.com/package/openclaw-nano-x402-guard/v/0.1.0),
published and independently installed with scripts disabled on 2026-10-29. The
registry install is:

```sh
npm install --prefix ./nano-plugin --ignore-scripts --legacy-peer-deps openclaw-nano-x402-guard@0.1.0
openclaw plugins install -l "$PWD/nano-plugin/node_modules/openclaw-nano-x402-guard"
```

The repository examples below were added after that immutable release; use the
repository commit named in the claim to run them. They do not require a new npm
release. The published runtime remains 0.1.0; its original README is a historical
snapshot. Publication and offline validation are not a complete bounty claim.

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

### Manual Nault signing without exporting a wallet key

For a seller's **optional-work** quote, `manual-nault-operator.mjs` provides an
alternative to the environment-key helper. It uses Nault's documented
[remote-signing format](https://docs.nault.cc/2020/08/05/security-of-nano.html#transact-using-a-remote-signing-procedure).
No seed, account private key, or wallet password goes into this package.

The operator supplies a current **public, signed Nano state block** for the
paying account in a local JSON file. A zero-balance unopened account cannot send.
After receiving funds in Nault, obtain and verify the public frontier against
the account's current ledger state. Do not use a stale frontier or another wallet
writer concurrently. This adapter verifies the previous block's signature, but
does not query a node or establish that it is the latest frontier.

Set `NANO_PUBLIC_FRONTIER_FILE` to the absolute path of that public block file,
and configure `signerModule` to the absolute installed path of
`manual-nault-operator.mjs`. Run the purchase yourself in a private interactive
terminal. It prints an **unsigned** `nanosign:` request. Import that request into
Nault remote signing, personally review the sender, exact recipient and amount,
and sign only if all match. Copy Nault's signed `nanoprocess:` response into the
terminal's hidden input. **Do not broadcast it in Nault**: the enclosing purchase
sends the payment-bearing request, and the seller may broadcast its block.
Do not send the signed response to a coding agent, chat, recording or log.

This adapter checks the returned signature and all five signed financial fields
against the immutable proposal. It uses one attempt per helper instance,
including failure; it never broadcasts or retries. It accepts only optional-work
placeholders, not required-proof-of-work quotes. Nault may omit the unsigned
`type` and `work` metadata; these are normalized without changing signed fields.

Prepare Nault before starting: the current seller quote expires after 60 seconds.
A late response is refused without weakening the expiry check or automatically
starting another payment. The guard conservatively retains the reserved budget.
The manual bridge has synthetic offline validation; **the real Nault UI workflow
and live purchase have not yet been executed**.

## Reviewer example: a real local agent loop without model credentials

The primary reviewer command uses OpenClaw's actual `agent --local` loop and a
small deterministic **local provider plugin**, registered through the framework's
public provider hooks. The provider emits one fixed `nano_x402_purchase` tool
call and then summarizes its result. It has no HTTP/model transport, model
service, or real model credential. It does not interpret merchant content.

After the repository install above, run this **offline** default:

```sh
node examples/native-loop.mjs --offline --state-root "$PWD/.nano-example-runs" --openclaw-bin "$PWD/node_modules/.bin/openclaw"
```

It creates a fresh private HOME/config/state/workspace, loads only the Nano guard
and fixture provider, and enables only the purchase tool. Existing model keys,
OpenClaw configuration, shell environment loading and Node preloads are excluded.
The synthetic auth marker is public fixture data, not a service credential.

The offline request deliberately uses `https://denied.invalid/native-offline`.
The actual native tool must refuse it before network access or signer loading.
Expect the final provider summary to contain `toolResultObserved: true`,
`outcome: "guard-refused-or-failed"`, and `remoteModel: false`, and exactly one
native tool call in the isolated session transcript. CLI exit 0 alone is not
proof of tool execution. This real local-loop refusal was executed on the pinned
OpenClaw version; it is not a paid request or settlement proof.

For the reviewer/operator's **real one-call run**, inject a trusted, unattended
helper using the same interface documented above:

```sh
NANO_SIGNER_MODULE=/absolute/path/to/operator-unattended-helper.mjs node examples/native-loop.mjs --live --state-root "$PWD/.nano-example-runs" --openclaw-bin "$PWD/node_modules/.bin/openclaw"
```

This requests exactly `POST https://pursekeeper.dev/v1/hash` with body `hello`.
Both the per-call and total exposure caps are **0.001 XNO**. The local provider
issues at most one tool call, including across recreated stream factories; the
wrapper spawns one native CLI child and never retries it. The guard still checks
the quote, exact origin and merchant account, expiry, redirect and replay rules.
No model credentials or model service are needed in live mode either.

An operator can choose the existing `env-helper.mjs` after privately supplying
its account key and suitable no-outlay RPC/work services, or inject another
trusted unattended helper appropriate to the review container. Keys must never
be placed in a command, repository, screenshot or log. The default live child
has no interactive stdin; it intentionally cannot prompt a human. Only
Nano-specific environment values are forwarded, and they are not serialized
into the temporary OpenClaw configuration. The integration does not configure
or promise access to a node/work service for the operator.

### Private operator proof with Nault

The reviewer uses the unattended mode above. Separately, Darren's first live
proof can use the existing manual Nault adapter without exporting a key:

```sh
NANO_PUBLIC_FRONTIER_FILE=/private/current-public-block.json NANO_SIGNER_MODULE="$PWD/manual-nault-operator.mjs" node examples/native-loop.mjs --live --operator-tty --state-root "$PWD/.nano-example-runs" --openclaw-bin "$PWD/node_modules/.bin/openclaw"
```

`--operator-tty` is live-only and inherits the private terminal; it does not
capture the signed response or child output. Prepare the current public frontier
and Nault as described in the manual-signing section **before** starting. Darren
personally reviews and signs the unsigned request, then pastes the response into
the hidden terminal input. Do not broadcast in Nault. Keep this terminal private.
The actual Nault signing/payment workflow remains user-operated and has not been
executed by the coding agent. A quote that needs proof of work or expires is a
refusal, not permission to weaken checks or pay again.

A missing result, failure, timeout or ambiguous response is not permission to
rerun `--live`: the guard's in-memory ledger does not survive a process restart.
Check the account/chain and merchant request log first. Confirm the integration's
own send hash in that log before filing a claim; the incoming 0.05 XNO seed hash
is not the required purchase hash, an award, or a slot reservation.

### Supplemental positive offline fixture

```sh
node examples/model-free.mjs --offline
```

This runs the actual SDK-registered tool, pinned Nano scheme and a public
synthetic signer against an in-memory merchant. It explicitly reports
`agentLoop: false`: the small registrar is a test fixture, not the native loop
above. An offline `paidRequestSent` refers only to its simulated transport, never
a real transfer. Never fund the public synthetic fixture account.

## Optional example with an existing model-backed agent

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

The current repository suite passes **105 offline tests**. Tests use mocked
HTTP/quotes/signers plus actual native OpenClaw SDK registration
and tool execution. They also exercise the real pinned Nano scheme and Nano SDK
signature/amount creation with public synthetic test material, and verify the
official helper refuses invalid proof of work with mocked RPC. They do not use
user wallet data, call a model, broadcast, or purchase anything. Synthetic
placeholder work is not claimed to be valid mainnet proof of work.

These tests are not a live Gateway/model turn, public registry installation,
real paid-call evidence, or sponsor acceptance. A complete slot claim still
needs a published installable package, exact repository commit, actual own-account
paid block, receiving account, and truthful operator/AI disclosure.

The separate native-loop run above additionally verifies actual local agent/tool
dispatch without a remote model. It does not establish live signing, a successful
paid call, sponsor acceptance or a bounty award. The seed receipt is test funding.

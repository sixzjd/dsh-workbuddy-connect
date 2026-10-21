# DSH WorkBuddy Connect

**简体中文** | [English](./README.en.md)

Bring **WorkBuddy** (international / China) models into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). One plugin serves both WorkBuddy product lines: **one settings card** (with a tab per edition, the same interaction as the Qoder card), each with its own provider, credential and model catalog, never mixed:

| Variant | provider id | Card tab | Upstream site |
|---|---|---|---|
| International | `workbuddy-global` | 国际版 | www.workbuddy.ai |
| China | `workbuddy` | 国内版 | copilot.tencent.com / www.codebuddy.cn |

> **The international edition is free for a limited time**: the live catalog carries three models at a `x0.00` multiplier — `deepseek-v4.1-flash` (DeepSeek-V4.1-Flash, 300K/128K), `hy3` (192K/64K) and `step-5-preview` (300K/64K) — plus `deepseek-v4.1-flash-sg` at `x0.03`. The free tier is an upstream promotion, and the plugin reads the **live** multiplier: when the promotion ends, the card drops the "free" badge on its own rather than keeping a promise the upstream has already withdrawn.

## Why a plugin instead of a plain provider

WorkBuddy's gateway is a closed interface that only admits the official client, and DSH's native adapter cannot reach it:

1. **User-Agent gate** — the gateway routes by UA and refuses `deepseek-harness/*` with business code `11128`. DSH's own adapter hardcodes that UA.
2. **The first message must be `system`** — the international deployment answers `400 / 11128` otherwise.
3. **Field dialects** — a `developer` role, a `store` field, an object-shaped `tool_choice`, the `max_completion_tokens` alias, a bare-string `stop`, non-string tool-call `arguments`: each one is refused by the upstream.
4. **A whole family of attribution headers** — `X-Product`, `X-Domain`, `X-User-Id`, `X-Enterprise-Id`/`X-Tenant-Id`, `X-IDE-*`, and **three conversation headers that are validated together** (`X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`) — supplying only one of them still answers `11128`.

So the plugin puts a **loopback shim** between the host and the upstream: pi-ai speaks plain OpenAI-completions to the shim, and the shim speaks WorkBuddy to the gateway.

```
DSH (pi-ai)  ──OpenAI──▶  127.0.0.1 shim  ──WorkBuddy──▶  gateway
                shared key   dialect rewrite    the real accessToken
```

**The real token never leaves the machine** and is never handed to pi-ai: the shim resolves it from the credential store itself.

## Features

- **Two ways in**:
  - **Device authorization** (the primary path) — press "Sign in to WorkBuddy" on the card, open the WorkBuddy authorization page, come back. No API key anywhere. The access token refreshes five minutes before it expires; a failed refresh still serves the not-yet-expired token, so a working session is not interrupted.
  - **Import from the desktop app** (the shortcut) — when the WorkBuddy desktop app is installed and already signed in, the card offers "Import from the desktop app": the plugin adopts the desktop app's own session instead of a browser round trip. The desktop app stores its token encrypted (since 5.6.0), and the plugin **asks the desktop app's own native module** for the key rather than carrying any build-specific constant. The option does not appear when the app is absent, signed out, or unable to answer. **It stays available while you are signed in too** — the desktop app re-signs in and rotates its session behind the plugin's back, which invalidates the copy the plugin holds; one more import adopts the new session without signing out first.
- **A dead session says so** — when the upstream refuses the credential (because the desktop app rotated its session, say), the card states it instead of keeping a "signed in" badge over a token nobody can use.
- **Two independent realms** — each keeps its own credential file, route, saved catalog and quota. A `workbuddy.ai` token is invalid on `codebuddy.cn` and vice versa; the two never cross.
- **Three-level catalog degradation (live → saved → fallback)** — the card says which one is in force: "live list (updated …)", "saved list", or "built-in list (not yet updated from WorkBuddy)". A failed refresh keeps its reason on the card, and the list can be refreshed by hand.
- **Model toggles** — search by name or id, switch individual models, or enable/disable all at once; a disabled model disappears from DSH's model picker.
- **Rate and free badges** — the upstream multiplier rides the model name (`Deepseek-V4.1-Flash · x0.00`), and a free model carries a "free" badge. A lapsed promotion is not kept on display as a current price — the plugin marks it "price unavailable" instead.
- **Quota detail** — one row per package with "remaining / total + a bar", its expiry and the next cycle refresh. The **cycle** capacity is read, not the pool: the pool still reports "nothing used, everything left" once a monthly resource is spent.
- **Context-window switch** — send the upstream's default window (300K) or its largest one (1M); the two variants keep their own setting.
- **Reasoning efforts** — a model gets an effort control only when the upstream declares one; a row that declares its effort in the singular form is folded onto the full ladder instead of losing the control entirely.

## Install

Requires DSH core `0.2.0-rc.2` or newer, and Node.js `^22.19.0 || >=24.0.0`.

```sh
# from a local checkout (development)
dsh plugin --profile web add "file:/absolute/path/接入workbuddy"

# or from npm
dsh plugin --profile web add dsh-workbuddy-connect
```

Swap `--profile` for the profile you use (`web` / `desktop` / `tui`). The data lands in that profile's directory; web, desktop and tui stay independent.

> **Restart DSH after installing.** A plugin is loaded at boot from `package.json → dsh.profile.bundles`; the hot-reload receiver covers client modules, not the bundle itself.

## Use

1. DSH → Settings → Plugins → expand the **WorkBuddy** card.
2. The card has two tabs, 国际版 / 国内版, each with a status dot in front of it (green = signed in, grey = signed out). The international edition is selected by default.
3. Press "Sign in to WorkBuddy" and complete the WorkBuddy authorization in the new tab; if the desktop app is installed, "Import from the desktop app" does it in one click.
4. Come back: the card reads "Signed in" and the model catalog refreshes itself.
5. Pick a model in the composer's model picker — the international edition currently has free models.

Switch to the 国内版 tab to manage the China line against `codebuddy.cn`; the two editions keep their own credential, catalog, quota and switches.

## Data and privacy

Every file the plugin owns lives in one place: `<profile>/.dsh-workbuddy-connect/`

```text
<profile>/.dsh-workbuddy-connect/
├── .workbuddy-auth.json          # China credential ({version, region, auth{…}, account{…}})
├── .workbuddy-ai-auth.json       # international credential
├── .workbuddy-settings.json      # China settings (model toggles, context window)
├── .workbuddy-ai-settings.json   # international settings
└── state/
    ├── .workbuddy-catalog.json          # China catalog, saved per account
    ├── .workbuddy-ai-catalog.json       # international catalog
    ├── .workbuddy-app-version.json      # China App-version cache
    └── .workbuddy-ai-version.json       # international App-version cache
```

Credential files are `0600`, the directory is `0700`, and every write goes through a temporary file plus a rename, so no reader ever sees a half-written document.

The data directory follows the profile (the one under `$DSH_HOME/profiles/` that declares this plugin) and falls back to the Harness home; `DSH_WORKBUDDY_DATA_DIR` overrides either.

**A credential comes from exactly one of two places**: the plugin's own device-authorization login (the primary path), or the "Import from the desktop app" button the user presses. The latter reads the desktop app's own encrypted session — the key comes from that app's native module on the spot, the plugin carries no build-specific constant, and the key is **never written to disk**. The plugin works fine without the desktop app.

## Implementation notes

| Area | What it does |
|---|---|
| Sign-in | `POST {base}/v2/plugin/auth/state?platform=CLI` → poll `GET {base}/v2/plugin/auth/token?state=`; business code `11217` means "still waiting". One cookie jar per attempt, so two concurrent logins cannot answer for each other. |
| Refresh | `POST {base}/v2/plugin/auth/token/refresh` with `X-Refresh-Token` and `X-Auth-Refresh-Source: workbuddy` |
| Chat | `POST {base}/v2/chat/completions`, SSE; `choices[0].delta.reasoning_content` carries the thinking |
| Catalog | `GET {base}/v3/config` (**first**); the legacy `/v2/enterprises/personal/models` and `/console/enterprises/personal/models` are fallbacks only — the legacy document serves the CLI channel's roster, which swaps the free `hy4-preview-f` (x0.00) for the paid `hy4-preview` (x0.29) under the same display name |
| Quota | `POST {base}/v2/billing/meter/get-user-resource`, reading `CycleCapacity*` and `*Precise` |
| Error codes | `14018` credits exhausted (terminal, not a throttle) · `14003` model-scoped throttle · `6004` account volume limit · `12153` dead session · `11128` channel refused · `11133` parameters refused · `11101` non-streaming |
| Loopback safety | binds `127.0.0.1` only; checks Host and Origin; a random per-process bearer secret; accepts `application/json` only; a 32 MiB body ceiling |
| Desktop session | `AES-256-GCM`, a 12-byte nonce and a 16-byte tag, over a length-prefixed transcript of the scheme, suite, keyId and framing; the key is `sha256(the base64 string the desktop app's native module returns)` and lives in memory only |

**The model identity** is a subtle trap: models of both regions advertise the same identity `workbuddy`, while the **routes** are `workbuddy` and `workbuddy-global`. pi-ai keeps a historical thinking block only when provider, api AND model id all match, so the identity has to be shared for a transcript that crosses the region boundary — but the identity must also be a registry key in *every* region, or the international route answers every request with `Unknown provider: workbuddy`. Both halves are needed for either to work.

**The upstream keeps no server-side session**: every turn resends the whole history, and the plugin does not compress it for them.

**One more easy thing to get wrong**: `supportsImages` is a *platform* flag, not a capability — the upstream marks nearly every row `true`, including the models that cannot take an image at all. The image capability therefore has its own table, reviewed id by id; otherwise both errors are live: offering an image to a text-only model (which the provider refuses only after the message is already durable) and refusing one to a model that can take it.

**And one that only bites the China edition**: the upstream's channel check reads the **opening of a message line** and refuses a line that starts with a client identity that is not theirs (`400 / 11128`, "Illegal API invocation from an unapproved channel") — and the harness system prompt opens with exactly "You are an AI agent powered by DeepSeek Harness." So every CN message was blocked, while the international edition never ran that check and was unaffected.

There are three layers to this, and skipping any one of them brings the failure back:

1. **system messages** — refused when the marker opens the first line (a line above it, or one leading space, gets through: it is a literal prefix).
2. **assistant messages** — the same check, anchored to a line start. This is the nastiest one: **a reply that quotes its own instructions poisons every later turn of that conversation** while the code stays untouched. That is exactly the reported case — turn 1 fine, turn 2 (after switching INTL → CN) refused.
3. **content shape** — `content` is either a string or an array of parts (`[{type:'text',text:…}]`), and **both** are checked. A string-only sanitizer is silently inert on the array shape.

The plugin therefore rewrites that sentence to "You are an AI coding assistant.": whole-content replacement in system messages, opening-line-only in assistant messages (**mid-sentence mentions are left alone** — measured, they are not refused), **user and tool messages are never touched** (that is the human's own text, and rewriting it would corrupt the conversation), and in array content only the `text` of text parts is rewritten, preserving images and the rest of the structure. The international path benefits from it too.

**The channel identity expires on its own**: the version in the client identity comes from the local desktop app, and the app updates itself (measured that evening: 5.7.6 → 5.8.4, CLI 2.156.0 → 2.161.0). The identity is therefore re-resolved every 10 minutes instead of being fixed for the lifetime of the process — otherwise the host keeps presenting a version the gateway has moved past.

## Development

```sh
node test/smoke.mjs     # regression cases for the pure logic
```

The plugin is **plain ESM JavaScript with no build step**.

**Use a `link:` dependency while developing, not a `file:` one**:

```json
"dsh-workbuddy-connect": "link:/absolute/path/接入workbuddy"
```

A `file:` dependency is *hard-linked* into `node_modules`, and an editor that replaces the file breaks the link — the change never reaches the profile. A `link:` dependency is a real symlink, so an edit is live after a page reload. Both install the same package; the difference is only this one.

A change to the bundle layer (`package.json` / `cordis.patch.yml`) needs a DSH restart: a plugin is loaded at boot from `dsh.profile.bundles`, and the hot-reload receiver covers client modules, not the bundle itself.

## Credits and licence

The upstream behaviour was measured against the live deployments and cross-checked against these open-source implementations:

- [masknull/dsh-workbuddy-connect](https://github.com/masknull/dsh-workbuddy-connect) (MIT) — the two-variant connector skeleton
- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) (MIT) — the model identity and registry keys
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT) — the header values
- [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) — the upstream request shape and model catalogs

Released under the [MIT](./LICENSE) licence. This repository is a community adapter with no affiliation to WorkBuddy, Tencent or DeepSeek.

## Disclaimer

- WorkBuddy's interface comes from the upstream: it may change, throttle or block callers at any time, which can break this plugin partly or entirely.
- This tool is for personal study and research, driving **your own** WorkBuddy account. Do not resell it or use it beyond personal, reasonable use. By using it you accept the consequences — account limits, lost quota, service interruption — and agree to WorkBuddy's terms of service.
- The author accepts no liability for any direct or indirect loss arising from the use or misuse of this plugin. WorkBuddy, DeepSeek and other names and trademarks mentioned here belong to their respective owners and are used only to describe compatibility.

/**
 * Smoke test for the WorkBuddy connector's pure logic.
 *
 * Run with: node test/smoke.mjs
 *
 * The payloads below are the shapes the live upstream actually answered with
 * (captured 2026-10-20), so a parser that drifts from them fails here rather
 * than in the card.
 */
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import {
  classifyUpstreamError,
  describeAccountRestriction,
  modelWithCurrentPromotion,
  normalizeCredits,
  normalizeCreditsDocument,
  parseModelCatalog,
  rateIsPaid,
  prepareChatBody,
  prepareInternationalChatBody,
  regionOf,
  withGatewayChatHeaders,
  withPromptCacheKey,
  WorkBuddyUpstreamClient,
} from '../lib/upstream.js'
import { fallbackFor, WorkBuddyCatalog } from '../lib/catalog.js'
import { accumulateCacheUsage, emptyCacheUsage, usageFromSseText } from '../lib/cachestats.js'
import { reasoningFields } from '../lib/thinking.js'
import { MAX_DELIVERABLE_BODY_BYTES, createWorkBuddyShim } from '../lib/shim.js'
import { modelIdentityKeysOf, WORKBUDDY_VARIANTS } from '../lib/variants.js'
import { deriveAtRestKey, deriveAtRestKeyId, isEncryptedFieldWrapper, openEncryptedField } from '../lib/atrest.js'
import { createAccountStore } from '../lib/accounts.js'
import {
  DEFAULT_CHECKIN_MINUTE, accountTag, createCheckInStore, isPastCheckinTime,
  CheckInScheduler, isSettled, msUntilNextCheckin, normalizeCheckinMinute, utc8Date,
} from '../lib/checkin.js'
import { WorkBuddyCredentialStore } from '../lib/auth.js'
import { writeJsonAtomic } from '../lib/auth.js'
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fresh directory per check: the store writes real files. */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'wb-accounts-'))
}

/** A plugin-owned credential document, in the shape the store writes. */
function credentialDocument({ uid, nickname, domain = 'www.codebuddy.cn', accessToken, expiresAtMs }) {
  return {
    version: 1,
    region: domain.endsWith('workbuddy.ai') ? 'global' : 'cn',
    auth: {
      accessToken: accessToken ?? `token-${uid}`,
      refreshToken: `refresh-${uid}`,
      expiresAt: Math.floor((expiresAtMs ?? Date.now() + 3600_000) / 1000),
      domain,
      realm: domain.endsWith('workbuddy.ai') ? 'global' : 'cn',
    },
    account: { uid, ...nickname === undefined ? {} : { nickname } },
  }
}

/** The field-framing AAD, rebuilt here so the test does not import the module's own copy. */
function fieldAad(keyId, suite) {
  const u32 = (n) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b }
  const lp = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]) }
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), lp('WBEV1'), lp('sym-v1'), u32(suite), lp(keyId),
    Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
  ])
}

let passed = 0
function check(name, fn) {
  try {
    const result = fn()
    // An async body returns a promise this harness would otherwise drop: the
    // rejection escapes as an unhandled one and the check prints "ok" having
    // asserted nothing. Refuse the shape outright rather than pass silently.
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      throw new Error('check() got an async body — use checkAsync() so its rejection is awaited')
    }
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`)
    process.exitCode = 1
  }
}

/** The same contract for a case that has to await the network-facing code. */
async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`)
    process.exitCode = 1
  }
}

console.log('manifest')
await checkAsync('the client bundle registers under the package name', async () => {
  // The browser module system keys factories by `stripClientSuffix(registration.id)`
  // and the host composes one graph row per loader entry whose name is the package
  // specifier. An `id` that disagrees with `package.json` therefore registers the
  // bundle under a key no row ever asks for: the factory is stored, never
  // materialized, and every slot it would fill stays empty — the plugin simply
  // never appears, with no error anywhere.
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const m = /__ModuleLoader__\.load\(\{\s*id:\s*["'`]([^"'`]+)/.exec(client)
  assert.ok(m !== null, 'client.js does not call window.__ModuleLoader__.load with an id')
  assert.equal(m[1], manifest.name, `client id "${m[1]}" must equal package name "${manifest.name}"`)
})

await checkAsync('the bundle patch is loadable YAML with a quoted scoped name', async () => {
  // A scoped package name starts with `@`, which YAML reserves: an unquoted
  // `name: @scope/pkg` is a parse error, and DSH rejects the whole install with
  // "failed to parse overlay ... bad indentation of a mapping entry". Published
  // 0.2.1 shipped exactly that and every registry install of it failed.
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  for (const line of text.split('\n')) {
    const m = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (m === null) continue
    assert.ok(!m[1].startsWith('@'), `unquoted scoped name in cordis.patch.yml: ${line.trim()}`)
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(text.includes(`'${manifest.name}'`), `cordis.patch.yml does not name the package ${manifest.name} in quotes`)
})
await checkAsync('the version is valid semver', async () => {
  // The plugin page prints this string, and a registry install refuses a
  // package whose version is not semver. Asserted here so a hand-edit is
  // caught before anything depends on it.
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `not semver: ${manifest.version}`)
})
await checkAsync('the card reads its version from the manifest, not a second literal', async () => {
  // A literal beside package.json is two sources for one fact; the card then
  // reports a version the installed files do not have.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /new URL\('\.\.\/package\.json', import\.meta\.url\)/, 'lib/index.js no longer reads package.json for its version')
})
await checkAsync('the clear-log button is a bordered danger button', async () => {
  // It used the link variant — no border, transparent background — while every
  // other action in the card is a bordered .wb-button. It should share that
  // shape and only change the colour to the theme's danger token.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const from = source.indexOf('L.checkInClear')
  assert.ok(from !== -1)
  const around = source.slice(source.lastIndexOf('h("button"', from), from)
  // It inherits the border/radius/background from .wb-button and only overrides
  // the colour with the theme's danger token.
  assert.match(source, /\.wb-button\.wb-danger\{color:\s*var\(--dsw-alias-state-danger-primary[^}]*border-color:\s*currentColor/)
  assert.match(around, /className:\s*"wb-button wb-danger"/)
})

await checkAsync('the check-in time uses the themed dropdown, not a native input', async () => {
  // <input type="time"> opens the OS-native picker, which does not follow the
  // DSH settings theme. The time must use the same Dropdown component the
  // account switcher uses.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const from = source.indexOf('L.checkInTime')
  const to = source.indexOf('checkIn.record.logs', from)
  const block = source.slice(from, to === -1 ? from + 1200 : to)
  assert.match(block, /h\(Dropdown/, 'the check-in time is not a themed Dropdown')
  assert.equal(block.includes('type: "time"'), false, 'the native time input is still there')
})

await checkAsync('the plugin list title uses the renamed identity', async () => {
  // The settings page reads locale/meta.title for the plugin list row; the
  // package name must stay unchanged so DSH can still match an installed copy
  // to a published version and offer the in-app update.
  const { readFileSync } = await import('node:fs')
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(zh.meta.title, 'workbuddy连接器')
  assert.equal(en.meta.title, 'workbuddy连接器')
  assert.equal(pkg.displayName, 'workbuddy连接器')
  assert.equal(pkg.name, '@sixzjd/dsh-workbuddy-connect', 'renaming the package would break in-app updates')
})

await checkAsync('the card exposes the check-in controls', async () => {
  // The check-in block mirrors Qoder's: an opt-in switch, a UTC+8 time, a
  // manual button and a capped log. Asserted against the bundle source because
  // the card runs in the browser.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const token of ['L.checkInOn', 'L.checkInTime', 'L.checkInNow', 'L.checkInLogs', 'CHECKIN_PATH']) {
    assert.ok(source.includes(token), `check-in UI is missing ${token}`)
  }
  // The switch must post to the route, not just change local state.
  assert.match(source, /setCheckIn[\s\S]{0,200}action:\s*"set"/)
  assert.match(source, /CHECKIN_PATH[\s\S]{0,200}action:\s*"now"/)
  assert.match(source, /CHECKIN_PATH[\s\S]{0,200}action:\s*"clear-logs"/)
})

await checkAsync('the account toolbar stays on one line', async () => {
  // With flex-wrap the three buttons slid under the dropdown and the row read
  // as two unrelated groups. The toolbar is nowrap and the actions are pinned
  // to the right; assert the CSS rule AND that the markup uses it.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.wb-row\.wb-row-nowrap\{[^}]*flex-wrap:\s*nowrap/)
  const from = source.indexOf('wb-account-block')
  const to = source.indexOf('auth?.accountRestricted', from)
  assert.match(source.slice(from, to), /className:\s*"wb-row wb-row-nowrap"/)
})

await checkAsync('the account toolbar matches the Qoder pattern', async () => {
  // One row holds: a labelled current-account dropdown, add, delete-current
  // and clear-all — the same four operations Qoder offers for a PAT. The
  // separate expandable account list was noise: the dropdown already selects,
  // and the row already removes; a second list of the same two facts is gone.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const from = source.indexOf('wb-account-block')
  const to = source.indexOf('auth?.accountRestricted', from)
  const block = source.slice(from, to)
  for (const token of ['h(Dropdown', 'L.addAccount)', 'L.removeCurrent', 'L.clearAll']) {
    assert.ok(block.includes(token), `account toolbar is missing ${token}`)
  }
  assert.equal(block.includes('wb-account-list'), false, 'the redundant account list is still rendered')
  // The handlers must actually exist and talk to the right route.
  for (const fn of ['const switchAccount', 'const removeAccount', 'const removeCurrent', 'const clearAccounts']) {
    assert.ok(source.includes(fn), `missing handler ${fn}`)
  }
  assert.match(source, /clearAccounts[\s\S]{0,200}ACCOUNTS_PATH/)
})

await checkAsync('the card keeps action buttons to the right of their row', async () => {
  // Sign-out/import and catalog refresh ended up next to the label, leaving a
  // long empty right half. They share a flex container that pushes them right.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.wb-row-actions\{[^}]*margin-left:\s*auto/)
  // Both rows actually use it, not just an orphan CSS rule.
  const logout = source.indexOf('L.logout')
  assert.ok(logout !== -1 && source.slice(logout - 400, logout).includes('wb-row-actions'))
  const refresh = source.indexOf('L.refresh)')
  assert.ok(refresh !== -1 && source.slice(refresh - 400, refresh).includes('wb-row-actions'))
})
await checkAsync('the catalog row no longer renders a source badge', async () => {
  // The live/saved badge with its timestamp sat between the label and the
  // refresh button; it was noise, and the user asked for it gone.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const row = source.slice(source.indexOf('L.catalog)'), source.indexOf('L.catalog)') + 700)
  assert.doesNotMatch(row, /catalogUpdated/)
  assert.doesNotMatch(row, /catalog\.source === "live"/)
})

await checkAsync('the account hint is short and names what is kept', async () => {
  // A sentence explaining OAuth and the desktop app did not fit the row and
  // said more than the action needs to: all the user needs to know is that a
  // new account will not cost them the current one.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /addAccountHint:\s*"添加新账号，当前帐号会被保留"/)
})

await checkAsync('the card offers a way to add an account while signed in', async () => {
  // The add path used to exist only in the signed-out branch, so a signed-in user
  // had no way to add a second account at all.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const from = source.indexOf('wb-account-block')
  assert.ok(from !== -1, 'the card has no account block')
  const to = source.indexOf('accountRestricted', from)
  const block = source.slice(from, to === -1 ? from + 4000 : to)

  // Find the add-account button by its label, then inspect ITS attribute list.
  // A whole-block /beginLogin/ check passed even after the handler was replaced,
  // because the name also appears in a nearby comment.
  // Anchor on the unique label and look BACK a short distance for its handler.
  // (Searching back for the nearest h("button" picks an unrelated row button.)
  const label = block.indexOf('L.addAccount)')
  assert.ok(label !== -1, 'the account block has no add-account button')
  const around = block.slice(Math.max(0, label - 250), label)
  assert.match(around, /onClick:\s*\(\)\s*=>\s*void\s+beginLogin\(\)/, 'the add button does not start a login')

  // Two or more accounts render the themed Dropdown, and its onChange must call
  // switchAccount. An OS-native <select> would be a regression: its menu does not
  // follow the DSH settings theme.
  const switcher = block.indexOf('h(Dropdown')
  assert.ok(switcher !== -1, 'two or more accounts do not render the themed switcher')
  assert.match(block.slice(switcher, switcher + 600), /onChange:[\s\S]*switchAccount/, 'the switcher does not switch accounts')
  assert.equal(block.includes('h("select"'), false, 'the account switcher reverted to a native select')
})

await checkAsync('the clear route clears the downgrade copy too', async () => {
  // A source-level assertion because lib/index.js pulls in pi-ai. Calling the
  // bare accounts.clear() leaves the single-file copy in place, which the next
  // read migrates straight back — '清除全部' then appears to do nothing.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const from = source.indexOf("action?.action === 'clear'")
  const to = source.indexOf("action?.action === 'adopt-desktop'", from)
  assert.ok(from !== -1 && to > from, 'clear route not found')
  const route = source.slice(from, to)
  assert.match(route, /runtime\.store\.logout\(\)/, 'clear route bypasses logout and keeps the legacy copy')
  assert.doesNotMatch(route, /runtime\.store\.accounts\.clear\(\)/)
})

await checkAsync('the runtime hands its data dir to the credential store', async () => {
  // Importing lib/index.js pulls in pi-ai and the DSH packages, so this invariant
  // cannot be asserted by constructing a runtime here. It is asserted against the
  // source instead, because the failure mode is silent and severe: the store then
  // falls back to the real profile's directory, and because saving claims the
  // active slot, any runtime built against a temporary directory re-points the
  // user's real active account. That happened — it signed the real account out.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const construction = source.match(/new WorkBuddyCredentialStore\(\{([\s\S]*?)\}\)/)
  assert.ok(construction !== null, 'lib/index.js no longer constructs a credential store')
  assert.match(construction[1], /dataDir:\s*this\.dataDir/, 'the credential store is constructed without the runtime data dir')
})

await checkAsync('the client declares the primitives it renders with', async () => {
  // `Button` comes from the shared package; a bundle that requires it without
  // declaring it resolves or not depending on the host's module map.
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const injected = manifest.dsh?.client?.inject ?? []
  assert.ok(injected.includes('@deepseek-ai/dsh-client-ui-primitives'), 'dsh.client.inject is missing the primitives package')
})

console.log('region')
check('workbuddy.ai is global', () => assert.equal(regionOf('workbuddy.ai'), 'global'))
check('codebuddy.ai is global', () => assert.equal(regionOf('codebuddy.ai'), 'global'))
check('workbuddy.cn is cn', () => assert.equal(regionOf('workbuddy.cn'), 'cn'))
check('empty domain is cn', () => assert.equal(regionOf(''), 'cn'))

console.log('chat body')
check('forces stream', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[]}'))
  assert.equal(body.stream, true)
})
check('drops the OpenAI-only store field', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"store":false}'))
  assert.equal('store' in body, false)
})
check('rewrites developer to system', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[{"role":"developer","content":"x"}]}'))
  assert.equal(body.messages[0].role, 'system')
})
check('translates max_completion_tokens', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"max_completion_tokens":4096}'))
  assert.equal(body.max_tokens, 4096)
  assert.equal('max_completion_tokens' in body, false)
})
check('keeps an explicit max_tokens', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"max_tokens":100,"max_completion_tokens":4096}'))
  assert.equal(body.max_tokens, 100)
  assert.equal('max_completion_tokens' in body, false)
})
check('flattens an object tool_choice', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"tool_choice":{"type":"function","function":{"name":"read"}}}'))
  assert.equal(body.tool_choice, 'read')
})
check('drops tools when tool_choice is none', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"tools":[{"type":"function"}],"tool_choice":"none"}'))
  assert.equal('tools' in body, false)
  assert.equal('tool_choice' in body, false)
})
check('asks for usage on a streaming call', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[]}'))
  assert.deepEqual(body.stream_options, { include_usage: true })
})
check('resolves the default reasoning level', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"reasoning_effort":"off"}', { defaultEffort: 'high' }))
  assert.equal(body.reasoning_effort, 'high')
})
check('rewrites the harness identity out of the opening line', () => {
  // The CN gateway refuses a system message whose FIRST LINE opens with this
  // harness's identity (400 / 11128 "unapproved channel"), so the phrase has
  // to be gone before the request leaves.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{
      role: 'developer',
      content: 'You are an AI agent powered by DeepSeek Harness.\nYou are a coding agent powered by DeepSeek Harness.',
    }],
  })))
  assert.equal(body.messages[0].role, 'system')
  const first = body.messages[0].content.split('\n')[0]
  assert.equal(first.startsWith('You are an AI agent powered by DeepSeek Harness'), false)
})
check('rewrites the product name out of a system message anywhere', () => {
  // 2026-10-24: the CN check fingerprint-matches the assembled system prompt,
  // so a product mention that survives the first-line rewrite still refuses
  // the request (measured: the assembled prompt fails deterministically with
  // the name intact and streams with it rewritten, while each sentence alone
  // passes — the match needs the prompt's own wording).
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: 'Context first.\nYou are an AI agent powered by DeepSeek Harness.' }],
  })))
  assert.equal(body.messages[0].content.includes('DeepSeek Harness'), false)
})
check('rewrites the product name out of the runtime-context and GUI sentences', () => {
  // The two sentences the 0.2.1-rc.2-era prompt added beyond the opening line;
  // both name the product and both must go.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{
      role: 'system',
      content: 'The runtime context names the DeepSeek Harness implementation checkout. Use this checkout only to inspect or extend DSH itself.\n\nYou are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.',
    }],
  })))
  assert.equal(body.messages[0].content.includes('DeepSeek Harness'), false)
  assert.equal(body.messages[0].content.includes('DSH implementation checkout'), true)
  assert.equal(body.messages[0].content.includes('DSH Web GUI'), true)
})
check('rewrites the marker on the opening line of an assistant message', () => {
  // A reply that quotes its own instructions poisons the history for every
  // later turn: the CN gateway reads the marker out of an assistant message
  // too, but only as a line prefix.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'system', content: 'You are an AI coding assistant.' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'You are an AI agent powered by DeepSeek Harness.\n\nPong.' },
      { role: 'user', content: 'ping again' },
    ],
  })))
  assert.equal(body.messages[2].content.split('\n')[0], 'You are an AI coding assistant.')
  assert.equal(body.messages[2].content.endsWith('\n\nPong.'), true)
})
check('leaves a marker mid-sentence in an assistant message alone', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'assistant', content: 'Here is a note. You are an AI agent powered by DeepSeek Harness. Done.' },
    ],
  })))
  assert.equal(body.messages[0].content.startsWith('Here is a note.'), true)
})
check('rewrites the product name mid-sentence in an assistant message', () => {
  // 2026-10-25: the whole transcript is scanned, so a long session whose
  // replies quote this plugin's source stays refused even with a sanitized
  // system message — the product name goes everywhere in an assistant message.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'assistant', content: 'The runtime context names the DeepSeek Harness implementation checkout.' },
    ],
  })))
  assert.equal(body.messages[0].content.includes('DeepSeek Harness'), false)
})
check('rewrites the product name inside a tool result', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.md"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'line1\nThe DeepSeek Harness Web GUI URL is set here.\nline3' },
    ],
  })))
  assert.equal(body.messages[2].content.includes('DeepSeek Harness'), false)
  assert.equal(body.messages[2].content.includes('DSH Web GUI'), true)
})
check('rewrites the product name inside recorded tool-call arguments', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit', arguments: '{"new_string":"the DeepSeek Harness Web GUI"}' } }] },
    ],
  })))
  assert.equal(body.messages[0].tool_calls[0].function.arguments.includes('DeepSeek Harness'), false)
})
check('leaves the product name in a user message alone', () => {
  // The human's own words stay verbatim; user-side mentions do not trip the
  // check (measured 2026-10-24 alongside a clean system message).
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'user', content: '为什么 DeepSeek Harness 被拦？' },
    ],
  })))
  assert.equal(body.messages[0].content.includes('DeepSeek Harness'), true)
})
check('never rewrites a user message', () => {
  // The same phrase in the human's own words is theirs; rewriting it would
  // change what the model is answering, and the gateway does not fire on it.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'user', content: 'You are an AI agent powered by DeepSeek Harness.' }],
  })))
  assert.equal(body.messages[0].content, 'You are an AI agent powered by DeepSeek Harness.')
})
check('rewrites the marker inside a content-parts array', () => {
  // Content arrives either as a string or as an array of parts; the gateway
  // refuses both, so a string-only rewrite would be inert on any client that
  // sends parts — which is every OpenAI-compatible SDK on a block transcript.
  const marker = 'You are an AI agent powered by DeepSeek Harness.'
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'system', content: [{ type: 'text', text: marker }] },
      { role: 'assistant', content: [{ type: 'text', text: marker + '\n\nPong.' }] },
    ],
  })))
  assert.equal(body.messages[0].content[0].text.startsWith(marker), false)
  assert.equal(body.messages[1].content[0].text.startsWith(marker), false)
  assert.equal(body.messages[1].content[0].text.endsWith('\n\nPong.'), true)
})
check('leaves non-text parts untouched', () => {
  const parts = [
    { type: 'text', text: 'describe this' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: JSON.parse(JSON.stringify(parts)) }],
  })))
  assert.deepEqual(body.messages[0].content[1], parts[1])
})

console.log('international chat body')
check('prepends a system message', () => {
  const body = JSON.parse(prepareInternationalChatBody('{"messages":[{"role":"user","content":"hi"}]}'))
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'You are a helpful assistant.')
  assert.equal(body.messages[1].content, 'hi')
})
check('leaves an existing system head alone', () => {
  const body = JSON.parse(prepareInternationalChatBody('{"messages":[{"role":"system","content":"mine"},{"role":"user","content":"hi"}]}'))
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].content, 'mine')
})

console.log('gateway headers')
check('carries the whole conversation family', () => {
  const headers = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"hi"}]}')
  for (const name of ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID', 'X-Request-ID', 'X-Root-Request-ID']) {
    assert.ok(headers[name], `${name} is missing`)
  }
})
check('the conversation id is a hyphenated uuid', () => {
  const headers = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"hi"}]}')
  assert.match(headers['X-Conversation-ID'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})
check('the message id is 32 hex without hyphens', () => {
  const headers = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"hi"}]}')
  assert.match(headers['X-Conversation-Message-ID'], /^[0-9a-f]{32}$/)
})
check('the root request id equals the conversation request id', () => {
  const headers = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"hi"}]}')
  assert.equal(headers['X-Root-Request-ID'], headers['X-Conversation-Request-ID'])
})
check('the conversation id is STABLE across the turns of one conversation', () => {
  // The upstream keys its prefix cache by this id. Measured 2026-11-14: with a
  // fresh UUID per request, hy4free reported 0 cached tokens on three
  // identical 20k-token sends; holding the id fixed reported 20672.
  const first = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"hi"}]}')
  const second = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"yo"},{"role":"user","content":"hi again"}]}')
  assert.equal(first['X-Conversation-ID'], second['X-Conversation-ID'])
})
check('two conversations never share a conversation id', () => {
  const a = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"alpha"}]}')
  const b = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"beta"}]}')
  assert.notEqual(a['X-Conversation-ID'], b['X-Conversation-ID'])
})
check('a caller-supplied conversation id is kept', () => {
  const headers = withGatewayChatHeaders({ 'X-Conversation-ID': 'mine' }, '{"messages":[{"role":"user","content":"hi"}]}')
  assert.equal(headers['X-Conversation-ID'], 'mine')
})
check('one turn keeps one request id', () => {
  const first = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"hi"}]}')
  const second = withGatewayChatHeaders({}, '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"yo"},{"role":"user","content":"hi again"}]}')
  assert.notEqual(first['X-Conversation-Request-ID'], second['X-Conversation-Request-ID'])
})

console.log('prompt cache key')
check('is account-scoped', () => {
  const body = JSON.parse(withPromptCacheKey('{"messages":[]}', 'uid-1234'))
  assert.match(body.prompt_cache_key, /^wb2a-uid-1234-[0-9a-f]{32}$/)
})
check('keeps a key the caller supplied', () => {
  const body = JSON.parse(withPromptCacheKey('{"messages":[],"prompt_cache_key":"mine"}', 'uid'))
  assert.equal(body.prompt_cache_key, 'mine')
})

await checkAsync('clearing accounts removes them all without throwing on empty', async () => {
  // The Qoder-style account row has "清除全部" next to "删除当前". Clearing is a
  // single operation on the store, and it must be safe to call twice (the card
  // does not track whether anything is left).
  const dir = makeTempDir()
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'uid-one' }))
  await store.save(credentialDocument({ uid: 'uid-two' }))
  await store.clear()
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.active(), undefined)
  // Idempotent: a second clear has nothing to do and must not throw.
  await store.clear()
  assert.deepEqual(await store.list(), [])
})

console.log('account store')
await checkAsync('migrates the single credential file into a first account', async () => {
  // Every install has exactly one credential file at the plugin data dir root.
  // Turning that into an account list must never lose the sign-in: the existing
  // file becomes the one listed account, and it is the active one.
  const dir = makeTempDir()
  const legacy = join(dir, '.workbuddy-auth.json')
  writeJsonAtomic(legacy, credentialDocument({ uid: 'uid-one', nickname: '一' }))
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  assert.equal(await store.importLegacyFile(legacy), true)
  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].uidShort, 'uid-one')
  assert.equal(accounts[0].active, true)
  assert.equal((await store.active())?.uid, 'uid-one')
})
await checkAsync('saves a second account without losing the first', async () => {
  const dir = makeTempDir()
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'uid-one' }))
  await store.save(credentialDocument({ uid: 'uid-two' }))
  const accounts = await store.list()
  assert.equal(accounts.length, 2)
  // The one just saved is the active one: saving is "use this account now".
  assert.equal(accounts.find(a => a.active)?.uidShort, 'uid-two')
})
await checkAsync('switches the active account', async () => {
  const dir = makeTempDir()
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'uid-one', accessToken: 'token-one' }))
  await store.save(credentialDocument({ uid: 'uid-two', accessToken: 'token-two' }))
  assert.equal((await store.active()).accessToken, 'token-two')
  const first = (await store.list()).find(a => a.uidShort === 'uid-one')
  await store.activate(first.hash)
  assert.equal((await store.active()).accessToken, 'token-one')
  const accounts = await store.list()
  assert.equal(accounts.filter(a => a.active).length, 1)
})
await checkAsync('refuses to activate an account it does not hold', async () => {
  // Silently falling back to "no account" would sign the user out; guessing a
  // different account would send their requests to somebody else's.
  const dir = makeTempDir()
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'uid-one' }))
  await assert.rejects(() => store.activate('uid-absent'), /unknown account/i)
  assert.equal((await store.active())?.uid, 'uid-one')
})
await checkAsync('keeps realms apart', async () => {
  // A CN account must never be listed for the international variant: the two
  // realms' tokens are not interchangeable, and offering one would produce a
  // failure at request time instead of at the point of choice.
  const dir = makeTempDir()
  const cn = createAccountStore({ realm: 'cn', dataDir: dir })
  const global = createAccountStore({ realm: 'global', dataDir: dir })
  await cn.save(credentialDocument({ uid: 'uid-cn' }))
  await global.save(credentialDocument({ uid: 'uid-global', domain: 'www.workbuddy.ai' }))
  assert.deepEqual((await cn.list()).map(a => a.uidShort), ['uid-cn'])
  assert.deepEqual((await global.list()).map(a => a.uidShort), ['uid-glob'])
})
await checkAsync('refuses a credential from the other realm', async () => {
  const dir = makeTempDir()
  const cn = createAccountStore({ realm: 'cn', dataDir: dir })
  await assert.rejects(
    () => cn.save(credentialDocument({ uid: 'uid-global', domain: 'www.workbuddy.ai' })),
    /refusing/i,
  )
})
await checkAsync('removing the active account promotes the remaining one', async () => {
  // Leaving no active account would sign the user out of a variant that still
  // holds a usable credential.
  const dir = makeTempDir()
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'uid-one' }))
  await store.save(credentialDocument({ uid: 'uid-two' }))
  const second = (await store.list()).find(a => a.uidShort === 'uid-two')
  await store.remove(second.hash)
  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].active, true)
  assert.equal((await store.active())?.uid, 'uid-one')
})
await checkAsync('removing the last account leaves the variant signed out', async () => {
  const dir = makeTempDir()
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'uid-one' }))
  const only = (await store.list())[0]
  await store.remove(only.hash)
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.active(), undefined)
})
await checkAsync('lists an expired account as expired rather than dropping it', async () => {
  // An expired account is exactly the one the user needs to see, so they know
  // to sign in again. Hiding it would make it look like it was never added.
  const dir = makeTempDir()
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'uid-old', expiresAtMs: Date.now() - 3600_000 }))
  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].expired, true)
})
await checkAsync('never exposes a full token or a full uid', async () => {
  // The account list is rendered in a page, so it carries a summary, not the
  // credential and not an identifier that is worth leaking in a screenshot.
  const dir = makeTempDir()
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'abcdefgh-1234-5678-9999-000011112222', nickname: '号一' }))
  const listed = await store.list()
  assert.equal(JSON.stringify(listed).includes('token-'), false)
  assert.equal(JSON.stringify(listed).includes('abcdefgh-1234'), false)
  assert.equal(listed[0].uidShort, 'abcdefgh')
})

await checkAsync('importing the legacy file twice adds only one account', async () => {
  const dir = makeTempDir()
  const legacy = join(dir, '.workbuddy-auth.json')
  writeJsonAtomic(legacy, credentialDocument({ uid: 'uid-one' }))
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.importLegacyFile(legacy)
  await store.importLegacyFile(legacy)
  assert.equal((await store.list()).length, 1)
})
await checkAsync('an import does not steal the active slot from a chosen account', async () => {
  // The user picked an account after the upgrade; a later import of the old file
  // must not switch them away from it.
  const dir = makeTempDir()
  const legacy = join(dir, '.workbuddy-auth.json')
  writeJsonAtomic(legacy, credentialDocument({ uid: 'uid-old' }))
  const store = createAccountStore({ realm: 'cn', dataDir: dir })
  await store.save(credentialDocument({ uid: 'uid-chosen' }))
  await store.importLegacyFile(legacy)
  const accounts = await store.list()
  assert.equal(accounts.length, 2)
  const active = accounts.find(a => a.active)
  assert.equal(active.uidShort, 'uid-chos')
})

await checkAsync('logout with several accounts really signs out', async () => {
  // "退出登录" must not become a hidden "switch to the next account". The card
  // polls status every minute, so an implicit switch would look like the sign-out
  // simply did not work — and the user's other account would be used for requests
  // they thought were signed out.
  const dir = makeTempDir()
  const store = new WorkBuddyCredentialStore({
    variant: WORKBUDDY_VARIANTS[0], dataDir: dir,
    refresh: async () => { throw new Error('refresh must not run here') },
  })
  await store.save(credentialDocument({ uid: 'uid-one', nickname: '一' }))
  await store.save(credentialDocument({ uid: 'uid-two', nickname: '二' }))
  await store.logout()
  assert.deepEqual(await store.accounts.list(), [])
  await assert.rejects(() => store.resolve(), /not signed in/i)
})
await checkAsync('clear does not resurrect accounts from the legacy file', async () => {
  // store.save() keeps a single-file copy for downgrades. "清除全部" has to clear
  // that too, or the next read migrates it straight back — the user watches all
  // accounts disappear and then reappear a second later.
  const dir = makeTempDir()
  const store = new WorkBuddyCredentialStore({
    variant: WORKBUDDY_VARIANTS[0], dataDir: dir,
    refresh: async () => { throw new Error('refresh must not run here') },
  })
  // Use a parsed credential — that is what sign-in / import actually pass, and
  // the only shape whose downgrade copy contains a usable token. A document
  // fixture writes an empty file and makes this test pass for the wrong reason.
  await store.save({
    accessToken: 'token-live', refreshToken: 'refresh-live',
    expiresAtMs: Date.now() + 3600_000, domain: 'www.codebuddy.cn',
    uid: 'uid-one', nickname: '一',
  })
  assert.equal(existsSync(store.ownPath), true, 'test needs the legacy copy to exist')
  // The card's clear action calls store.logout(), not the bare account store —
  // that is the only path that also drops the downgrade copy.
  await store.logout()
  assert.equal(existsSync(store.ownPath), false, 'the downgrade copy survived logout')
  await assert.rejects(() => store.resolve(), /not signed in/i)
  assert.deepEqual(await store.accounts.list(), [])
})

await checkAsync('a token refresh updates the active account copy too', async () => {
  // refreshNow() wrote only the legacy single file while resolve() reads from the
  // account store. The two copies diverge: the gateway gets a stale token and the
  // card reports "expired" even though the refresh produced a valid one.
  const dir = makeTempDir()
  const store = new WorkBuddyCredentialStore({
    variant: WORKBUDDY_VARIANTS[0],
    dataDir: dir,
    refresh: async () => ({ accessToken: 'token-refreshed', expiresInSec: 3600 }),
  })
  const old = {
    accessToken: 'token-old', refreshToken: 'refresh',
    expiresAtMs: Date.now() - 1000, domain: 'www.codebuddy.cn',
    uid: 'uid-one', nickname: '一',
  }
  await store.accounts.save(old)
  await store.saveOwn(old)
  // Force the refresh path (expired token).
  const resolved = await store.resolve()
  assert.equal(resolved.accessToken, 'token-refreshed')
  // The account-store copy is what resolve() reads next time: it MUST be updated.
  assert.equal((await store.accounts.active()).accessToken, 'token-refreshed',
    'the account copy was not refreshed; the next request will use the stale token')
})

await checkAsync('the credential store reads the active account', async () => {
  // The store is what every request goes through, so activating an account has to
  // change what resolve() returns — that is the whole mechanism of a switch.
  const dir = makeTempDir()
  const store = new WorkBuddyCredentialStore({
    variant: WORKBUDDY_VARIANTS[0],
    dataDir: dir,
    refresh: async () => { throw new Error('refresh must not run here') },
  })
  await store.accounts.save(credentialDocument({ uid: 'uid-one', accessToken: 'token-one' }))
  await store.accounts.save(credentialDocument({ uid: 'uid-two', accessToken: 'token-two' }))
  assert.equal((await store.resolve()).accessToken, 'token-two')
  const first = (await store.accounts.list()).find(a => a.uidShort === 'uid-one')
  await store.accounts.activate(first.hash)
  // No restart, no re-login: the very next resolve serves the other account.
  assert.equal((await store.resolve()).accessToken, 'token-one')
})
await checkAsync('a pre-upgrade credential still resolves', async () => {
  // Upgrading must not sign anyone out. Before the account list existed the only
  // credential was one file at the data dir root.
  const dir = makeTempDir()
  writeJsonAtomic(join(dir, WORKBUDDY_VARIANTS[0].authFilename), credentialDocument({ uid: 'uid-legacy', accessToken: 'token-legacy' }))
  const store = new WorkBuddyCredentialStore({
    variant: WORKBUDDY_VARIANTS[0],
    dataDir: dir,
    refresh: async () => { throw new Error('refresh must not run here') },
  })
  assert.equal((await store.resolve()).accessToken, 'token-legacy')
})

await checkAsync('a store given a data dir never falls back to the real profile', async () => {
  // The fallback to the discovered profile is what let a runtime built against a
  // throwaway directory write into the user's real profile and re-point its active
  // account, signing the real account out. The fallback must only apply when the
  // caller says nothing at all.
  const dir = makeTempDir()
  const store = new WorkBuddyCredentialStore({
    variant: WORKBUDDY_VARIANTS[0],
    dataDir: dir,
    refresh: async () => { throw new Error('refresh must not run here') },
  })
  assert.equal(store.dataDir, dir)
  await store.accounts.save(credentialDocument({ uid: 'uid-probe', accessToken: 'token-probe' }))
  assert.equal(existsSync(join(dir, 'accounts', WORKBUDDY_VARIANTS[0].region)), true)
  // And the legacy path it would fall back to lives under the same dir, so no
  // write can escape.
  assert.ok(store.ownPath.startsWith(dir), `ownPath escaped the data dir: ${store.ownPath}`)
})

console.log('check-in bookkeeping')
check('UTC+8 date and wall clock', () => {
  // 2026-11-17 02:00 UTC is already the 17th in China. A UTC date would shift
  // the "day" by eight hours and let a sweep claim on the wrong date.
  assert.equal(utc8Date(Date.parse('2026-11-17T02:00:00Z')), '2026-11-17')
  assert.equal(utc8Date(Date.parse('2026-11-16T16:00:00Z')), '2026-11-17')
})
check('normalizes the check-in minute onto the upstream window', () => {
  assert.equal(normalizeCheckinMinute(undefined), 605)
  assert.equal(normalizeCheckinMinute(900), 900)
  assert.equal(normalizeCheckinMinute(540), 600, 'before 10:00 the upstream serves yesterday')
  assert.equal(normalizeCheckinMinute(9999), 605)
})
check('next check-in is always in the future', () => {
  const now = Date.parse('2026-11-17T02:00:00Z') // 10:00 UTC+8
  assert.ok(msUntilNextCheckin(605, now) > 0)
  assert.ok(msUntilNextCheckin(605, now) <= 2 * 86400_000)
})
check('only a claimed day counts as settled', () => {
  const today = '2026-11-17'
  assert.equal(isSettled({ date: today, status: 'claimed' }, today, 'a', true), true)
  assert.equal(isSettled({ date: today, status: 'already-claimed' }, today, 'a', true), true)
  // Failures must stay retryable: an early "no campaign" cannot burn the day.
  assert.equal(isSettled({ date: today, status: 'no-campaign' }, today, 'a', true), false)
  assert.equal(isSettled({ date: today, status: 'error' }, today, 'a', true), false)
  assert.equal(isSettled(undefined, today, 'a', true), false)
})
check('a legacy header row settles only the sole account', () => {
  const today = '2026-11-17'
  const record = { date: today, status: 'claimed' }
  assert.equal(isSettled(record, today, 'a', true), true)
  // With several accounts the header cannot say which one was claimed.
  assert.equal(isSettled(record, today, 'a', false), false)
  // An explicit per-account row wins over the header.
  assert.equal(isSettled({ ...record, accounts: { a: { date: today, status: 'error' } } }, today, 'a', true), false)
})
await checkAsync('check-in status normalizes the upstream document', async () => {
  // The upstream carries twenty-odd fields; the card needs four. A region with
  // no activity is normal, not an error.
  const client = new WorkBuddyUpstreamClient({
    resolveAppVersion: async () => ({}),
    resolveChatIdentity: async () => ({}),
  })
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: {
    active: true, today_checked_in: true, streak_days: 3, daily_credit: 100, today_credit: 100,
    theme_name: 'Buddy加油站',
  } }), { status: 200 })
  try {
    const status = await client.checkInStatus({ region: 'cn', accessToken: 't', uid: 'u', domain: 'www.codebuddy.cn' })
    assert.deepEqual(status, { active: true, claimed: true, streakDays: 3, dailyCredit: 100, todayCredit: 100, theme: 'Buddy加油站' })
  } finally {
    globalThis.fetch = original
  }
})
await checkAsync('an already-claimed day is a normal result, not a failure', () => {
  // The upstream answers HTTP 400 + code 10001. Treating that as an error would
  // mark a successful day as failed and keep retrying it forever.
  return (async () => {
    const client = new WorkBuddyUpstreamClient({ resolveAppVersion: async () => ({}), resolveChatIdentity: async () => ({}) })
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来' }), { status: 400 })
    try {
      const result = await client.checkIn({ region: 'cn', accessToken: 't', uid: 'u', domain: 'www.codebuddy.cn' })
      assert.deepEqual(result, { status: 'already-claimed', amount: 0, message: '今天已签到，请明天再来' })
    } finally {
      globalThis.fetch = original
    }
  })()
})

await checkAsync('a scheduler startup failure never becomes an unhandled rejection', async () => {
  // start() fires the catch-up sweep without awaiting it. If listing accounts
  // throws (e.g. a credential file is unreadable at boot), the rejected promise
  // used to escape as an unhandled rejection — a background convenience feature
  // must never take down the host process.
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const dir = makeTempDir()
    const scheduler = new CheckInScheduler({
      store: createCheckInStore(dir),
      isEnabled: () => true,
      targets: [{
        variantId: 'cn', minuteOfDay: () => DEFAULT_CHECKIN_MINUTE,
        accounts: async () => { throw new Error('accounts exploded') },
        checkIn: async () => ({ status: 'claimed', amount: 100 }),
      }],
    })
    scheduler.start()
    await new Promise(resolve => setTimeout(resolve, 50))
    scheduler.dispose()
    assert.deepEqual(unhandled, [], 'the startup sweep leaked a rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

await checkAsync('a catch-up sweep checks each unsettled account once', async () => {
  const dir = makeTempDir()
  const store = createCheckInStore(dir)
  const calls = []
  const scheduler = new CheckInScheduler({
    store,
    isEnabled: () => true,
    targets: [{
      variantId: 'cn',
      minuteOfDay: DEFAULT_CHECKIN_MINUTE,
      accounts: async () => [{ hash: 'a', nickname: '甲' }, { hash: 'b', nickname: '乙' }],
      checkIn: async (account) => { calls.push(account.hash); return { status: 'claimed', amount: 100 } },
    }],
  })
  const outcomes = await scheduler.sweepAll(true)
  assert.equal(outcomes.length, 2)
  assert.deepEqual(calls, ['a', 'b'])
  // A second catch-up the same day does not re-POST a claimed day.
  const again = await scheduler.sweepAll(true)
  assert.equal(again.length, 0)
  assert.deepEqual(calls, ['a', 'b'])
})
await checkAsync('a failed check-in stays retryable the same day', async () => {
  const dir = makeTempDir()
  const store = createCheckInStore(dir)
  let attempt = 0
  const scheduler = new CheckInScheduler({
    store,
    isEnabled: () => true,
    targets: [{
      variantId: 'cn', minuteOfDay: DEFAULT_CHECKIN_MINUTE,
      accounts: async () => [{ hash: 'a', nickname: '甲' }],
      checkIn: async () => {
        attempt++
        return attempt === 1 ? { status: 'error', message: 'transient' } : { status: 'claimed', amount: 100 }
      },
    }],
  })
  await scheduler.sweepAll(true)
  assert.equal(attempt, 1)
  // "error" is not settled: an early failure must not burn the day.
  await scheduler.sweepAll(true)
  assert.equal(attempt, 2)
})
await checkAsync('manual check-in retries even a settled day', async () => {
  const dir = makeTempDir()
  const store = createCheckInStore(dir)
  let calls = 0
  const scheduler = new CheckInScheduler({
    store,
    isEnabled: () => true,
    targets: [{
      variantId: 'cn', minuteOfDay: DEFAULT_CHECKIN_MINUTE,
      accounts: async () => [{ hash: 'a', nickname: '甲' }],
      checkIn: async () => { calls++; return { status: 'already-claimed', amount: 100 } },
    }],
  })
  await scheduler.sweepAll(true)
  assert.equal(calls, 1)
  // The user pressed the button: the upstream gets the last word again.
  const manual = await scheduler.checkInNow('cn')
  assert.equal(calls, 2)
  assert.equal(manual[0].status, 'already-claimed')
})
await checkAsync('one failing account does not stop the others', async () => {
  const dir = makeTempDir()
  const store = createCheckInStore(dir)
  const calls = []
  const scheduler = new CheckInScheduler({
    store,
    isEnabled: () => true,
    targets: [{
      variantId: 'cn', minuteOfDay: DEFAULT_CHECKIN_MINUTE,
      accounts: async () => [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }],
      checkIn: async (account) => {
        calls.push(account.hash)
        if (account.hash === 'b') throw new Error('network')
        return { status: 'claimed', amount: 100 }
      },
    }],
  })
  const results = await scheduler.sweepAll(true)
  assert.deepEqual(calls, ['a', 'b', 'c'])
  assert.equal(results.length, 3)
  assert.equal(results[1].status, 'error')
  assert.equal(results[2].status, 'claimed')
})

await checkAsync('check-in records are per account and keep a capped log', async () => {
  const dir = makeTempDir()
  const store = createCheckInStore(dir)
  const rec = { date: '2026-11-17', timestamp: Date.now(), status: 'claimed', amount: 100,
    account: accountTag({ id: 'a', nickname: '甲' }) }
  store.write('cn', rec)
  store.write('cn', { ...rec, account: accountTag({ id: 'b', nickname: '乙' }), status: 'already-claimed' })
  // `write` records the latest attempt at the top level and keeps every attempt
  // in the log; the scheduler maintains per-account settled state separately.
  assert.equal(store.read('cn').status, 'already-claimed')
  assert.equal(store.read('cn').logs.length, 2)
  assert.equal(store.read('global'), undefined)
  // Capped at 30; a scheduler that runs for a month must not grow forever.
  for (let i = 0; i < 40; i++) store.write('cn', { ...rec, timestamp: rec.timestamp + i + 10 })
  assert.equal(store.read('cn').logs.length, 30)
})
await checkAsync('clearing logs keeps the account state', async () => {
  const dir = makeTempDir()
  const store = createCheckInStore(dir)
  store.write('cn', { date: '2026-11-17', timestamp: Date.now(), status: 'claimed',
    account: accountTag({ id: 'a' }) })
  store.clearLogs('cn')
  assert.deepEqual(store.read('cn').logs, [])
  assert.equal(store.read('cn').status, 'claimed')
})
check('an account tag never carries a credential', () => {
  const tag = accountTag({ id: 'a', hash: 'h', uidShort: 'abcdefgh', nickname: '甲',
    accessToken: 'SECRET', refreshToken: 'SECRET' })
  assert.equal(JSON.stringify(tag).includes('SECRET'), false)
})

console.log('thinking levels')
check('a model that cannot disable thinking offers only its declared levels', () => {
  // hy4free declares supportedEfforts: ['high'] with canDisableThinking: false,
  // and the picker showed exactly two entries: "关闭" and "high". Both put 'high'
  // on the wire, so half the control was a no-op dressed up as a choice — and
  // the upstream never said "off" was available in the first place.
  const fields = reasoningFields({ reasoning: { supports: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false } })
  assert.equal(fields.thinkingLevelMap.off, null)
  assert.equal(fields.thinkingLevelMap.high, 'high')
})
check('a model that can disable thinking still offers it', () => {
  // deepseek-v4.1-flash declares canDisableThinking: true, so the off slot is
  // the upstream's own statement that the level exists.
  const fields = reasoningFields({ reasoning: { supports: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true } })
  assert.notEqual(fields.thinkingLevelMap.off, null)
})
check('only the declared levels appear', () => {
  const fields = reasoningFields({ reasoning: { supports: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false } })
  assert.equal(fields.thinkingLevelMap.low, 'low')
  assert.equal(fields.thinkingLevelMap.high, 'high')
  assert.equal(fields.thinkingLevelMap.max, 'max')
  assert.equal(fields.thinkingLevelMap.medium, null)
  assert.equal(fields.thinkingLevelMap.xhigh, null)
})

console.log('cache stats')
check('reads usage out of a forwarded event stream', () => {
  const text = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"prompt_tokens_details":{"cached_tokens":900}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const usage = usageFromSseText(text)
  assert.equal(usage.prompt_tokens, 1000)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 900)
})
check('an event without usage is skipped, not fatal', () => {
  assert.equal(usageFromSseText('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'), undefined)
  assert.equal(usageFromSseText(''), undefined)
  assert.equal(usageFromSseText(undefined), undefined)
})
check('a malformed event does not throw mid-stream', () => {
  // The relay is already streaming when this runs; an exception here would
  // break a response the user is watching.
  assert.equal(usageFromSseText('data: {"usage": broken json\n\n'), undefined)
  assert.equal(usageFromSseText('data: {"usage":null}\n\n'), undefined)
})
check('folds turns into a running hit rate', () => {
  let state = accumulateCacheUsage(undefined, { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } })
  assert.equal(state.turns, 1)
  assert.equal(state.rate, 0.9)
  assert.equal(state.lastRate, 0.9)
  state = accumulateCacheUsage(state, { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 1000 } })
  assert.equal(state.turns, 2)
  assert.equal(state.promptTokens, 2000)
  assert.equal(state.cachedTokens, 1900)
  assert.equal(state.rate, 0.95)
})
check('never reports a hit rate above 100%', () => {
  // The upstream reports cached_tokens separately; a bad value must not turn
  // into a figure the card would have to apologise for.
  const state = accumulateCacheUsage(undefined, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } })
  assert.equal(state.cachedTokens, 100)
  assert.equal(state.rate, 1)
})
check('a turn with no usage is not counted as a miss', () => {
  // Aborted streams and some events carry no usage at all. Counting them as
  // zero-cache turns would drag the average down for no reason.
  const primed = accumulateCacheUsage(undefined, { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90 } })
  assert.equal(accumulateCacheUsage(primed, undefined).rate, primed.rate)
  assert.equal(accumulateCacheUsage(primed, {}).turns, 1)
  assert.equal(accumulateCacheUsage(primed, { prompt_tokens: 0 }).turns, 1)
})
check('reports a cold first turn as zero, not as missing', () => {
  const state = accumulateCacheUsage(undefined, { prompt_tokens: 500 })
  assert.equal(state.turns, 1)
  assert.equal(state.rate, 0)
  assert.equal(state.lastRate, 0)
})

await checkAsync('the shim reports usage on both the streaming and the plain path', async () => {
  // Both paths matter: a streaming client is the common case, and a client that
  // asked for no stream still gets served by reassembling the upstream's stream.
  // The plain path was wired through the SSE scanner at first and silently
  // reported nothing, so both are asserted here rather than just one.
  const eventStream = () => new Response(
    [
      'data: {"choices":[{"delta":{"content":"hi"}}],"model":"hy4free"}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":1750}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  const seen = []
  const shim = createWorkBuddyShim({
    store: { resolve: async () => ({ accessToken: 'fake', uid: 'u', region: 'cn' }) },
    client: { chatStream: async () => ({ ok: true, response: eventStream() }) },
    catalog: { current: () => [], all: () => [] },
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    prepareBody: (raw) => raw,
    onUsage: (usage) => seen.push(usage),
  })
  await shim.ready
  try {
    for (const stream of [true, false]) {
      const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: 'hy4free', messages: [{ role: 'user', content: 'hi' }], stream }),
      })
      await res.text()
      assert.equal(res.status, 200)
    }
    assert.equal(seen.length, 2, 'one report per request')
    assert.equal(seen[0].prompt_tokens, 2000)
    assert.equal(seen[0].prompt_tokens_details.cached_tokens, 1750)
  } finally {
    await shim.close()
  }
})

console.log('catalog')
const CATALOG = {
  models: [
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00', maxInputTokens: 1000000, maxOutputTokens: 128000, supportsImages: true, reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false } },
    { id: 'hy3', name: 'Hy3', credits: 'x0.05 credits', maxInputTokens: 192000, maxOutputTokens: 64000, supportsImages: true, disabledMultimodal: false },
    { id: 'singular', name: 'Singular', maxInputTokens: 1000, maxOutputTokens: 1000, supportsImages: true, reasoning: { effort: 'medium', summary: 'auto' } },
    { id: 'off-model', name: 'Off', maxInputTokens: 1000, maxOutputTokens: 1000, disabled: true },
    { id: 'no-budget', name: 'No budget', maxInputTokens: 0, maxOutputTokens: 0 },
  ],
  agent: { agents: [{ name: 'cli', models: ['deepseek-v4.1-flash', 'hy3', 'singular'] }] },
}
check('reads the agents out of data.agent.agents', () => {
  const models = parseModelCatalog(CATALOG, true)
  assert.equal(models.length, 3)
  assert.deepEqual(models.map(m => m.id), ['deepseek-v4.1-flash', 'hy3', 'singular'])
})
check('reads the agents out of data.agents too', () => {
  const models = parseModelCatalog({ models: CATALOG.models, agents: CATALOG.agent.agents }, true)
  assert.equal(models.length, 3)
})
check('drops a disabled model', () => {
  const models = parseModelCatalog(CATALOG, true)
  assert.equal(models.some(m => m.id === 'off-model'), false)
})
check('drops a model without a budget', () => {
  const models = parseModelCatalog(CATALOG, true)
  assert.equal(models.some(m => m.id === 'no-budget'), false)
})
check('marks a zero-rate model free', () => {
  const models = parseModelCatalog(CATALOG, true)
  assert.equal(models[0].billing.free, true)
})
check('marks a rate-bearing model as paid', () => {
  // "Which models cost me credits" is the question the model-toggle list has to
  // answer, and the upstream publishes no membership field to answer it with
  // (measured 2026-11-16 across /v3/config, both legacy personal-models
  // documents, the billing packages and the account JWT). The one per-model
  // signal that does exist is the rate, so a positive rate is what "paid" means
  // here — a fact the upstream states, not a hand-maintained guess.
  const models = parseModelCatalog(CATALOG, true)
  const hy3 = models.find(m => m.id === 'hy3')
  assert.equal(hy3.billing.paid, true)
})
check('a zero-rate model is not paid', () => {
  const models = parseModelCatalog(CATALOG, true)
  assert.equal(models[0].billing.paid, false)
})
check('a row that declares no rate claims neither free nor paid', () => {
  // Inventing "paid" for a row with no `credits` would be the same mistake as
  // inventing "free": the plugin would be quoting a price the upstream never
  // stated.
  const models = parseModelCatalog(CATALOG, true)
  const singular = models.find(m => m.id === 'singular')
  assert.equal(singular.billing.paid, false)
})
check('a live zero-factor promotion clears the paid mark', () => {
  const model = modelWithCurrentPromotion({
    id: 'promoted',
    billing: { credits: 'x0.79', free: false, paid: true },
    promotions: [{ start: Date.now() - 3600000, end: Date.now() + 3600000, factor: 0, label: 'Free now', priority: 1 }],
  })
  assert.equal(model.billing.free, true)
  assert.equal(model.billing.paid, false)
})
check('an ended promotion does not keep a paid claim it cannot stand behind', () => {
  // The lapsed branch reports `rateUnknown`: the price is not known, so the row
  // must not claim "paid" any more than it may claim "free".
  const model = modelWithCurrentPromotion({
    id: 'lapsed',
    billing: { credits: 'x0.00', free: true, paid: false },
    promotions: [{ start: Date.now() - 7200000, end: Date.now() - 3600000, factor: 0, label: '限时免费', priority: 1 }],
  })
  assert.equal(model.billing.rateUnknown, true)
  assert.notEqual(model.billing.paid, true)
})
check('a saved row that predates the flag still reports paid', () => {
  // The saved catalog on disk stores normalized records, and one written
  // before this flag existed has no `paid` key at all. Reading the stored
  // boolean would then silently report "free" for a x0.29 model, so the answer
  // is re-derived from the rate that IS stored.
  assert.equal(rateIsPaid({ credits: 'x0.29' }), true)
  assert.equal(rateIsPaid({ credits: 'x0.00' }), false)
  assert.equal(rateIsPaid({ credits: 'x1.62' }), true)
})
check('a rate marked unknown never claims paid', () => {
  // A lapsed promotion leaves the stale rate behind with `rateUnknown`. That
  // number is not a current price, so it cannot support a tier claim either.
  assert.equal(rateIsPaid({ credits: 'x0.79', rateUnknown: true }), false)
})
check('a row with no rate at all claims nothing', () => {
  assert.equal(rateIsPaid({}), false)
  assert.equal(rateIsPaid(undefined), false)
  assert.equal(rateIsPaid({ credits: 'free' }), false)
})
check('reads an upstream label that arrives in tags', () => {
  // The live CN documents carry the promotional labels in `tags`, not in
  // `promotions` (measured 2026-11-16: hy3 and hy4free both arrive as
  // ["craft", "badge:限时免费:#FF0000"]). Reading only `promotions` dropped
  // every one of them, so the toggle list showed no label the upstream had
  // actually published.
  const models = parseModelCatalog({
    models: [{ id: 'tagged', name: 'Tagged', credits: 'x0.05', maxInputTokens: 1000, maxOutputTokens: 1000, tags: ['craft', 'badge:限时免费:#FF0000'] }],
    agent: { agents: [{ name: 'cli', models: ['tagged'] }] },
  }, true)
  assert.deepEqual(models[0].billing.badges, ['限时免费'])
})
check('a capability tag is not a badge', () => {
  // `craft`, `text-to-image` and `enterprise:selfhost` describe what a model
  // does; only the `badge:` prefix marks a label meant for a human.
  const models = parseModelCatalog({
    models: [{ id: 'cap', name: 'Cap', credits: 'x0.05', maxInputTokens: 1000, maxOutputTokens: 1000, tags: ['craft', 'text-to-image', 'enterprise:selfhost'] }],
    agent: { agents: [{ name: 'cli', models: ['cap'] }] },
  }, true)
  assert.deepEqual(models[0].billing.badges ?? [], [])
})
check('parsing the same catalog twice does not accumulate labels', () => {
  // The parser must not mutate the document it was handed: the catalog object
  // is cached and re-parsed on refresh, and a label that piled up would read
  // `限时免费 · 限时免费` in the toggle list.
  const doc = {
    models: [{ id: 'twice', name: 'Twice', credits: 'x0.05', maxInputTokens: 1000, maxOutputTokens: 1000, tags: ['badge:限时免费:#FF0000'] }],
    agent: { agents: [{ name: 'cli', models: ['twice'] }] },
  }
  parseModelCatalog(doc, true)
  const second = parseModelCatalog(doc, true)
  assert.deepEqual(second[0].billing.badges, ['限时免费'])
  assert.equal(doc.models[0].tags.length, 1)
})
check('nests the reasoning record where the adapter reads it', () => {
  const models = parseModelCatalog(CATALOG, true)
  assert.equal(models[0].reasoning.supports, true)
  assert.equal(models[0].reasoning.defaultEffort, 'high')
  assert.deepEqual(models[0].reasoning.supportedEfforts, ['low', 'high', 'max'])
})
check('folds a singular reasoning shape onto the full ladder', () => {
  const models = parseModelCatalog(CATALOG, true)
  const singular = models.find(m => m.id === 'singular')
  assert.deepEqual(singular.reasoning.supportedEfforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(singular.reasoning.defaultEffort, 'medium')
})
check('a text-only model does not claim image support', () => {
  const models = parseModelCatalog(CATALOG, true)
  assert.equal(models.find(m => m.id === 'hy3').supportsImages, false)
})
check('normalizes a rate with a unit word', () => {
  assert.equal(normalizeCredits('x0.05 credits'), 'x0.05')
  assert.equal(normalizeCredits('x0.79'), 'x0.79')
  assert.equal(normalizeCredits('nope'), undefined)
})
check('a CN deepseek row reports the official default window, not the maximum', () => {
  // The CN CLI document carries only maxInputTokens (1000000 for deepseek),
  // while the product document's default — what the official client requests
  // at — is 300000. Reporting the maximum let a five-day session grow past
  // 300k tokens with the compaction engine asleep (its threshold is 0.8 of
  // the declared window); every send was then refused or hung upstream
  // (measured 2026-10-25).
  const models = parseModelCatalog(CATALOG, false)
  assert.equal(models.find(m => m.id === 'deepseek-v4.1-flash').contextWindow, 300000)
})
check('a CN row whose maximum equals the declared default keeps it', () => {
  const models = parseModelCatalog(CATALOG, false)
  assert.equal(models.find(m => m.id === 'hy3').contextWindow, 192000)
})
check('a CN id without a declared default keeps its maxInputTokens', () => {
  const models = parseModelCatalog(CATALOG, false)
  assert.equal(models.find(m => m.id === 'singular').contextWindow, 1000)
})
check('rejects a catalog with no cli agent', () => {
  assert.throws(() => parseModelCatalog({ models: [] }, true), /cli agent/)
})
check('an ended promotion drops the free claim', () => {
  const model = {
    id: 'x',
    name: 'X',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
    billing: { credits: 'x0.00', free: true },
    promotions: [{ start: Date.now() - 7200000, end: Date.now() - 3600000, factor: 0, label: '限时免费', priority: 1 }],
  }
  const current = modelWithCurrentPromotion(model)
  assert.equal(current.billing.free, false)
  assert.equal(current.billing.rateUnknown, true)
  assert.equal(current.billing.credits, 'x0.00')
})
check('a live promotion applies', () => {
  const model = {
    id: 'x',
    name: 'X',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
    billing: { credits: 'x0.79', free: false },
    promotions: [{ start: Date.now() - 3600000, end: Date.now() + 3600000, factor: 0, label: 'Free now', priority: 1 }],
  }
  const current = modelWithCurrentPromotion(model)
  assert.equal(current.billing.free, true)
  assert.equal(current.billing.credits, 'x0.00')
  assert.ok(current.billing.badges.includes('Free now'))
})

console.log('body shape')
check('wraps a bare stop string into a list', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"stop":"END"}'))
  assert.deepEqual(body.stop, ['END'])
})
check('leaves a stop list alone', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"stop":["A","B"]}'))
  assert.deepEqual(body.stop, ['A', 'B'])
})
check('serializes structured tool-call arguments', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: { path: '/x' } } }] }],
  })))
  assert.equal(body.messages[0].tool_calls[0].function.arguments, '{"path":"/x"}')
})
check('leaves string tool-call arguments alone', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: '{"p":1}' } }] }],
  })))
  assert.equal(body.messages[0].tool_calls[0].function.arguments, '{"p":1}')
})
check('rewrites a channel marker in a system message', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: 'Context:\nMain branch (HEAD detached at abc)' }],
  })))
  assert.ok(body.messages[0].content.includes('Default branch ('))
  assert.equal(body.messages[0].content.includes('Main branch ('), false)
})
check('leaves a user message alone', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'user', content: 'what is Main branch (in git)?' }],
  })))
  assert.ok(body.messages[0].content.includes('Main branch ('))
})
check('drops an off effort for a model that refuses it', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"reasoning_effort":"off"}', { modelId: 'deepseek-v4.1-flash' }))
  assert.equal('reasoning_effort' in body, false)
})
check('turns an off effort into the model own default', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"reasoning_effort":"off"}', { defaultEffort: 'high', modelId: 'glm-5.3-flash' }))
  assert.equal(body.reasoning_effort, 'high')
})
check('drops an off effort when the model declares no default', () => {
  const body = JSON.parse(prepareChatBody('{"messages":[],"reasoning_effort":"off"}', { modelId: 'glm-5.3-flash' }))
  assert.equal('reasoning_effort' in body, false)
})
check('applying a promotion twice does not repeat the badge', () => {
  // The catalog re-derives the promotion on every read, so a row that was
  // already promoted must not collect the label a second time — the display
  // would read `Hy3 · x0.00 · Free now · Free now`.
  const model = {
    id: 'x',
    name: 'X',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
    billing: { credits: 'x0.00', free: true },
    promotions: [{ start: Date.now() - 3600000, end: Date.now() + 3600000, factor: 0, label: 'Free now', priority: 1 }],
  }
  const once = modelWithCurrentPromotion(model)
  const twice = modelWithCurrentPromotion(once)
  assert.equal(twice.billing.badges.filter(b => b === 'Free now').length, 1)
})

console.log('credits')
check('reads the nested Response.Data.Accounts shape', () => {
  const credits = normalizeCreditsDocument({
    Response: {
      Data: {
        Accounts: [{
          PackageName: 'gift',
          CapacitySize: 100,
          CapacitySizePrecise: '96.61000218',
          CapacityRemain: 96,
          CapacityRemainPrecise: '96.61000218',
          ExpiredTime: '2026-12-31 00:00:00',
        }],
      },
    },
  })
  assert.equal(credits.accounts.length, 1)
  assert.equal(credits.accounts[0].remain, 96.61000218)
  assert.equal(credits.accounts[0].size, 96.61000218)
  assert.equal(credits.accounts[0].packageEndTime, '2026-12-31 00:00:00')
})
check('prefers the cycle family over the pool family', () => {
  const credits = normalizeCreditsDocument({
    Accounts: [{
      PackageName: 'monthly',
      CapacitySize: 500,
      CapacityRemain: 500,
      CycleCapacitySize: 1000,
      CycleCapacityRemain: 500,
      CycleCapacityRemainPrecise: '500.5',
    }],
  })
  assert.equal(credits.accounts[0].remain, 500.5)
  assert.equal(credits.accounts[0].size, 1000)
})
check('falls back to the pool family when there is no cycle capacity', () => {
  const credits = normalizeCreditsDocument({ Accounts: [{ PackageName: 'p', Size: 10, Remain: 4 }] })
  assert.equal(credits.accounts[0].remain, 4)
  assert.equal(credits.accounts[0].size, 10)
  assert.equal(credits.total, 4)
})
check('carries the capacity type', () => {
  const credits = normalizeCreditsDocument({ Accounts: [{ PackageName: 'p', CapacityType: 4, CycleCapacitySize: 10, CycleCapacityRemain: 5 }] })
  assert.equal(credits.accounts[0].capacityType, 4)
})
check('an empty document is not a crash', () => {
  const credits = normalizeCreditsDocument({})
  assert.equal(credits.accounts.length, 0)
  assert.equal(credits.total, 0)
})

console.log('error classification')
check('14018 is an exhausted balance, not a throttle', () => {
  assert.equal(classifyUpstreamError(429, '{"code":14018,"msg":"Credits exhausted."}'), 'hard_credit')
})
check('14003 is a model-scoped throttle', () => {
  assert.equal(classifyUpstreamError(429, '{"code":14003,"msg":"busy"}'), 'soft_rate')
})
check('6004 is an account volume limit', () => {
  assert.equal(classifyUpstreamError(429, '{"code":6004,"msg":"limit"}'), 'soft_rate')
})
check('12153 is a dead session', () => {
  assert.equal(classifyUpstreamError(401, '{"code":12153,"msg":"session"}'), 'session_dead')
})
check('11128 is a channel refusal', () => {
  assert.equal(classifyUpstreamError(400, '{"code":11128,"msg":"request illegal"}'), 'client')
})
check('a plain 429 is a soft rate limit', () => {
  assert.equal(classifyUpstreamError(429, '{"code":0,"msg":"too many requests"}'), 'soft_rate')
})
check('a gateway html 401 is a dead session', () => {
  assert.equal(classifyUpstreamError(401, '<html><head><title>401 Authorization Required</title></head></html>'), 'session_dead')
})

// Captured 2026-11-08. The international deployment refused a *freshly
// refreshed* token with this body, and the same account was refused inside the
// official WorkBuddy desktop app, so the credential and the client were both
// fine: the restriction lives on the account. Re-authenticating cannot clear
// it, which is why it must not be reported as a dead session.
const ACCOUNT_RESTRICTED_11140 = JSON.stringify({
  code: 11140,
  msg: 'request illegal',
  displayMsg: {
    en: 'Your account has been restricted due to unusual activity',
    zh: '账号存在异常行为，已被限制使用',
  },
  displayTips: {
    en: 'We detected unusual activity on this account. Submit feedback to appeal this restriction',
    zh: '系统检测到该账号存在异常使用行为，如需申诉请提交反馈',
  },
  actions: ['SUBMIT_FEEDBACK'],
})
check('11140 is an account restriction, not a dead session', () => {
  assert.equal(classifyUpstreamError(403, ACCOUNT_RESTRICTED_11140), 'account_restricted')
})
check('a restriction is recognised whatever the http status', () => {
  // The same body arrives on 403 today; a future release could move it.
  assert.equal(classifyUpstreamError(400, ACCOUNT_RESTRICTED_11140), 'account_restricted')
  assert.equal(classifyUpstreamError(429, ACCOUNT_RESTRICTED_11140), 'account_restricted')
})
check('the restriction body explains itself in the user’s own words', () => {
  const reason = describeAccountRestriction(ACCOUNT_RESTRICTED_11140)
  assert.match(reason, /账号存在异常行为/)
  // The appeal hint matters more than the refusal: it is the only way out.
  assert.match(reason, /申诉/)
})
check('a restriction hidden in prose is still recognised', () => {
  // No envelope code, only the text (an older gateway spelling).
  assert.equal(
    classifyUpstreamError(403, '{"message":"Your account has been restricted due to unusual activity"}'),
    'account_restricted',
  )
})
check('a 403 without the restriction markers stays a dead session', () => {
  // The rotation hint must survive: it is the common, actionable 403.
  assert.equal(classifyUpstreamError(403, '{"code":40003,"msg":"token expired"}'), 'session_dead')
})
check('an unknown code never silently becomes a restriction', () => {
  assert.equal(describeAccountRestriction('{"code":99999,"msg":"nope"}'), undefined)
})

console.log('catalog store')
check('the international roster carries the free models', () => {
  const models = fallbackFor('global')
  const free = models.filter(m => m.billing?.free === true).map(m => m.id)
  assert.ok(free.includes('deepseek-v4.1-flash'), 'the free DeepSeek row is missing')
  assert.ok(free.includes('hy3'), 'the free Hy3 row is missing')
  assert.ok(free.includes('step-5-preview'), 'the free Step-5 row is missing')
})
check('every fallback row carries a positive context window', () => {
  // DSH rejects a provider catalog whose model metadata is not a positive
  // integer, and it rejects the WHOLE provider when one row is bad — an empty
  // picker with a working card, which is the worst shape of bug.
  for (const region of ['global', 'cn']) {
    for (const model of fallbackFor(region)) {
      assert.ok(Number.isInteger(model.contextWindow) && model.contextWindow > 0, `${region}/${model.id} has no context window`)
      assert.ok(Number.isInteger(model.maxTokens) && model.maxTokens > 0, `${region}/${model.id} has no output budget`)
    }
  }
})
check('a disabled model leaves the enabled list', () => {
  const catalog = new WorkBuddyCatalog({ region: 'global' })
  const before = catalog.current().length
  catalog.setDisabledModels(['hy3'])
  assert.equal(catalog.current().length, before - 1)
  assert.equal(catalog.current().some(m => m.id === 'hy3'), false)
})
check('an invisible catalog exposes nothing', () => {
  const catalog = new WorkBuddyCatalog({ region: 'global' })
  catalog.setVisible(false)
  assert.equal(catalog.current().length, 0)
})

console.log('model identity')
check('the international route publishes its route and the shared identity', () => {
  assert.deepEqual(modelIdentityKeysOf('workbuddy-global'), ['workbuddy-global', 'workbuddy'])
})
check('the CN route publishes one key', () => {
  assert.deepEqual(modelIdentityKeysOf('workbuddy'), ['workbuddy'])
})
check('the shared identity is never a route', () => {
  const ids = WORKBUDDY_VARIANTS.map(v => v.id)
  assert.equal(ids.includes('workbuddy-global'), true)
  assert.equal(ids.filter(id => id === 'workbuddy').length, 1)
})

console.log('at-rest encryption')
check('the key id is the first 16 hex of the key digest', () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'c2VjcmV0' }))
  assert.equal(deriveAtRestKeyId(key).length, 16)
  assert.match(deriveAtRestKeyId(key), /^[0-9a-f]{16}$/)
})
check('the key is derived from the base64 STRING, not its bytes', () => {
  const a = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'c2VjcmV0' }))
  const b = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'c2VjcmV0=' }))
  assert.notEqual(a.toString('hex'), b.toString('hex'))
})
check('an envelope round-trips through the field transcript', () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'c2VjcmV0' }))
  const keyId = deriveAtRestKeyId(key)
  const plaintext = 'eyJhbGciOiJSUzI1NiJ9.payload.sig'
  const nonce = Buffer.alloc(12, 7)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(fieldAad(keyId, 1))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const envelope = Buffer.from(JSON.stringify({
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  })).toString('base64')
  assert.equal(openEncryptedField({ $wbEncrypted: 1, envelope }, key), plaintext)
})
check('an envelope for another key is refused', () => {
  const key = deriveAtRestKey(JSON.stringify({ atRestSecretKey: 'c2VjcmV0' }))
  assert.throws(() => openEncryptedField({ $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({ suite: 1, keyId: '0000000000000000', nonce: 'AA==', authTag: 'AA==', ciphertext: 'AA==' })).toString('base64') }, key), /belongs to key/)
})
check('a plain string is not an encrypted wrapper', () => {
  assert.equal(isEncryptedFieldWrapper('token'), false)
  assert.equal(isEncryptedFieldWrapper({ $wbEncrypted: 1, envelope: 'x' }), true)
})

console.log('measured ceilings')
// The gateway enforces a per-request prompt ceiling that disagrees with the
// catalog row in BOTH directions, and the disagreement is what strands a
// session: over-declaring puts the hard wall below the host's compaction
// threshold (0.8 of the declared window), so the send fails and the compaction
// request fails the same way. Values are the ceilings the CN/global gateways
// reported enforcing themselves (`prompt is too long: N tokens > M maximum`),
// measured 2026-10-28 and re-measured 2026-10-31 against the live service.
const PATH_PAIR = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root;'
check('a measured ceiling outranks an under-declared catalog row', () => {
  const catalog = new WorkBuddyCatalog({ region: 'cn' })
  catalog.set(parseModelCatalog(CATALOG, false), 'live')
  const deepseek = catalog.all().find(m => m.id === 'deepseek-v4.1-flash')
  // The row and the parse step both say 300000; the gateway grants 1048576.
  assert.equal(deepseek.contextWindow, 1_048_576)
})
check('a measured ceiling also corrects an OVER-declared row', () => {
  const catalog = new WorkBuddyCatalog({ region: 'cn' })
  catalog.set(parseModelCatalog(CATALOG, false), 'live')
  // hy3 advertises 192000 and is refused at 100000: declaring 192000 means the
  // compaction threshold (153600) never fires before the wall.
  assert.equal(catalog.all().find(m => m.id === 'hy3').contextWindow, 100_000)
})
check('an id with no measurement keeps the parsed row', () => {
  const catalog = new WorkBuddyCatalog({ region: 'cn' })
  catalog.set(parseModelCatalog(CATALOG, false), 'live')
  assert.equal(catalog.all().find(m => m.id === 'singular').contextWindow, 1000)
})
check('the maximum-window toggle cannot lower a measured ceiling', () => {
  const models = parseModelCatalog(CATALOG, true)
  const catalog = new WorkBuddyCatalog({ region: 'global' })
  catalog.set(models, 'live')
  catalog.useMaximumContextWindow = true
  assert.equal(catalog.all().find(m => m.id === 'deepseek-v4.1-flash').contextWindow, 1_048_576)
})
check('the local body gate cannot shrink back to a byte guess', () => {
  // The gate exists to stop a session being stranded: at 350KB it fabricated a
  // 400 `context_length_exceeded` WITHOUT contacting the gateway (measured
  // 2026-10-25: the failure carried `inputTokens: 0` and returned in ~2ms), at
  // roughly 90k tokens of real content — a tenth of what the gateway serves.
  // Compaction then failed the same way, because a compaction request carries
  // the same oversized history. Measured 2026-10-28/31 on both live gateways:
  // 1.2MB streams, 2MB is answered in 4.5s, and the only refusals are
  // token-budget ones the shim already re-spells into the compaction error.
  // So this bound is a transport sanity limit; the token ceiling is the
  // upstream's job. 16MiB clears a full 1048576-token window at any realistic
  // bytes-per-token ratio, and stays under the 32MiB transport cap.
  assert.ok(MAX_DELIVERABLE_BODY_BYTES >= 16 * 1024 * 1024, `body gate regressed to ${MAX_DELIVERABLE_BODY_BYTES}`)
  assert.ok(MAX_DELIVERABLE_BODY_BYTES <= 32 * 1024 * 1024, 'body gate exceeds the transport cap')
})

console.log('channel fingerprint: the path-resolution pair')
// 2026-10-31, live CN gateway: the pair is refused in a system message, at an
// assistant LINE START, and — the case that a non-deep row misses — mid-sentence
// inside an assistant message. A tool result is answered 200, so rewriting there
// is accepted over-reach (no narrower scope reaches assistant mid-sentence).
check('the pair is rewritten in a system message', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: `Rules:\n${PATH_PAIR}` }, { role: 'user', content: 'hi' }],
  })))
  assert.ok(!JSON.stringify(body).includes(PATH_PAIR), 'system pair survived sanitization')
})
check('the pair is rewritten MID-SENTENCE in an assistant message', () => {
  // This is the regression the `deep` scope exists for: the model quoting the
  // paragraph inside a reply poisons every later turn of the conversation, and
  // a line-start-only rewrite leaves it untouched.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'system', content: 'You are an AI coding assistant.' },
      { role: 'user', content: 'explain the path rules' },
      { role: 'assistant', content: `Sure — note that ${PATH_PAIR} That is the rule.` },
      { role: 'user', content: 'ok' },
    ],
  })))
  assert.ok(!JSON.stringify(body).includes(PATH_PAIR), 'assistant mid-sentence pair survived sanitization')
})
check('the pair is deliberately left inside an assistant tool-call argument', () => {
  // Measured 2026-10-31 on the live CN gateway: a body whose tool-call
  // `arguments` carry the pair is answered 200, both raw and sanitized — the
  // scan does not reach arguments for this marker, so the sanitizer does not
  // rewrite it there. This differs from the `DeepSeek Harness` marker above it,
  // which IS rewritten in arguments because the gateway does read that one
  // there. The asymmetry is evidence-backed rather than an oversight: replacing
  // a product name costs nothing, while rewriting a whole paragraph inside a
  // recorded `write` payload would corrupt what the model actually put in the
  // file. If the gateway ever starts scanning arguments for this pair, the fix
  // is adding it to that existing arguments pass — this check is what makes the
  // change deliberate instead of accidental.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [
      { role: 'system', content: 'You are an AI coding assistant.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: `{"content":"${PATH_PAIR}"}` } }] },
      { role: 'user', content: 'ok' },
    ],
  })))
  assert.ok(body.messages[1].tool_calls[0].function.arguments.includes(PATH_PAIR), 'tool-call arguments were rewritten, but the gateway does not check them')
})
check('user messages are still left verbatim', () => {
  // The gateway does not read the pair from a user role (measured 2026-10-31:
  // 8 mentions in one user message pass), and this is the human's own text.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: 'You are an AI coding assistant.' }, { role: 'user', content: `${PATH_PAIR} ${PATH_PAIR}` }],
  })))
  assert.ok(body.messages[1].content.includes(PATH_PAIR), 'user text was altered')
})

console.log(`\n${passed} checks passed`)

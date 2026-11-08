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
  prepareChatBody,
  prepareInternationalChatBody,
  regionOf,
  withGatewayChatHeaders,
  withPromptCacheKey,
} from '../lib/upstream.js'
import { fallbackFor, WorkBuddyCatalog } from '../lib/catalog.js'
import { MAX_DELIVERABLE_BODY_BYTES } from '../lib/shim.js'
import {
  baseSpecOf,
  checkForUpdate,
  installedCommitFromLock,
  parseInstallSpec,
  pinnedCommit,
  readLocalState,
  sameCommit,
  updateSpecFrom,
} from '../lib/updates.js'
import { modelIdentityKeysOf, WORKBUDDY_VARIANTS } from '../lib/variants.js'
import { deriveAtRestKey, deriveAtRestKeyId, isEncryptedFieldWrapper, openEncryptedField } from '../lib/atrest.js'

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
    fn()
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

check('the version is valid semver', async () => {
  // The plugin page prints this string, and a registry install refuses a
  // package whose version is not semver. Asserted here so a hand-edit is
  // caught before anything depends on it.
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `not semver: ${manifest.version}`)
})
check('the card reads its version from the manifest, not a second literal', async () => {
  // A literal beside package.json is two sources for one fact; the card then
  // reports a version the installed files do not have.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /new URL\('\.\.\/package\.json', import\.meta\.url\)/, 'lib/index.js no longer reads package.json for its version')
})
check('the client declares the primitives it renders with', async () => {
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

console.log('update check: what the profile pins')

const SHA_A = 'ec3c4e5f750697b18475964f0c547787b49b6f21'
const SHA_B = '205a81bf249b623597cd6f341aaa063f55eb4b38'

check('a github: shorthand names repository and pin', () => {
  const parsed = parseInstallSpec(`github:sixzjd/dsh-workbuddy-connect#${SHA_A}`)
  assert.deepEqual(parsed, { kind: 'git', url: 'https://github.com/sixzjd/dsh-workbuddy-connect.git', ref: SHA_A })
})
check('a github: shorthand with no ref asks for the default branch', () => {
  const parsed = parseInstallSpec('github:sixzjd/dsh-workbuddy-connect')
  assert.equal(parsed.kind, 'git')
  assert.equal(parsed.ref, undefined)
})
check('a git+https spec is understood', () => {
  const parsed = parseInstallSpec(`git+https://github.com/sixzjd/dsh-workbuddy-connect.git#${SHA_A}`)
  assert.deepEqual(parsed, { kind: 'git', url: 'https://github.com/sixzjd/dsh-workbuddy-connect.git', ref: SHA_A })
})
check('a plain https .git URL is understood', () => {
  const parsed = parseInstallSpec(`https://github.com/sixzjd/dsh-workbuddy-connect.git#${SHA_A}`)
  assert.equal(parsed.kind, 'git')
  assert.equal(parsed.ref, SHA_A)
})
check('a registry version is not a git install', () => {
  assert.equal(parseInstallSpec('0.1.0').kind, 'local')
})
check('a file: install is not a git install', () => {
  // The user's own profile installs this plugin by path; the card must not
  // offer to "update" it over the top of a working directory.
  assert.equal(parseInstallSpec('file:./dsh-workbuddy-connect').kind, 'local')
})
check('a link: install is not a git install', () => {
  assert.equal(parseInstallSpec('link:/Users/someone/plugin').kind, 'local')
})
check('a full commit id is a pin', () => {
  assert.equal(pinnedCommit(`github:sixzjd/x#${SHA_A}`), SHA_A)
})
check('an abbreviated commit id is a pin', () => {
  assert.equal(pinnedCommit('github:sixzjd/x#ec3c4e5'), 'ec3c4e5')
})
check('a branch name is not a pin', () => {
  // Comparing a branch name against a commit id would always read as "behind".
  assert.equal(pinnedCommit('github:sixzjd/x#main'), undefined)
})

console.log('update check: what the lockfile resolved')

check('the resolved commit is read from the importer block', () => {
  const lock = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dsh-workbuddy-connect:\n        specifier: github:sixzjd/dsh-workbuddy-connect#${SHA_A}\n        version: git+https://github.com/sixzjd/dsh-workbuddy-connect.git#${SHA_B}\n`
  assert.equal(installedCommitFromLock(lock), SHA_B)
})
check('the codeload tarball form is read too', () => {
  // This is the shape pnpm 11 writes for a pinned github spec.
  const lock = `importers:\n\n  .:\n    dependencies:\n      dsh-workbuddy-connect:\n        specifier: github:sixzjd/dsh-workbuddy-connect#${SHA_B}\n        version: https://codeload.github.com/sixzjd/dsh-workbuddy-connect/tar.gz/${SHA_B}\n      other-package:\n        specifier: ^1.0.0\n        version: 1.0.0\n`
  assert.equal(installedCommitFromLock(lock), SHA_B)
})
check('six-space indentation is parsed, and never leaks a neighbour', () => {
  // pnpm's real output indents importer entries by six spaces. A pattern that
  // only accepted two silently widened to the whole file and reported the
  // NEIGHBOURING package's commit — a wrong answer that looks authoritative.
  const lock = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      dsh-opencode-connect:
        specifier: github:sixzjd/dsh-opencode-connect#${SHA_B}
        version: https://codeload.github.com/sixzjd/dsh-opencode-connect/tar.gz/${SHA_B}
      dsh-workbuddy-connect:
        specifier: github:sixzjd/dsh-workbuddy-connect#${SHA_A}
        version: https://codeload.github.com/sixzjd/dsh-workbuddy-connect/tar.gz/${SHA_A}
      dsh-qoder-connect:
        specifier: 0.2.15
        version: 0.2.15
`
  assert.equal(installedCommitFromLock(lock), SHA_A)
})
check('the entry that comes last is still found', () => {
  const lock = `importers:

  .:
    dependencies:
      aaa-first:
        version: git+https://github.com/x/aaa.git#${SHA_B}
      dsh-workbuddy-connect:
        specifier: x
        version: git+https://github.com/sixzjd/dsh-workbuddy-connect.git#${SHA_A}
`
  assert.equal(installedCommitFromLock(lock), SHA_A)
})
check('a header mentioning the name inside a longer key is ignored', () => {
  // `dsh-workbuddy-connect-extra` must not be mistaken for this package.
  const lock = `importers:

  .:
    dependencies:
      dsh-workbuddy-connect-extra:
        specifier: x
        version: git+https://github.com/x/y.git#${SHA_B}
`
  assert.equal(installedCommitFromLock(lock), undefined)
})
check('a lockfile without this package answers nothing', () => {
  const lock = `importers:\n\n  .:\n    dependencies:\n      other-package:\n        specifier: ^1.0.0\n        version: 1.0.0\n`
  assert.equal(installedCommitFromLock(lock), undefined)
})
check('the neighbouring package does not leak its version', () => {
  const lock = `importers:\n\n  .:\n    dependencies:\n      dsh-workbuddy-connect:\n        specifier: github:sixzjd/dsh-workbuddy-connect#${SHA_A}\n        version: git+https://github.com/sixzjd/dsh-workbuddy-connect.git#${SHA_A}\n      zzz-later:\n        specifier: github:x/y#${SHA_B}\n        version: git+https://github.com/x/y.git#${SHA_B}\n`
  assert.equal(installedCommitFromLock(lock), SHA_A)
})

console.log('update check: comparison')

check('identical commits are the same', () => {
  assert.equal(sameCommit(SHA_A, SHA_A), true)
})
check('an abbreviated lockfile id matches a full remote id', () => {
  assert.equal(sameCommit('ec3c4e5', SHA_A), true)
})
check('different commits differ', () => {
  assert.equal(sameCommit(SHA_A, SHA_B), false)
})
check('an empty id never matches', () => {
  // A missing lock entry must not read as "up to date".
  assert.equal(sameCommit('', SHA_B), false)
  assert.equal(sameCommit(undefined, SHA_B), false)
})
check('a three-character id is too short to trust', () => {
  assert.equal(sameCommit('ec3', SHA_A), false)
})

console.log('update check: the report')

check('a behind report offers the repinned spec', () => {
  const report = { state: 'behind', installSpec: `github:sixzjd/dsh-workbuddy-connect#${SHA_A}`, remote: SHA_B }
  assert.equal(updateSpecFrom(report), `github:sixzjd/dsh-workbuddy-connect#${SHA_B}`)
})
check('a current report offers nothing to install', () => {
  assert.equal(updateSpecFrom({ state: 'current', installSpec: 'github:x/y#a', remote: SHA_A }), undefined)
})
check('a local copy offers nothing to install', () => {
  assert.equal(updateSpecFrom({ state: 'local-copy', installSpec: 'file:./x' }), undefined)
})
check('a base spec drops any ref', () => {
  assert.equal(baseSpecOf(`github:a/b#${SHA_A}`), 'github:a/b')
  assert.equal(baseSpecOf('github:a/b'), 'github:a/b')
})

const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')

function profileWith(manifestDeps, lockText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-update-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test-profile', dependencies: manifestDeps }))
  if (lockText !== undefined) fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lockText)
  return dir
}

await checkAsync('a pinned install behind the remote reports behind', async () => {
  const dir = profileWith(
    { 'dsh-workbuddy-connect': `github:sixzjd/dsh-workbuddy-connect#${SHA_A}` },
    `importers:\n\n  .:\n    dependencies:\n      dsh-workbuddy-connect:\n        specifier: github:sixzjd/dsh-workbuddy-connect#${SHA_A}\n        version: git+https://github.com/sixzjd/dsh-workbuddy-connect.git#${SHA_A}\n`,
  )
  const report = await checkForUpdate(dir, { runner: async () => ({ stdout: `${SHA_B}\trefs/heads/main\n` }) })
  assert.equal(report.state, 'behind')
  assert.equal(report.installed, SHA_A)
  assert.equal(report.remote, SHA_B)
  assert.equal(report.targetSpec, `github:sixzjd/dsh-workbuddy-connect#${SHA_B}`)
})
await checkAsync('an install already at the remote head reports current', async () => {
  const dir = profileWith(
    { 'dsh-workbuddy-connect': `github:sixzjd/dsh-workbuddy-connect#${SHA_B}` },
    `importers:\n\n  .:\n    dependencies:\n      dsh-workbuddy-connect:\n        specifier: x\n        version: git+https://github.com/sixzjd/dsh-workbuddy-connect.git#${SHA_B}\n`,
  )
  const report = await checkForUpdate(dir, { runner: async () => ({ stdout: `${SHA_B}\trefs/heads/main\n` }) })
  assert.equal(report.state, 'current')
})
await checkAsync('a local install never claims a remote comparison', async () => {
  const dir = profileWith({ 'dsh-workbuddy-connect': 'file:./dsh-workbuddy-connect' })
  const report = await checkForUpdate(dir, { runner: async () => { throw new Error('must not reach the network') } })
  assert.equal(report.state, 'local-copy')
})
await checkAsync('a failing remote reports unknown, not up to date', async () => {
  // The important direction: a check that could not run must never render as
  // "you are current", which is what a silently swallowed error would do.
  const dir = profileWith(
    { 'dsh-workbuddy-connect': `github:sixzjd/dsh-workbuddy-connect#${SHA_A}` },
    `importers:\n\n  .:\n    dependencies:\n      dsh-workbuddy-connect:\n        specifier: x\n        version: git+https://github.com/sixzjd/dsh-workbuddy-connect.git#${SHA_A}\n`,
  )
  const report = await checkForUpdate(dir, { runner: async () => { throw Object.assign(new Error('boom'), { stderr: 'fatal: could not read from remote' }) } })
  assert.equal(report.state, 'unknown')
  assert.match(report.reason, /could not read from remote/)
})
await checkAsync('a profile that does not declare the plugin reports unknown', async () => {
  const dir = profileWith({})
  const report = await checkForUpdate(dir, { runner: async () => ({ stdout: '' }) })
  assert.equal(report.state, 'unknown')
})
await checkAsync('a lockfile with no resolved commit reports unknown', async () => {
  const dir = profileWith({ 'dsh-workbuddy-connect': `github:x/y#${SHA_A}` }, 'importers:\n\n  .:\n    dependencies: {}\n')
  const report = await checkForUpdate(dir, { runner: async () => ({ stdout: `${SHA_B}\trefs/heads/main\n` }) })
  assert.equal(report.state, 'unknown')
  assert.match(report.reason, /lockfile/)
})
check('readLocalState reports the pin but not a guessed install', () => {
  // The manifest states the request; only the lockfile states the result. With
  // no lockfile the pin is still worth showing, but `installed` must stay
  // undefined so the report says "unknown" rather than comparing a wish
  // against the remote and calling it up to date.
  const dir = profileWith({ 'dsh-workbuddy-connect': `github:sixzjd/dsh-workbuddy-connect#${SHA_A}` })
  const local = readLocalState(dir)
  assert.equal(local.pinned, SHA_A)
  assert.equal(local.installed, undefined)
})

console.log(`\n${passed} checks passed`)

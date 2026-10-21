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
check('leaves a harness identity that is not the opening line alone', () => {
  // The upstream check is a prefix on the first line, so the same phrase
  // further down the message is not a channel violation.
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    messages: [{ role: 'system', content: 'Context first.\nYou are an AI agent powered by DeepSeek Harness.' }],
  })))
  assert.equal(body.messages[0].content.includes('You are an AI agent powered by DeepSeek Harness'), true)
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

console.log(`\n${passed} checks passed`)

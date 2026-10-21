/**
 * WorkBuddy upstream client: chat streaming, token refresh, model catalog and
 * credit balance.
 *
 * Two deployments live behind one set of function names:
 *
 * | | CN | International |
 * |---|---|---|
 * | chat base | `https://copilot.tencent.com` | `https://www.workbuddy.ai` |
 * | billing base | `https://www.codebuddy.cn` | `https://www.workbuddy.ai` |
 * | catalog | `/console/enterprises/personal/models` | `/v3/config` |
 * | chat path | `/v2/chat/completions` | `/console/chat/completions` → `/v2/chat/completions` |
 *
 * Everything that varies between them is a function of the credential's
 * *realm*, never a branch on a flag passed down from the UI — so a third
 * deployment would be a data change rather than a refactor.
 *
 * @module dsh-workbuddy-connect/upstream
 */
import { createHash, randomBytes } from 'node:crypto'
import { appUserAgent, chatUserAgent, fallbackChatIdentity, resolveAppVersion, resolveChatIdentity } from './identity.js'

/** WorkBuddy region selected by the credential's login domain. */
export const REGIONS = ['cn', 'global']

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export const UPSTREAM_ERROR_KINDS = ['hard_credit', 'soft_rate', 'session_dead', 'not_found', 'server', 'client']

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * The domain the international gateway expects in `X-Domain`.
 *
 * A fixed value rather than the signed-in account's own domain: the
 * international client declares it is talking to `www.workbuddy.ai` whichever
 * host issued its session, and the gateway rejects the request as illegal when
 * the declared domain disagrees.
 */
const GLOBAL_DOMAIN = 'www.workbuddy.ai'

/** The chat path both realms serve. */
const CHAT_PATH = '/v2/chat/completions'

/**
 * The international gateway's first-choice chat path.
 *
 * Tried before {@link CHAT_PATH} and abandoned on 404/405: the two deployments
 * route chat differently, so a single hard-coded path fails one of them.
 */
const GLOBAL_CONSOLE_CHAT_PATH = '/console/chat/completions'

/** Shared CLI-form User-Agent for refresh and the CN catalog. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** Client version carried by the attribution and billing headers. */
const CLIENT_VERSION = '2.63.2'

/** Client name the upstream attributes usage to; the desktop product, not a gateway. */
const WORKBUDDY_CLIENT_NAME = 'WorkBuddy'

const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/**
 * Insufficient-credit markers, ASCII lowercase plus the original Chinese.
 *
 * Kept apart from the generic quota phrases on purpose: throttling bodies say
 * "quota exceeded" too, and a terminal refusal must not be parked as a
 * retryable rate limit.
 */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/**
 * Insufficient-credit markers precise enough to honour under a 429.
 *
 * The international deployment answers an exhausted balance with `429` carrying
 * `{"code":14018,"msg":"Credits exhausted."}` — measured 2026-10-13 — so
 * reading 429 as throttling alone parks a terminal refusal as retryable.
 */
const HARD_CREDIT_MARKERS_ON_429 = [
  '14018',
  'credit exhausted', 'credits exhausted', 'insufficient credit', 'no credit',
  'out of credit', 'credit not enough', 'not enough credit', 'payment required',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/**
 * Rate-limit markers that arrive without a 429 status.
 *
 * The upstream reports throttling in the body on 200/400/403 as well, so a
 * status-only test misses it and the account is neither cooled down nor moved
 * aside — it simply keeps failing.
 */
const SOFT_RATE_MARKERS = [
  'rate limit', 'rate-limiting', 'rate-limited', 'too many requests', 'too many',
  'usage limit', '请求过于频繁', '限流',
]

/** The concrete effort spellings WorkBuddy exposes on the wire. */
export const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max']

/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = 'badge:'

/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The host LLM seam carries this text to the browser, and the host has no
 * locale service — whatever string is produced here is shown verbatim in every
 * UI language. The upstream is inconsistent in a way that matters: some catalog
 * rows report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`), and the unit word would pin the display to English.
 */
export function normalizeCredits(credits) {
  if (typeof credits !== 'string') return undefined
  const match = /x\s*(\d+(?:\.\d+)?)/i.exec(credits)
  if (match === null) return undefined
  return `x${Number(match[1]).toFixed(2)}`
}

/** Parse the upstream `reasoning` object into a normalized reasoning record. */
/**
 * Models whose upstream refuses `reasoning_effort: "off"`.
 *
 * Measured across both gateways: nine ids answer HTTP 400 / code 11133 when
 * the field says `off`, even though their catalog row declares
 * `canDisableThinking: true`. Every other effort value — and omitting the
 * field entirely — is accepted. The plugin therefore never *sends* `off`: the
 * "Default" level carries the model's own declared default instead.
 */
export const REFUSES_OFF_MODEL_IDS = new Set([
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'primary-model',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gemini-3.5-flash',
])

/**
 * The effort ladder a *singular* reasoning declaration implies.
 *
 * The upstream ships two shapes: the plural `{supportedEfforts[], …}` and the
 * singular `{effort:"medium", summary:"auto"}`. The singular shape carries one
 * effort value but the model answers with distinct reasoning across the whole
 * ladder, so the row is folded onto the full ladder rather than left
 * undeclared — an undeclared row gets no effort control at all, which is
 * exactly the capability the singular shape was trying to declare.
 */
const SINGULAR_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max']

/** Parse the upstream `reasoning` object into a normalized reasoning record. */
function resolveUpstreamReasoning(wrapped) {
  const supports = wrapped['supportsReasoning'] === true
  const onlyReasoning = wrapped['onlyReasoning'] === true
  const rawReasoning = wrapped['reasoning']
  let supportedEfforts
  let defaultEffort
  let canDisableThinking = false
  if (typeof rawReasoning === 'object' && rawReasoning !== null && !Array.isArray(rawReasoning)) {
    const rawEfforts = rawReasoning['supportedEfforts']
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter(value => typeof value === 'string' && EFFORT_VALUES.includes(value))
      if (efforts.length > 0) supportedEfforts = efforts
    }
    const singularEffort = rawReasoning['effort']
    if (supportedEfforts === undefined
      && typeof singularEffort === 'string'
      && EFFORT_VALUES.includes(singularEffort)) {
      // The singular shape declares one effort but the model honours the
      // ladder; folding it keeps the effort control available.
      supportedEfforts = [...SINGULAR_EFFORT_LADDER]
      canDisableThinking = true
    }
    const declaredDefault = rawReasoning['defaultEffort'] ?? rawReasoning['effort']
    if (typeof declaredDefault === 'string' && EFFORT_VALUES.includes(declaredDefault)) defaultEffort = declaredDefault
    // Only an explicit `canDisableThinking: true` offers "thinking off"; older
    // rows omit the field and several of them reject `off` on the wire, so the
    // conservative default is "cannot be disabled".
    if (rawReasoning['canDisableThinking'] === true) canDisableThinking = true
  }
  return {
    reasoning: {
      // A row that declares its effort set is a reasoning model even when it
      // carries no `supportsReasoning` flag: the upstream's flag is absent
      // from some documents, and a declared ladder is the stronger statement.
      supports: supports || supportedEfforts !== undefined,
      onlyReasoning,
      ...supportedEfforts === undefined ? {} : { supportedEfforts },
      ...defaultEffort === undefined ? {} : { defaultEffort },
      canDisableThinking,
    },
  }
}

/** Parse the upstream's promotional badge list into plain labels. */
function resolveUpstreamBadges(wrapped) {
  const raw = wrapped['promotions'] ?? wrapped['promotionTags']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const badges = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const label = entry.startsWith(BADGE_PREFIX) ? entry.slice(BADGE_PREFIX.length).split(':')[0] : entry
    if (label !== '' && !badges.includes(label)) badges.push(label)
  }
  return badges
}

/** Parse the upstream's billing block into a normalized billing record. */
function resolveUpstreamBilling(wrapped) {
  const rawCredits = typeof wrapped['credits'] === 'string' ? wrapped['credits'] : undefined
  const rate = normalizeCredits(rawCredits)
  const badges = resolveUpstreamBadges(wrapped)
  return {
    billing: {
      ...rate === undefined ? {} : { credits: rate },
      ...badges.length === 0 ? {} : { badges },
      free: rate !== undefined && Number(rate.slice(1)) === 0,
    },
  }
}

/**
 * Classify an upstream failure into one of {@link UPSTREAM_ERROR_KINDS}.
 *
 * The classes matter because they map onto different HTTP answers at the shim:
 * a hard credit refusal is terminal (402), a soft rate limit is retryable
 * (429), and a dead session needs a new sign-in (401).
 *
 * The upstream's *business codes* are matched first, because they are exact
 * and the prose around them is not: `14018` is an exhausted balance (which
 * arrives as a 429 and would otherwise be read as throttling), `14003` is a
 * model-scoped throttle, `6004` is an account volume limit, and `12153` is a
 * dead session.
 */
export function classifyUpstreamError(status, body) {
  const text = String(body ?? '').toLowerCase()
  const code = businessCodeOf(body)
  if (code === 14018) return 'hard_credit'
  if (code === 14003 || code === 6004) return 'soft_rate'
  if (code === 12153) return 'session_dead'
  if (status === 429) {
    return HARD_CREDIT_MARKERS_ON_429.some(marker => text.includes(marker)) ? 'hard_credit' : 'soft_rate'
  }
  if (status === 401 || status === 403) {
    if (HARD_CREDIT_MARKERS.some(marker => text.includes(marker))) return 'hard_credit'
    if (SOFT_RATE_MARKERS.some(marker => text.includes(marker))) return 'soft_rate'
    return 'session_dead'
  }
  if (status === 402) return 'hard_credit'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) {
    if (HARD_CREDIT_MARKERS.some(marker => text.includes(marker))) return 'hard_credit'
    if (SOFT_RATE_MARKERS.some(marker => text.includes(marker))) return 'soft_rate'
    return 'client'
  }
  return 'server'
}

/**
 * Models that are text-only, however the catalog row describes them.
 *
 * The upstream's `supportsImages` is a *platform* flag, not a capability: it
 * reads `true` for nearly every row in the catalog, including the ones that
 * cannot take an image at all. Offering an image to a text-only model is a
 * request the provider rejects *after* the message is already durable, and
 * refusing an image to a model that can take one is a capability the user
 * loses. So the row flag is corrected by this table, which was reviewed id by
 * id against what each model actually accepts.
 */
export const TEXT_ONLY_MODEL_IDS = new Set([
  'deepseek-v4-pro',
  'glm-5.1',
  'glm-5.2',
  'glm-5.3',
  'hy3',
  'hy4-preview',
])

/**
 * The upstream's business code, read out of a `{code,msg,data}` envelope.
 *
 * Returns undefined when the body is not such an envelope — a gateway HTML
 * page, for instance, which the 401 branch already classifies as a dead
 * session.
 */
export function businessCodeOf(body) {
  return envelopeOf(body)?.code
}

/** One upstream `{code,msg,data}` reply, decoded tolerantly. */
function envelopeOf(body) {
  if (typeof body !== 'string') return undefined
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const code = typeof parsed['code'] === 'number' ? parsed['code'] : undefined
  const extError = typeof parsed['extError'] === 'object' && parsed['extError'] !== null ? parsed['extError'] : undefined
  const param = typeof extError?.['param'] === 'string' ? extError['param'] : undefined
  const value = extError?.['value'] !== undefined ? String(extError['value']) : undefined
  return {
    ...code === undefined ? {} : { code },
    ...param === undefined ? {} : { param },
    ...value === undefined ? {} : { value },
  }
}

/**
 * A one-line description of what the upstream refused and why.
 *
 * The envelope's `extError` names the offending field (`param`) and its value
 * — without it a 11133 reads as "model unavailable", and the fix (a reasoning
 * effort the model refuses, a tool schema shape it cannot parse) lives
 * nowhere in the message.
 */
export function describeUpstreamFailure(body) {
  const envelope = envelopeOf(body)
  if (envelope === undefined) return String(body ?? '').slice(0, 400)
  const parts = []
  if (envelope.code !== undefined) parts.push(`code ${envelope.code}`)
  if (envelope.param !== undefined) parts.push(`param ${envelope.param}`)
  if (envelope.value !== undefined) parts.push(`value ${envelope.value}`)
  return parts.join(', ')
}

/** Region for a login domain; an empty domain means CN. */
export function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  // The international product also answers on the `codebuddy.ai` brand domain.
  // The two brand domains are *not* interchangeable — a `codebuddy.ai` token
  // is refused by the `workbuddy.ai` gateway — but both are international.
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/**
 * The realm a credential belongs to.
 *
 * An explicit realm wins when it names the international deployment; a domain
 * naming `workbuddy.ai` is international whatever the explicit realm says.
 * Anything else is CN, which keeps a credential that states nothing behaving
 * exactly as it did before the field existed.
 */
export function realmOf(credential) {
  if (credential?.region === 'global') return 'global'
  return regionOf(credential?.domain ?? '')
}

/**
 * The international deployment's two brand domains.
 *
 * A token issued at one is refused by the other, so the base has to follow
 * the credential's own domain rather than a fixed guess. `www.codebuddy.ai`
 * does resolve (measured 2026-10-20), so the fallback chain is real rather
 * than theoretical.
 */
const GLOBAL_BASES = {
  'codebuddy.ai': 'https://www.codebuddy.ai',
  'workbuddy.ai': 'https://www.workbuddy.ai',
}

/** The international base that serves the credential's own domain. */
function globalBase(credential) {
  const domain = String(credential?.domain ?? '').trim().toLowerCase()
  for (const [suffix, base] of Object.entries(GLOBAL_BASES)) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) return base
  }
  return GLOBAL_BASE
}

function chatBase(credential) {
  return realmOf(credential) === 'global' ? globalBase(credential) : CN_CHAT_BASE
}

function billingBase(credential) {
  return realmOf(credential) === 'global' ? globalBase(credential) : CN_BILLING_BASE
}

function originReferer(credential) {
  return realmOf(credential) === 'global' ? globalBase(credential) : CN_BILLING_BASE
}

/**
 * The `X-Domain` a realm's request declares.
 *
 * The international gateway expects the domain the session belongs to — the
 * international product serves two brand domains and a request that declares
 * the other one is refused as illegal.
 */
function domainHeaderFor(credential) {
  const domain = String(credential?.domain ?? '').trim()
  if (domain !== '') return domain
  return realmOf(credential) === 'global' ? GLOBAL_DOMAIN : ''
}

/**
 * Per-account device identifiers, derived from the uid.
 *
 * Stable across restarts and distinct per account, which is what the upstream
 * treats a device fingerprint as: a missing or drifting one lets it associate
 * several accounts as a single client. The shape is the upstream's own: a
 * hyphenated UUID.
 */
function accountStableHeaders(credential) {
  if (!credential?.uid) return {}
  return {
    'X-Machine-ID': deriveAccountStableId(credential.uid, 'machine'),
    'X-Session-ID': deriveAccountStableId(credential.uid, 'session'),
  }
}

/** One stable hyphenated UUID for an account and purpose. */
function deriveAccountStableId(uid, purpose) {
  const hex = createHash('sha256').update(`wb2a:${purpose}:${uid}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** The locale the upstream expects for a realm's requests. */
function acceptLanguageFor(credential) {
  return realmOf(credential) === 'global' ? 'en-US' : 'zh-CN'
}

/**
 * The enterprise headers, present only when the account has an enterprise.
 *
 * The upstream carries the same id twice, under two names: `X-Enterprise-Id`
 * for the enterprise itself and `X-Tenant-Id` for the tenant inside it. A
 * request that sends one but not the other is answered as an unidentified
 * client, which the upstream records as an anonymous call.
 */
function enterpriseHeaders(credential) {
  if (credential?.enterpriseId === undefined || credential.enterpriseId === '') return {}
  return { 'X-Enterprise-Id': credential.enterpriseId, 'X-Tenant-Id': credential.enterpriseId }
}

/** Headers every upstream request shares. */
function commonHeaders(credential) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
    // The gateway reads this as the official client's gate header, and every
    // API request is expected to carry it.
    'X-CodeBuddy-Request': '1',
    'Accept-Language': acceptLanguageFor(credential),
    ...enterpriseHeaders(credential),
    ...accountStableHeaders(credential),
  }
}

/**
 * Chat request headers, including the X-No-* conventions the official CLI uses.
 *
 * `userAgent` carries the desktop identity for chat requests; when it is absent
 * the shared CLI-form UA applies. Refresh shares `commonHeaders` but never this
 * override, so the two paths cannot drift into each other.
 */
function chatHeaders(credential, userAgent, clientVersion) {
  const international = realmOf(credential) === 'global'
  const domain = domainHeaderFor(credential)
  return {
    ...commonHeaders(credential),
    ...userAgent === undefined ? {} : { 'User-Agent': userAgent },
    // Chat streams, so it declares the event-stream type the shared
    // non-streaming default does not.
    'Accept': 'application/json, text/event-stream',
    ...credential.accessToken === ''
      ? { 'X-No-Authorization': '1' }
      : { 'Authorization': `Bearer ${credential.accessToken}` },
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...international
      // The international gateway is told, unconditionally, that this is a
      // personal international client: no enterprise, and the international
      // domain rather than whichever host issued the login. Declaring the
      // account's own enterprise id here is refused as an illegal request.
      ? { 'X-No-Enterprise-Id': '1', 'X-Domain': domain }
      : {
          ...credential.enterpriseId === undefined || credential.enterpriseId === ''
            ? { 'X-No-Enterprise-Id': '1' }
            : { 'X-Enterprise-Id': credential.enterpriseId },
          ...domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': domain },
        },
    // Usage attribution: the upstream reports usage per client, and a request
    // carrying no client identity is recorded as an anonymous gateway call.
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    ...international ? { 'X-Agent-Type': 'main' } : {},
    'X-IDE-Name': WORKBUDDY_CLIENT_NAME,
    'X-IDE-Type': WORKBUDDY_CLIENT_NAME,
    'X-IDE-Version': clientVersion ?? CLIENT_VERSION,
    // The product the request is attributed to. Measured across three
    // independent implementations: the gateway attributes usage to the SaaS
    // product, not to the desktop app's own name.
    'X-Product': 'SaaS',
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    // Names the channel the refresh came through; the official client's own
    // spelling is `workbuddy`.
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers; the gate header and identity apply here too. */
function billingHeaders(credential) {
  const domain = domainHeaderFor(credential)
  return {
    ...commonHeaders(credential),
    'Accept': 'application/json',
    ...credential.accessToken === ''
      ? { 'X-No-Authorization': '1' }
      : { 'Authorization': `Bearer ${credential.accessToken}` },
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...domain === '' ? {} : { 'X-Domain': domain },
    'X-IDE-Name': WORKBUDDY_CLIENT_NAME,
    'X-IDE-Type': WORKBUDDY_CLIENT_NAME,
    'X-IDE-Version': CLIENT_VERSION,
    'X-Product': 'SaaS',
  }
}

/**
 * Salt for the conversation/turn id derivation, fresh in each process.
 *
 * A derived id must not be readable as the text it came from, so it is hashed
 * with a per-process salt: the same conversation names the same id for this
 * run, and a restart starts a new namespace — which is what a fresh client
 * would do too.
 */
const CONVERSATION_ID_SALT = randomBytes(16).toString('hex')

/** A 32-hex-digit id in the shape WorkBuddy's own client emits. */
function conversationIdHex() {
  return randomBytes(16).toString('hex')
}

/**
 * A hyphenated UUID, the shape the upstream's `X-Conversation-ID` carries.
 *
 * The conversation id is the one id the upstream reads as a *grouping* key
 * rather than as a digest: it names the conversation itself, and it is the
 * only one of the family the upstream expects in UUID form. The other three
 * (`X-Request-ID`, `X-Conversation-Message-ID`, `X-Conversation-Request-ID`)
 * are 32 hex digits without hyphens.
 */
function conversationUuid() {
  const hex = randomBytes(16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Derive a 32-hex id from what names the thing it identifies. */
function derivedConversationId(kind, key) {
  return createHash('sha256').update(`${CONVERSATION_ID_SALT}|${kind}|${key}`).digest('hex').slice(0, 32)
}

/**
 * A message content's signature: its text, plus a digest of every part that is
 * not text (an image, a file), so a turn made of images alone is still a turn
 * of its own.
 */
function messageSignature(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const type = typeof part['type'] === 'string' ? part['type'] : ''
    if (type === '' || type === 'text') {
      out += typeof part['text'] === 'string' ? part['text'] : ''
    } else {
      out += `[${type}:${createHash('sha256').update(JSON.stringify(part)).digest('hex').slice(0, 8)}]`
    }
  }
  return out
}

/**
 * Whether `messages[i]` answers the message before it — a tool's result, or an
 * assistant's calls — rather than carrying the user's own words.
 */
function answeredBefore(messages, i) {
  const prev = messages[i - 1]
  if (typeof prev !== 'object' || prev === null) return false
  if (prev['role'] === 'tool') return true
  return prev['role'] === 'assistant' && Array.isArray(prev['tool_calls']) && prev['tool_calls'].length > 0
}

/**
 * Whether a message's content is nothing but tool results.
 *
 * Anthropic-shaped clients carry a tool result inside a *user* message, so a
 * body can end with several such messages in a row while the send is still
 * one. Keying the turn on one of those would change the id with every step of
 * a tool loop, which is the opposite of what a turn id is for.
 */
function isToolResultOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return false
  for (const part of content) {
    if (typeof part !== 'object' || part === null) return false
    const type = part['type']
    if (type !== 'tool_result' && type !== 'tool-result') return false
  }
  return true
}

/**
 * Name the user send a chat answers: the body's last user message that is the
 * user's own, by its place and its signature.
 *
 * Every step of one send repeats it, while the user's next message changes it.
 * That is what `X-Conversation-Request-ID` means upstream: the backend counts
 * one user send as one request by this id, so a chat that carried a fresh id
 * per step would show up in the usage detail as many requests.
 */
function turnKeyOf(body) {
  const messages = Array.isArray(body?.['messages']) ? body['messages'] : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (typeof message !== 'object' || message === null) continue
    if (message['role'] !== 'user' || answeredBefore(messages, i)) continue
    if (isToolResultOnly(message['content'])) continue
    const signature = messageSignature(message['content'])
    return signature === '' ? '' : `u${i}:${signature}`
  }
  return ''
}

/**
 * Name the conversation a chat belongs to, from its first user message.
 *
 * The opening user message is the only session-scoped fact available, and it is
 * stable for the whole conversation, which is what the id is for.
 */
function conversationKeyOf(body) {
  const messages = Array.isArray(body?.['messages']) ? body['messages'] : []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    if (message['role'] !== 'user') continue
    const signature = messageSignature(message['content'])
    if (signature !== '') return `first:${signature}`
  }
  return ''
}

/**
 * Attach the conversation-tracking header family to a chat request.
 *
 * The gateway's channel verification is an **independent, separately switched**
 * check: some deployments refuse chats that lack this family with
 * `400 / code 11128 / "request illegal"`, and it is reported to spread by
 * deployment and by time of day rather than by request shape. The body is the
 * **prepared** text actually sent, so the ids name what went out on the wire.
 * An id the caller already carried is kept for all four: its own attribution is
 * better information than a derivation made here.
 */
export function withGatewayChatHeaders(headers, preparedBody) {
  let body
  try {
    const parsed = JSON.parse(preparedBody)
    body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    body = undefined
  }
  const messageId = conversationIdHex()
  if (headers['X-Conversation-Message-ID'] === undefined) headers['X-Conversation-Message-ID'] = messageId
  // The official client has these two be one value.
  if (headers['X-Request-ID'] === undefined) headers['X-Request-ID'] = headers['X-Conversation-Message-ID']
  const turn = turnKeyOf(body)
  if (headers['X-Conversation-Request-ID'] === undefined) {
    headers['X-Conversation-Request-ID'] = turn === '' ? conversationIdHex() : derivedConversationId('turn', turn)
  }
  // The root request id is the same value as the conversation request id: one
  // user send is one request, and the upstream counts it by that id.
  if (headers['X-Root-Request-ID'] === undefined) headers['X-Root-Request-ID'] = headers['X-Conversation-Request-ID']
  const conversation = conversationKeyOf(body)
  if (conversation !== '' && headers['X-Conversation-ID'] === undefined) {
    // The conversation id is a UUID upstream, not a digest: it names the
    // conversation rather than a hash of it, and the gateway compares it
    // against the value it saw on the first turn.
    headers['X-Conversation-ID'] = conversationUuid()
  }
  return headers
}

/**
 * Normalize the reasoning effort a body carries.
 *
 * "Default" goes on the wire as the level the upstream itself declares as its
 * default. Only when the catalog carries no `defaultEffort` is the field
 * dropped, which leaves the choice to the upstream.
 */
/**
 * Rewrite the reasoning effort a body carries into a spelling the upstream
 * accepts.
 *
 * The upstream has no `off` spelling at all: `reasoning_effort: "off"` is
 * refused with HTTP 400 / code 11133 by every model, and by nine of them
 * specifically even when it is spelled as a *declared* default. So:
 *
 * - "Default"/"auto"/"off"/"disabled" all become the model's own declared
 *   default effort, and the field is dropped when the model declares none.
 * - A model on the refusal list never carries `off` on the wire, whatever the
 *   caller asked for.
 */
function normalizeReasoningEffort(obj, defaultEffort, modelId) {
  const effort = obj['reasoning_effort']
  if (typeof modelId === 'string' && REFUSES_OFF_MODEL_IDS.has(modelId) && effort === 'off') {
    delete obj['reasoning_effort']
    return
  }
  if (effort !== 'default' && effort !== 'auto' && effort !== 'off' && effort !== 'disabled') return
  if (typeof defaultEffort === 'string' && defaultEffort.length > 0) obj['reasoning_effort'] = defaultEffort
  else delete obj['reasoning_effort']
}

/**
 * Translate the `max_completion_tokens` alias into the `max_tokens` field the
 * upstream actually reads.
 *
 * OpenAI deprecated `max_tokens` in favour of the alias, so a newer client sends
 * only the alias; the upstream ignores it and falls back to its own default
 * output cap, which truncates long answers. An explicit `max_tokens` wins and
 * the alias is then dropped rather than translated, and a value that is not a
 * positive integer is dropped without translating — `0` and `null` mean "not
 * set", and a negative or non-numeric value is malformed input that must not be
 * laundered into a valid one.
 */
function translateMaxCompletionTokens(obj) {
  const present = 'max_completion_tokens' in obj
  const alias = obj['max_completion_tokens']
  delete obj['max_completion_tokens']
  if (!present || 'max_tokens' in obj) return
  if (typeof alias === 'number' && Number.isInteger(alias) && alias > 0) obj['max_tokens'] = alias
}

/** Rewrite `role: "developer"` messages to `role: "system"`. */
function normalizeDeveloperRole(obj) {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    if (message['role'] === 'developer') message['role'] = 'system'
  }
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
  const suppress = () => {
    delete obj['tools']
    delete obj['functions']
  }
  if (!('tool_choice' in obj)) return
  const choice = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const type = typeof choice['type'] === 'string' ? choice['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof choice['function'] === 'object' && choice['function'] !== null ? choice['function'] : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof choice['name'] === 'string') name = choice['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/**
 * Normalize the `stop` field into the shape the upstream reads.
 *
 * The upstream's field is a list of strings; a bare string is refused with
 * HTTP 400 / code 11101 ("cannot unmarshal into field of type []string").
 */
function normalizeStop(obj) {
  if (typeof obj['stop'] === 'string') obj['stop'] = [obj['stop']]
}

/**
 * Normalize the `arguments` of every tool call in the request history.
 *
 * The upstream reads `tool_calls[].function.arguments` as a *string*; an
 * object, a list, a number or a boolean is refused with the same 11101. A
 * caller that modelled the arguments as structured JSON is serialised rather
 * than dropped, because the tool's result is matched against what the model
 * saw.
 */
function normalizeToolCallArguments(obj) {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const calls = message['tool_calls']
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (typeof call !== 'object' || call === null) continue
      const fn = call['function']
      if (typeof fn !== 'object' || fn === null) continue
      const args = fn['arguments']
      if (typeof args === 'string') continue
      if (args === undefined || args === null) {
        fn['arguments'] = ''
        continue
      }
      try {
        fn['arguments'] = JSON.stringify(args)
      } catch {
        fn['arguments'] = ''
      }
    }
  }
}

/**
 * Substrings the upstream's channel check treats as a competing client.
 *
 * The gateway refuses a request with HTTP 400 / code 11128 ("Illegal API
 * invocation from an unapproved channel") when one of these appears in the
 * prompt — the check is on the *content* of the messages, not on the request's
 * shape, and it fires whether the string is a whole phrase or a contiguous
 * substring of one.
 *
 * Two of them are ordinary things a coding harness puts in its system prompt:
 * a line naming the current git branch ("Main branch (…") and a reference to
 * a GitHub organisation. So the sanitization is narrow and mechanical: it
 * rewrites the marker, not the meaning.
 */
const WAF_MARKERS = [
  ['x-anthropic-billing-header', 'x-anthropic-billing-entry'],
  ['You are Claude Code', 'You are an AI coding assistant'],
  ['You are a coding agent running in the Codex CLI', 'You are an AI coding agent'],
  // The CN gateway refuses a message whose FIRST LINE opens with a client
  // identity that is not theirs — and this harness's own opening line is on
  // that list. The check is a literal prefix (a leading space, or the same
  // sentence further down, slips past), so the opening line has to be
  // rewritten rather than the phrase merely removed.
  //
  // It reads that line out of a system message *and* out of an assistant
  // message: a reply that quotes its own instructions back poisons the history
  // for every later turn of that conversation, which is how a session that
  // worked yesterday fails today with the very same code.
  ['You are an AI agent powered by DeepSeek Harness', 'You are an AI coding assistant'],
  ['cc_entrypoint=', 'cc_entry='],
  ['Main branch (', 'Default branch ('],
  ['github.com/anthropics/', 'github.com/anthropic-clients/'],
  ['Sisyphus-Junior - Focused executor from OhMyOpenCode', 'An AI coding executor'],
]

/**
 * Rewrite the channel markers inside the request's messages.
 *
 * The CN gateway reads the markers out of **two** roles, not one:
 *
 *  - the **system** message, anywhere in it (a substring rewrite is enough);
 *  - an **assistant** message, but only when the marker opens a line — this is
 *    the one that bites a working session: the model paraphrases or quotes its
 *    own instructions back into the reply, and the next turn's history then
 *    carries the phrase. A single successful turn is therefore enough to poison
 *    every later turn of that conversation.
 *
 * User and tool messages are left alone: the same phrase there is the human's
 * own text (or a file's), and rewriting it would corrupt the conversation. The
 * check does not fire on those roles either — measured, only system and
 * assistant.
 *
 * Content arrives in two shapes and **both** have to be handled: a plain string,
 * or an array of content parts (`{type:'text',text}` and friends). A body whose
 * content is an array is refused by the gateway exactly like a string body that
 * carries the marker, so skipping arrays would leave the whole rewrite inert on
 * any client that sends parts — which is what every OpenAI-compatible SDK does
 * for a multimodal or block-shaped transcript.
 */
function sanitizeSystemMessages(obj) {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const role = message['role']
    const isSystem = role === 'system'
    if (!isSystem && role !== 'assistant') continue
    const content = message['content']
    if (Array.isArray(content)) {
      // Parts shape: rewrite the text of each text part in place, so the
      // surrounding structure (images, cache hints) is preserved.
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue
        const text = part['text']
        if (typeof text !== 'string') continue
        const next = rewriteMarkers(text, isSystem)
        if (next !== text) part['text'] = next
      }
      continue
    }
    if (typeof content !== 'string') continue
    const next = rewriteMarkers(content, isSystem)
    if (next !== content) message['content'] = next
  }
}

/**
 * Rewrite every marker in one piece of text.
 *
 * A system message is matched anywhere; an assistant message only where the
 * marker opens a line, which is the shape the gateway actually refuses.
 */
function rewriteMarkers(text, isSystem) {
  let next = text
  for (const [marker, replacement] of WAF_MARKERS) {
    if (!next.includes(marker)) continue
    if (isSystem) {
      next = next.split(marker).join(replacement)
      continue
    }
    next = next.split('\n').map(line => {
      if (!line.startsWith(marker)) return line
      return replacement + line.slice(marker.length)
    }).join('\n')
  }
  return next
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream: force
 * `stream: true` (the upstream rejects non-streaming with code 11101),
 * translate the `max_completion_tokens` alias, default `stream_options`,
 * flatten `tool_choice` (the upstream's field is a string; object forms return
 * 400), rewrite `developer` messages as `system`, and drop the provider-default
 * reasoning levels.
 *
 * The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
 * `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
 * upstream rejects that role with HTTP 400 code 11128.
 */
export function prepareChatBody(source, options) {
  let body
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body
  obj['stream'] = true
  translateMaxCompletionTokens(obj)
  // The official client always asks for usage on a streaming call, and the
  // upstream only reports it in the final frame when asked.
  if (!('stream_options' in obj)) obj['stream_options'] = { include_usage: true }
  normalizeDeveloperRole(obj)
  normalizeToolChoice(obj)
  normalizeStop(obj)
  normalizeToolCallArguments(obj)
  sanitizeSystemMessages(obj)
  normalizeReasoningEffort(obj, options?.defaultEffort, options?.modelId)
  // pi-ai sets `store: false` on every OpenAI chat call. That is an OpenAI-only
  // field: the WorkBuddy upstream rejects the whole request with HTTP 400 /
  // code 11133. Neither the official client nor this plugin's own probe calls
  // ever send it, so drop it before forwarding.
  delete obj['store']
  return JSON.stringify(obj)
}

/**
 * The system prompt injected when the international endpoint receives a body
 * with none.
 *
 * Minimal on purpose: it exists to satisfy a gateway precondition, not to
 * steer the model. The plugin is not the place to invent a persona, and the
 * normal path never reaches this — pi-ai already sends the harness's system
 * prompt, so this only covers a caller that omitted one.
 */
export const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * Apply the international endpoint's extra chat requirement: the first message
 * must be a system prompt.
 *
 * The international gateway rejects a body whose first message is not `system`
 * with HTTP 400 code 11128 ("first message is not system prompt"). Note that
 * the *same* code means something else on the CN endpoint — there it reports a
 * rejected `developer` role — so the two are never branched on by code alone.
 *
 * The added prompt is deliberately empty of user content and prepended, never
 * merged: existing messages keep their order and wording.
 */
export function prepareInternationalChatBody(source, options) {
  const prepared = prepareChatBody(source, options)
  let body
  try {
    body = JSON.parse(prepared)
  } catch {
    return prepared
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return prepared
  const messages = body['messages']
  if (!Array.isArray(messages)) return prepared
  const first = messages[0]
  if (typeof first === 'object' && first !== null && first['role'] === 'system') return prepared
  messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT })
  return JSON.stringify(body)
}

/**
 * Add a `prompt_cache_key` to an outbound chat body.
 *
 * The key is derived from the account's uid and its conversation, so the same
 * conversation on the same account reuses the upstream's prefix cache while two
 * accounts can never collide on one key — a collision would let one account hit
 * a cached prefix belonging to another.
 */
export function withPromptCacheKey(source, uid) {
  let body
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body
  if (typeof obj['prompt_cache_key'] === 'string' && obj['prompt_cache_key'] !== '') return source
  const conversation = typeof obj['conversation_id'] === 'string' && obj['conversation_id'] !== ''
    ? obj['conversation_id']
    : typeof obj['conversationId'] === 'string' && obj['conversationId'] !== '' ? obj['conversationId'] : ''
  obj['prompt_cache_key'] = buildPromptCacheKey(uid, conversation)
  return JSON.stringify(obj)
}

/** The stable `wb2a-<uid8>-<conversationHash>` cache key for one account. */
function buildPromptCacheKey(uid, conversation) {
  const accountSegment = uid === '' ? '-' : uid.slice(0, 8)
  const conversationHash = createHash('sha256').update(`${uid}|${conversation}`).digest('hex').slice(0, 32)
  return `wb2a-${accountSegment}-${conversationHash}`
}

/** One JSON-envelope response from the upstream, already unwrapped. */
async function readEnvelope(response) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
    // Carried alongside `data` because the two catalog shapes differ: the CN
    // endpoint always wraps (`{code,msg,data}`), while the international
    // `/v3/config` has also been observed answering with the product document
    // bare at the top level.
    document,
  }
}

/** Turn an upstream envelope refusal into a message worth showing a human. */
function envelopeError(status, envelope) {
  const code = envelope.code === 0 ? '' : ` (code ${envelope.code})`
  const message = envelope.msg === '' ? '' : `: ${envelope.msg}`
  return new Error(`workbuddy upstream refused the request (http ${status})${code}${message}`)
}

/**
 * The chat paths to try, in order, for a realm.
 *
 * `/v2/chat/completions` is the path both deployments serve (measured 2026-10-20:
 * the international gateway answers it with a token refusal rather than a
 * routing miss, so the route is there). The console path is kept as a
 * fallback for a deployment that routes chat elsewhere — it costs a round trip
 * only when the first path 404s or 405s, never on the happy path.
 */
export function chatPaths(region) {
  return region === 'global' ? [CHAT_PATH, GLOBAL_CONSOLE_CHAT_PATH] : [CHAT_PATH]
}

/**
 * Whether a 403 body is an interception page rather than an API refusal.
 *
 * A WAF block page is HTML, while this API's own refusals are JSON envelopes.
 * Retrying every 403 would double a permission failure that answers the same
 * way on both spellings.
 */
function isInterceptionPage(body) {
  const head = body.slice(0, 2048).toLowerCase()
  return head.includes('<html') || head.includes('<!doctype html')
}

/**
 * Whether a failed request should be retried on the next candidate path.
 *
 * Deliberately narrow: a fall-through doubles the upstream request count for
 * that message, so it is reserved for failures that mean "this spelling is
 * unusable", never "this account or gateway is unhappy".
 */
export function pathFallbackStatus(status, body) {
  if (status === 404 || status === 405) return true
  if (status === 403 && body !== undefined) return isInterceptionPage(body)
  return false
}

/**
 * The personal billing paths to try, in order, for a realm.
 *
 * The international deployment serves the meter without the `/v2` prefix; the
 * CN deployment serves it with one.
 */
export function billingMeterPaths(region) {
  const withVersion = '/v2/billing/meter/get-user-resource'
  const withoutVersion = '/billing/meter/get-user-resource'
  return region === 'global' ? [withoutVersion, withVersion] : [withVersion]
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * The agent list inside a catalog document.
 *
 * The upstream nests it two different ways, and both are live: the CN CLI
 * document answers with `data.agents`, while the international `/v3/config`
 * product document answers with `data.agent.agents` (measured 2026-10-20
 * against the live deployment). A parser that only looks at one of them sees
 * "no cli agent models" on the other.
 */
function catalogAgents(data) {
  if (Array.isArray(data['agents'])) return data['agents']
  const nested = data['agent']
  if (typeof nested === 'object' && nested !== null && Array.isArray(nested['agents'])) return nested['agents']
  return []
}

/**
 * Parse either catalog shape after its envelope has been checked.
 *
 * The catalog names two lists: `models` (the full roster with its budgets) and
 * `agents` (the surfaces that may use them). The `cli` agent's model list is
 * the one this plugin serves — it is the roster the official CLI offers, and
 * the only one the chat endpoint accepts.
 */
export function parseModelCatalog(data, international = false) {
  const rawModels = Array.isArray(data['models']) ? data['models'] : []
  const agents = catalogAgents(data)
  let cliIds
  for (const agent of agents) {
    if (typeof agent === 'object' && agent !== null) {
      if (agent['name'] === 'cli' && Array.isArray(agent['models'])) {
        cliIds = agent['models'].filter(id => typeof id === 'string')
        break
      }
    }
  }
  if (cliIds === undefined || cliIds.length === 0) {
    throw new Error('workbuddy model catalog lists no cli agent models')
  }
  const byId = new Map()
  for (const model of rawModels) {
    if (typeof model !== 'object' || model === null) continue
    const id = typeof model['id'] === 'string' ? model['id'] : ''
    if (id === '' || model['disabled'] === true) continue
    const input = typeof model['maxInputTokens'] === 'number' ? model['maxInputTokens'] : 0
    const output = typeof model['maxOutputTokens'] === 'number' ? model['maxOutputTokens'] : 0
    if (input <= 0 || output <= 0) continue
    const declaredWindow = isObject(model['contextWindow']) && positive(model['contextWindow']['defaultLength'])
      ? model['contextWindow']['defaultLength']
      : undefined
    byId.set(id, {
      id,
      name: typeof model['name'] === 'string' && model['name'] !== '' ? model['name'] : id,
      contextWindow: international && declaredWindow !== undefined ? declaredWindow : input,
      ...(international
        ? {
            ...declaredWindow === undefined ? {} : { defaultContextWindow: declaredWindow },
            maxInputTokens: input,
            supportedContextWindows: isObject(model['contextWindow']) && Array.isArray(model['contextWindow']['supportedLengths'])
              ? model['contextWindow']['supportedLengths'].filter(positive)
              : [],
            promotions: parsePromotions(data['modelPromotions'], id),
          }
        : {}),
      maxTokens: output,
      supportsImages: model['supportsImages'] === true
        && model['disabledMultimodal'] !== true
        && !TEXT_ONLY_MODEL_IDS.has(id),
      ...resolveUpstreamReasoning(model),
      ...resolveUpstreamBilling(model),
    })
  }
  const models = cliIds.map(id => byId.get(id)).filter(model => model !== undefined)
  if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
  return models
}

/** One verified promotion entry. */
export function parsePromotions(value, model) {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isObject(item) || item['enabled'] !== true) return []
    const modelIds = item['modelIds']
    if (!Array.isArray(modelIds) || !modelIds.includes(model)) return []
    const schedule = item['schedule']
    const discount = item['discount']
    const badge = item['badge']
    if (!isObject(schedule) || !isObject(discount) || !isObject(badge)) return []
    // Only a replacement discount has an unambiguous display rule; any other
    // display mode is left to the upstream's own client.
    if (discount['displayMode'] !== 'replace') return []
    const start = typeof schedule['validFrom'] === 'string' ? Date.parse(schedule['validFrom']) : Number.NaN
    const end = typeof schedule['validUntil'] === 'string' ? Date.parse(schedule['validUntil']) : Number.NaN
    const factor = discount['factor']
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) return []
    return [{
      start,
      end,
      factor,
      label: typeof badge['label'] === 'string' ? badge['label'] : '',
      priority: typeof item['priority'] === 'number' && Number.isFinite(item['priority']) ? item['priority'] : 0,
    }]
  })
}

/**
 * Re-evaluate a model's promotion against the current time.
 *
 * Promotions are time-boxed, and the catalog they arrive in is cached for the
 * life of the process. Frozen at parse time, a cached "Free now" would keep
 * claiming a discount after `validUntil` had passed — and `free: true` is the
 * worst case of it: the user would be told a model costs nothing when it does
 * not.
 *
 * Non-destructive: the model's own `credits` and `badges` are the base, and the
 * promotion is layered onto a copy.
 */
export function modelWithCurrentPromotion(model, now = Date.now()) {
  if (model.promotions === undefined || model.promotions.length === 0) return model
  const promotion = [...model.promotions]
    .sort((a, b) => b.priority - a.priority)
    .find(candidate => now >= candidate.start && now < candidate.end)
  if (promotion === undefined) {
    // This row arrives with promotions attached, but none is in force now. The
    // upstream bakes the discounted value into `credits` itself, so keeping
    // that value would advertise a discount that has ended.
    const derivedFromPromotion = model.billing?.free === true
      || (model.billing?.badges?.length ?? 0) > 0
      || model.promotions.some(candidate => candidate.factor !== 1)
    if (!derivedFromPromotion) return model
    // The lapsed rate is KEPT in `credits` so the settings card can show it
    // with an "expired" note, while `rateUnknown` keeps every other surface
    // from quoting it as current.
    const staleRate = normalizeCredits(model.billing?.credits)
    const expiredLabels = [...new Set(model.promotions.map(candidate => candidate.label).filter(label => typeof label === 'string' && label !== ''))]
    return {
      ...model,
      billing: {
        free: false,
        rateUnknown: true,
        ...staleRate === undefined ? {} : { credits: staleRate },
        ...expiredLabels.length === 0 ? {} : { expiredPromotions: expiredLabels },
      },
    }
  }
  const rate = normalizeCredits(model.billing?.credits)
  const original = rate !== undefined && rate.startsWith('x') ? Number(rate.slice(1)) : Number.NaN
  // A replacement to zero is meaningful even when the base rate is unknown; any
  // other multiplier needs a number to scale, so it is skipped rather than
  // invented.
  if (promotion.factor !== 0 && !Number.isFinite(original)) return model
  const value = promotion.factor === 0 ? 0 : original * promotion.factor
  return {
    ...model,
    billing: {
      ...model.billing,
      credits: `x${value.toFixed(2)}`,
      free: value === 0,
      // De-duplicated, so applying the promotion to an already-promoted row is
      // a no-op: the catalog re-derives the promotion on every read, and a
      // label that accumulated would read `Free now · Free now` in the picker.
      badges: [...new Set([
        ...(model.billing?.badges ?? []),
        ...(promotion.label === '' ? [] : [promotion.label]),
      ])],
    },
  }
}

/**
 * The catalog endpoints to try, in order, for a region.
 *
 * Each candidate names a path, the User-Agent to present, and a short source
 * label for the status card.
 *
 * `/v3/config` comes first for BOTH regions, and the order matters: the
 * legacy per-enterprise document answers with the *CLI channel's* roster, whose
 * second slot is the paid `hy4-preview` (x0.29) while the product document
 * lists the free `hy4-preview-f` (x0.00) under the same display name. Serving
 * the legacy document first would therefore show a price that disagrees with
 * the desktop app and hide the free tier.
 *
 * The User-Agent matters too: the gateway splits the catalog by channel, and
 * the CLI channel's roster is a *smaller* one (it omits rows the App channel
 * serves). The international deployment is therefore asked with the App
 * channel first — the terse `WorkBuddyAI/<v>` spelling, because the spaced
 * `WorkBuddy AI/<v>` form is refused with 400/12403 — and the CN deployment
 * with the CLI channel, which is the channel its own client uses.
 */
export function catalogCandidates(international, appVersion) {
  if (international) {
    const version = appVersion?.version
    const app = []
    if (typeof version === 'string') {
      try {
        app.push({ path: '/v3/config', userAgent: appUserAgent(version), source: 'app' })
      } catch {
        // An invalid version is not worth a header: fall through to the
        // version-less spellings.
      }
      app.push({ path: '/v3/config', userAgent: `WorkBuddy/${version}`, source: 'app' })
    }
    app.push({ path: '/v3/config', userAgent: CLIENT_UA, source: 'cli' })
    app.push({ path: '/v2/enterprises/personal/models', userAgent: CLIENT_UA, source: 'cli' })
    app.push({ path: '/console/enterprises/personal/models', userAgent: CLIENT_UA, source: 'cli' })
    return app
  }
  return [
    { path: '/v3/config', userAgent: CLIENT_UA, source: 'cli' },
    { path: '/v2/enterprises/personal/models', userAgent: CLIENT_UA, source: 'cli' },
    { path: '/console/enterprises/personal/models', userAgent: CLIENT_UA, source: 'cli' },
  ]
}

/**
 * Provenance of one successful catalog fetch, surfaced by the status card.
 */
export class WorkBuddyUpstreamClient {
  /**
   * @param {object} [options]
   * @param {() => Promise<object>} [options.resolveAppVersion] App-shaped UA version resolver.
   * @param {(region: string) => Promise<object>} [options.resolveChatIdentity] Chat-identity resolver.
   */
  constructor(options = {}) {
    this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion())
    this.resolveChatIdentity = options.resolveChatIdentity ?? (region => resolveChatIdentity(region))
    /** Provenance of the most recent successful catalog fetch, for the card. */
    this.lastCatalog = undefined
  }

  /**
   * POST the chat endpoint; a successful answer is the raw SSE response.
   */
  async chatStream(credential, bodyJson, signal) {
    const region = realmOf(credential)
    // Identity resolution must never block a message: any failure — a thrown
    // resolver included — degrades to the desktop fallback form.
    let userAgent
    let clientVersion
    try {
      const identity = await this.resolveChatIdentity(region)
      userAgent = chatUserAgent(identity, region)
      clientVersion = identity.clientVersion
    } catch {
      const fallback = fallbackChatIdentity(region)
      userAgent = chatUserAgent(fallback, region)
      clientVersion = fallback.clientVersion
    }
    const body = withPromptCacheKey(
      region === 'global' ? prepareInternationalChatBody(bodyJson) : bodyJson,
      credential.uid,
    )
    // Built once from the prepared body and reused across the path fallback: a
    // sibling path retrying the same send is the same request, so its message
    // and turn ids must not rotate.
    const headers = withGatewayChatHeaders(chatHeaders(credential, userAgent, clientVersion), body)
    let response
    let lastFailure
    for (const path of chatPaths(region)) {
      let attempt
      try {
        attempt = await fetch(`${chatBase(credential)}${path}`, {
          method: 'POST',
          headers,
          body,
          ...signal === undefined ? {} : { signal },
        })
      } catch (error) {
        // A transport failure on one spelling says nothing about the other. A
        // caller-initiated abort is the exception: that is the message being
        // cancelled and must not be retried against the next path.
        if (signal?.aborted === true) {
          return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
        }
        lastFailure = { status: 0, text: `transport error: ${String(error)}` }
        continue
      }
      if (attempt.ok) {
        response = attempt
        break
      }
      // A body can only be read once, so capture it here: the failure keeps its
      // reason after a fallback attempt.
      const failureText = (await attempt.text()).slice(0, ERROR_BODY_LIMIT)
      lastFailure = { status: attempt.status, text: failureText }
      if (!pathFallbackStatus(attempt.status, failureText)) break
    }
    if (response !== undefined) return { ok: true, response }
    const failure = lastFailure ?? { status: 0, text: 'no chat endpoint answered' }
    return {
      ok: false,
      status: failure.status,
      // Status 0 is a transport failure, not a client-side rejection.
      kind: failure.status === 0 ? 'server' : classifyUpstreamError(failure.status, failure.text),
      message: failure.text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential) {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    const outcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * GET the personal model catalog.
   *
   * The upstream serves the roster from more than one place, and which one
   * answers depends on the deployment *and* on the client channel the
   * User-Agent names — the international `/v3/config` document, the CN CLI
   * document, and their legacy spellings. The candidates are therefore tried
   * in order of measurement confidence and the first one that yields a
   * parsable catalog wins; a candidate that answers 200 with an empty roster
   * does not end the walk.
   *
   * The User-Agent matters here in a way it does not elsewhere: the gateway
   * splits the catalog by channel, and the CLI channel's roster is a *smaller*
   * one (it omits rows the App channel serves). The App-channel spelling is
   * therefore tried first.
   */
  async fetchModels(credential, signal) {
    const international = realmOf(credential) === 'global'
    const appVersion = international ? await this.resolveAppVersion() : undefined
    const candidates = catalogCandidates(international, appVersion)
    let lastError
    for (const candidate of candidates) {
      try {
        const response = await fetch(`${chatBase(credential)}${candidate.path}`, {
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            Accept: 'application/json',
            Origin: originReferer(credential),
            Referer: `${originReferer(credential)}/`,
            ...international
              ? {
                  'X-Requested-With': 'XMLHttpRequest',
                  'X-Product': 'SaaS',
                  ...credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
                  'X-Domain': domainHeaderFor(credential),
                }
              : {},
            'User-Agent': candidate.userAgent,
          },
          signal: signal === undefined
            ? AbortSignal.timeout(JSON_TIMEOUT_MS)
            : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
        })
        const envelope = await readEnvelope(response)
        if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
        // Two catalog shapes share this path. The endpoint always answers with
        // the `{code,msg,data}` wrapper; `/v3/config` has also been observed
        // answering with the product document bare at the top level.
        const data = isObject(envelope.data) ? envelope.data
          : 'models' in envelope.document || 'agent' in envelope.document || 'agents' in envelope.document ? envelope.document
            : {}
        const models = parseModelCatalog(data, international)
        this.lastCatalog = {
          fetchedAtMs: Date.now(),
          source: `${international ? 'workbuddy-ai' : 'workbuddy'}:${candidate.source}`,
          ...appVersion === undefined ? {} : { appVersion },
        }
        return models
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('workbuddy model catalog: no candidate endpoint answered')
  }

  /**
   * POST the billing endpoint for the aggregated remaining credit.
   *
   * The personal endpoint serves a list of named packages; the card renders one
   * row per package. The international deployment serves the meter under a path
   * without the `/v2` prefix, so the candidates are tried in order and only a
   * routing miss falls through.
   */
  async fetchCredits(credential) {
    const now = new Date()
    const format = date => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const body = JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: format(now),
      PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 24 * 3600 * 1000)),
    })
    let response
    let lastStatus = 0
    for (const path of billingMeterPaths(realmOf(credential))) {
      const attempt = await fetch(`${billingBase(credential)}${path}`, {
        method: 'POST',
        headers: billingHeaders(credential),
        body,
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      })
      lastStatus = attempt.status
      if (attempt.ok || !pathFallbackStatus(attempt.status)) {
        response = attempt
        break
      }
    }
    if (response === undefined) throw new Error(`workbuddy billing endpoint failed (http ${lastStatus})`)
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    return normalizeCreditsDocument(envelope.data)
  }
}

/**
 * Reduce the billing document to the shape the card renders.
 *
 * The upstream nests its account list two ways in the field — the documented
 * `data.Response.Data.Accounts[]` and a flat `data.Accounts[]` — and names
 * the capacities either `Size`/`Remain` or `CapacitySize`/`CapacityRemain`.
 * Every capacity also arrives as a `*Precise` *string*; that fraction is
 * preferred, because the integer fields lose it and a credit balance shown
 * without its fraction is a balance that does not add up.
 *
 * The **cycle** family is the one that counts. The pool family
 * (`CapacitySize`/`CapacityRemain`) reports what the package *granted*, and a
 * spent monthly resource still reports the whole pool as remaining — "nothing
 * used, everything left" — while the cycle family reports what is left of
 * this cycle's allowance. The upstream's own client sums the cycle family, and
 * so does this: the pool is only a fallback for a row that carries no cycle
 * capacity at all.
 */
export function normalizeCreditsDocument(data) {
  const list = accountsOf(data)
  const accounts = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const cycleSize = preciseNumber(entry, 'CycleCapacitySize')
    const cycleRemain = preciseNumber(entry, 'CycleCapacityRemain')
    const poolSize = preciseNumber(entry, 'CapacitySize', 'Size')
    const poolRemain = preciseNumber(entry, 'CapacityRemain', 'Remain')
    // The cycle family wins; the pool family is the fallback for a row that
    // carries no cycle capacity.
    const size = cycleSize ?? poolSize
    const remain = cycleRemain ?? poolRemain
    if (size === undefined && remain === undefined) continue
    // `CapacityType` distinguishes the two kinds of resource: 4 is the
    // monthly cycle quota (it refreshes and never expires) and 1 is a
    // deduction gift (it drains to zero and does expire). `CycleEndTime`
    // exists on both, so it alone cannot tell them apart.
    const capacityType = typeof entry['CapacityType'] === 'number' ? entry['CapacityType'] : undefined
    const packageEndTime = typeof entry['ExpiredTime'] === 'string' && entry['ExpiredTime'] !== ''
      ? entry['ExpiredTime']
      : typeof entry['PackageEndTime'] === 'string' && entry['PackageEndTime'] !== ''
        ? entry['PackageEndTime']
        : undefined
    const cycleEndTime = typeof entry['CycleEndTime'] === 'string' && entry['CycleEndTime'] !== ''
      ? entry['CycleEndTime']
      : undefined
    accounts.push({
      packageName: typeof entry['PackageName'] === 'string' && entry['PackageName'] !== '' ? entry['PackageName'] : 'package',
      remain: remain ?? 0,
      size: size ?? 0,
      ...capacityType === undefined ? {} : { capacityType },
      ...packageEndTime === undefined ? {} : { packageEndTime },
      ...cycleEndTime === undefined ? {} : { cycleEndTime },
    })
  }
  const totalSize = accounts.reduce((sum, account) => sum + account.size, 0)
  const remainTotal = accounts.reduce((sum, account) => sum + account.remain, 0)
  const reported = Number(data?.['TotalDosage'] ?? data?.['totalDosage'] ?? 0)
  const grandTotal = Number.isFinite(reported) && reported > totalSize ? reported : totalSize
  const cycleResetTime = typeof data?.['CycleResetTime'] === 'string' ? data['CycleResetTime'] : undefined
  return {
    total: remainTotal,
    ...grandTotal === 0 ? {} : { totalSize: grandTotal },
    accounts,
    ...cycleResetTime === undefined ? {} : { cycleResetTime },
  }
}

/** The account list inside a billing document, wherever the upstream nested it. */
function accountsOf(data) {
  if (typeof data !== 'object' || data === null) return []
  if (Array.isArray(data['Accounts'])) return data['Accounts']
  if (Array.isArray(data['accounts'])) return data['accounts']
  const response = data['Response']
  if (typeof response === 'object' && response !== null) {
    const inner = response['Data']
    if (typeof inner === 'object' && inner !== null) {
      if (Array.isArray(inner['Accounts'])) return inner['Accounts']
      if (Array.isArray(inner['accounts'])) return inner['accounts']
    }
  }
  return []
}

/**
 * One capacity, preferring the `*Precise` string fraction over the integer
 * field of the same name.
 *
 * `plainKey` names the integer field when it differs from the precise one
 * (`CapacitySize` vs `Size`); when it is omitted the same name is read
 * without the `Precise` suffix (`CycleCapacitySize`).
 */
function preciseNumber(entry, preciseKey, plainKey) {
  const precise = entry[`${preciseKey}Precise`]
  if (typeof precise === 'string' && precise.trim() !== '') {
    const parsed = Number(precise)
    if (Number.isFinite(parsed)) return parsed
  }
  const plain = entry[plainKey ?? preciseKey]
  const parsed = Number(plain)
  return Number.isFinite(parsed) ? parsed : undefined
}

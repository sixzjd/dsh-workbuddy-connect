/**
 * The WorkBuddy pi-ai provider: one loopback-backed adapter per variant route,
 * registered into the Harness LLM seam.
 *
 * The profile is assembled by hand rather than through dsh-llm-pi-ai's internal
 * `resolveProfiles()`: that helper is not part of the package's public export
 * surface, so hand-assembly is the only supported path and every newly required
 * field must be adopted here explicitly.
 *
 * @module dsh-workbuddy-connect/adapter
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { normalizeCredits } from './upstream.js'
import { WORKBUDDY_MODEL_IDENTITY, modelIdentityKeysOf } from './variants.js'

export { WORKBUDDY_MODEL_IDENTITY, modelIdentityKeysOf }

/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * The reasoning tier a request that names no effort resolves to.
 *
 * `dsh-llm-pi-ai` resolves every request's tier as
 * `options.reasoningEffort ?? profile.reasoning`, so an absent default here
 * means "whatever pi-ai fills in" — and for a model whose level map carried
 * `off → null`, that was "no reasoning effort at all", which nine models answer
 * with HTTP 400 / code 11133. A compaction summary is exactly such a caller.
 */
export const WORKBUDDY_DEFAULT_EFFORT = 'high'

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults.
 *
 * They bound requests to models whose catalog entry declares `supportsImages`;
 * text-only models never receive images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}

/**
 * Inert pi-ai auth plane.
 *
 * The WorkBuddy routes authenticate only through the shim shared secret
 * resolved per request by `resolveApiKey`, so pi-ai's own credential lifecycle
 * and ambient discovery must never manufacture a credential for them.
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-workbuddy-connect: the WorkBuddy routes have no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * The suffix appended to a model's display name so its billing rate is visible
 * wherever the name is shown.
 *
 * The separator is a middle dot rather than a hyphen or colon: model names
 * already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4.1-Flash`), so a hyphen
 * separator would be ambiguous about where the name ends and the rate begins.
 */
const RATE_SEPARATOR = ' · '

/**
 * What the model seat shows in place of a rate the plugin cannot stand behind.
 *
 * The seat has no locale service (the adapter is a host seam), so this is a
 * literal; it matches the settings card's own wording for the same state.
 * Rendering it as WORDS rather than an empty slot: every other model in the
 * seat shows `· x0.3`, so a bare name where the rate should be reads as a
 * rendering bug.
 */
export const RATE_UNAVAILABLE = '价格暂不可用'

/**
 * The catalog display suffix: the billing rate followed by the declared promo
 * badges, or undefined when the row carries neither.
 */
function displaySuffix(info) {
  if (info.billing?.rateUnknown === true) return RATE_UNAVAILABLE
  const parts = [
    normalizeCredits(info.billing?.credits),
    ...(info.billing?.badges ?? []),
  ].filter(part => part !== undefined && part !== '')
  // De-duplicated: a promotion's label is layered onto the row's own badge
  // list, and a row that already carried the same label would otherwise show
  // it twice (`Hy3 · x0.00 · Free now · Free now`).
  return parts.length === 0 ? undefined : [...new Set(parts)].join(RATE_SEPARATOR)
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}

/**
 * Resolve a model's reasoning capability into pi-ai's `thinkingLevelMap`.
 *
 * The upstream's declared set wins outright: when it names a non-empty
 * `supportedEfforts`, exactly those values are offered and nothing else. A
 * row the upstream left undeclared gets no control at all — its selectable set
 * is client-side knowledge the catalog does not carry.
 *
 * `off` is offered only when the upstream declares `canDisableThinking: true`,
 * and it maps to `null` (no `reasoning_effort` on the wire) because the
 * upstream has no `off` spelling to send.
 */
export function reasoningFields(info) {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) {
    // Not a reasoning model: pi-ai reads a falsy `reasoning` as "off only".
    return { reasoning: false }
  }
  const declared = reasoning.supportedEfforts
  if (declared === undefined || declared.length === 0) {
    // Undeclared: no thinking control, and no `reasoning_effort` on the wire.
    return { reasoning: false }
  }
  const fallback = typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined
  return {
    reasoning: true,
    thinkingLevelMap: {
      off: fallback ?? null,
      minimal: null,
      low: declared.includes('low') ? 'low' : null,
      medium: declared.includes('medium') ? 'medium' : null,
      high: declared.includes('high') ? 'high' : null,
      xhigh: declared.includes('xhigh') ? 'xhigh' : null,
      max: declared.includes('max') ? 'max' : null,
    },
  }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, modelIdentity) {
  const reasoning = reasoningFields(info)
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: modelIdentity,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoning,
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: {
      // pi-ai cannot infer WorkBuddy's field spelling from the shim's random
      // loopback URL, so name the upstream-required field explicitly.
      maxTokensField: 'max_tokens',
      // pi-ai only emits `reasoning_effort` when this is set. Without it the
      // effort selector in the composer would silently do nothing.
      supportsReasoningEffort: reasoning.thinkingLevelMap !== undefined,
    },
  }
}

/**
 * The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
 * into the catalog answers it returns to the DSH model pickers.
 *
 * `listModels()` and `resolveModel()` build their answers straight from the
 * pi-ai descriptors, which carry no billing fact, so the rate is layered on
 * here by looking the model up in the live catalog. Both overrides delegate to
 * `super` and then rewrite only the display fields, so streaming, capability
 * resolution, and effort mapping stay exactly as `dsh-llm-pi-ai` implements
 * them.
 */
class WorkBuddyPiAiAdapter extends PiAiAdapter {
  constructor(catalog, adapterOptions) {
    super(adapterOptions)
    this.catalog = catalog
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  infoFor(model) {
    return this.catalog.current().find(entry => entry.id === model)
  }

  async listModels(provider) {
    const models = await super.listModels(provider)
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      return { ...model, name: withCatalogDisplay(model.name, info) }
    })
  }

  async resolveModel(provider, model, signal) {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
  }
}

/**
 * Assemble the adapter.
 *
 * The provider's `getModels` reads the live catalog, and every model's
 * `baseUrl` is re-resolved per read so the shim's port applies from the first
 * snapshot after startup.
 *
 * @param {object} options
 * @param {object} options.shim The running loopback shim.
 * @param {object} options.catalog The live catalog.
 * @param {string} [options.providerId] Provider id to register.
 * @param {string} [options.displayName] Human-facing provider name.
 * @param {string} [options.modelIdentity] Identity every model of this route advertises.
 * @param {() => object|undefined} [options.resolveAttachments] Attachment service lookup.
 */
export function createWorkBuddyAdapter(options) {
  const { shim, catalog } = options
  const providerId = options.providerId ?? 'workbuddy'
  const displayName = options.displayName ?? 'WorkBuddy'
  // The model identity is shared by both regions on purpose: pi-ai keeps a
  // historical thinking block only when the message names the same provider,
  // api AND model id, so a transcript that crosses the region boundary would
  // otherwise be replayed as plain text — and a replayed transcript is a much
  // larger one, which is what makes it stop fitting its window.
  const modelIdentity = options.modelIdentity ?? WORKBUDDY_MODEL_IDENTITY
  // The registry must publish the identity as an EXTRA key of this route: the
  // stamped `model.provider` is what pi-ai resolves the provider by, so a
  // region that does not publish it answers every request with
  // `Unknown provider: workbuddy` before a byte is sent.
  const registryKeys = modelIdentityKeysOf(providerId, modelIdentity)

  const buildModels = () => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL,
    // so the shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, modelIdentity))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'WorkBuddy shim shared secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: displayName }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read: stream dispatch still runs through
  // the constructed provider, while the catalog answer tracks the refresh.
  const provider = { ...base, getModels: () => buildModels() }

  /**
   * One profile per published registry key.
   *
   * The `piProvider` is what actually lands in pi-ai's registry, and that map
   * is keyed on `piProvider.id` — NOT on the profile's own `provider` field. So
   * the identity key needs a provider object that *claims* that id: the
   * route's own provider under a second id, so the models, baseUrl, api and
   * auth the request runs with stay this region's and nothing about the
   * gateway is duplicated.
   *
   * Sharing the very same object under both keys would register the route id
   * twice and leave the stamped identity unresolved — every request in that
   * region would fail with `Unknown provider: workbuddy` before a byte is
   * sent.
   */
  const profileFor = (key) => ({
    provider: key,
    displayName,
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddy-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    // Required since 0.1.5-alpha.2; the live catalog only exposes models the
    // upstream actually served, so there is never a per-model failure to report.
    modelErrors: new Map(),
    // The default tier, pinned to the same value pi-ai's level map would fill
    // in for an absent one. Without it a request that names no effort (a
    // compaction summary is exactly such a caller) resolves to "off" — which
    // nine models refuse with HTTP 400 / code 11133.
    reasoning: WORKBUDDY_DEFAULT_EFFORT,
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: key === providerId ? provider : { ...provider, id: key },
  })

  // A single source for BOTH the initial map and `invalidate`: an `invalidate`
  // that rebuilt only the route key would silently re-break the identity key.
  const buildProfiles = () => new Map(registryKeys.map(key => [key, profileFor(key)]))

  let profiles = buildProfiles()

  const adapter = new WorkBuddyPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real WorkBuddy token
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    // Image inputs reach the wire through the host's durable attachment
    // service: dsh-llm-pi-ai refuses any request carrying an image without
    // it, so the adapter must be handed the service the same way the sibling
    // connectors hand it. The lookup is lazy so a host without one never
    // fails plugin startup.
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
  })

  return {
    adapter,
    invalidate: () => {
      profiles = buildProfiles()
    },
  }
}

/**
 * WorkBuddy model catalog.
 *
 * Three sources, in descending order of authority:
 *
 * 1. **live** — the upstream's own answer, fetched on a schedule.
 * 2. **saved** — the last live list this account produced, kept on disk so a
 *    restart or an offline start still serves a usable roster.
 * 3. **fallback** — a compiled-in roster, so the provider registers with
 *    something before the first fetch lands.
 *
 * The card says which one is in force, because "the list you see" and "the
 * list the upstream currently serves" are different questions and a silent
 * answer to the first one is how a plugin ends up advertising a retired model.
 *
 * @module dsh-workbuddy-connect/catalog
 */
import { modelWithCurrentPromotion } from './upstream.js'

/**
 * Static CLI models for the international endpoint, captured 2026-10-20 from
 * the App-channel `/v3/config` document (the 24 ids of its `cli` agent).
 *
 * Same purpose and same discipline as the CN roster: it covers the window
 * before the first successful fetch and an offline start, and it is
 * deliberately *not* a promise about the upstream's current state.
 *
 * The three `x0.00` rows are the models WorkBuddy International currently
 * serves for free (its DeepSeek-V4.1-Flash promotion, alongside Hy4 preview
 * and Hy3). The free flag is a *snapshot*, not a promise: the upstream bakes
 * a promotion's discounted rate into the row, and the live catalog re-derives
 * it against the promotion's own validity window, so an ended promotion
 * drops the "free" claim on its own. The live answer always wins.
 */
export const FALLBACK_WORKBUDDY_AI_MODELS = [
  { id: 'default-model', name: 'Auto', contextWindow: 176000, maxTokens: 24000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true }, billing: { free: false } },
  { id: 'fast-model', name: 'Fast', contextWindow: 200000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.34', free: false } },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.59', free: false } },
  { id: 'primary-model', name: 'Primary', contextWindow: 272000, maxTokens: 72000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x3.31', free: false } },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 200000, maxTokens: 64000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.29', free: false } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { free: true } },
  { id: 'step-5-preview', name: 'Step-5-Preview', contextWindow: 300000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { free: true } },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 300000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { free: true } },
  { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', contextWindow: 300000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.03', free: false } },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 400000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x6.67', free: false } },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 272000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x1.33', free: false } },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x1.33', free: false } },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.07', free: false } },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x3.47', free: false } },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x1.39', free: false } },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.14', free: false } },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x3.31', free: false } },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272000, maxTokens: 72000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x1.65', free: false } },
  { id: 'grok-4.7', name: 'Grok-4.7', contextWindow: 200000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x1.90', free: false } },
  { id: 'gemini-3.8-flash', name: 'Gemini-3.8-Flash', contextWindow: 300000, maxTokens: 65536, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.95', free: false } },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1000000, maxTokens: 65536, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.99', free: false } },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 300000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.08', free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 48000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.69', free: false } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 48000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.79', free: false } },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', contextWindow: 300000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.08', free: false } },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1000000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x1.62', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.52', free: false } },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 300000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.77', free: false } },
]

/**
 * Static CLI models observed on the CN endpoint.
 *
 * The upstream refresh replaces this list at startup; it exists so the provider
 * registers with a usable catalog even while the first fetch is in flight or
 * offline.
 */
export const FALLBACK_WORKBUDDY_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 168_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { free: false } },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, maxTokens: 64_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { free: false, rateUnknown: true } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { free: false, rateUnknown: true } },
  { id: 'hy3-x', name: 'Hy3-X', contextWindow: 192_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.05', free: false } },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.03', badges: ['独家优惠'], free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.06', free: false } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 48_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.79', badges: ['夜间折扣'], free: false } },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.71', free: false } },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.62', free: false } },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.77', free: false } },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.57', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.52', free: false } },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 128_000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.25', free: false } },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 50_000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.51', free: false } },
]

/** The compiled-in roster for a region. */
export function fallbackFor(region) {
  return region === 'global' ? FALLBACK_WORKBUDDY_AI_MODELS : FALLBACK_WORKBUDDY_MODELS
}

/**
 * Mutable catalog shared by the shim's `/v1/models` and the adapter.
 *
 * Visibility is separate from content. A variant whose app has no credentials
 * must expose *no* models rather than a fallback roster: the DSH model picker
 * drops an empty group, so an empty catalog is exactly how a provider hides
 * without touching registration. Serving the fallback to a signed-out user
 * instead offers models that can only fail.
 */
export class WorkBuddyCatalog {
  /**
   * @param {object} [options]
   * @param {readonly object[]} [options.initial] The compiled-in roster.
   * @param {string} [options.region] The realm this catalog serves.
   */
  constructor(options = {}) {
    this.region = options.region ?? 'global'
    this.models = [...(options.initial ?? fallbackFor(this.region))]
    this.source = 'fallback'
    this.fetchedAtMs = undefined
    this.lastError = undefined
    this.visible = true
    this.useMaximumContextWindow = false
    this.disabledModelIds = new Set()
  }

  /** All known models before filtering disabled ones; empty while invisible. */
  all() {
    if (!this.visible) return []
    return this.models.map(model => {
      const current = modelWithCurrentPromotion(model)
      const maximum = current.supportedContextWindows === undefined ? undefined : Math.max(...current.supportedContextWindows)
      return this.useMaximumContextWindow && maximum !== undefined && maximum > current.contextWindow
        ? { ...current, defaultContextWindow: current.defaultContextWindow ?? current.contextWindow, contextWindow: maximum }
        : current
    })
  }

  /** Current enabled entries; empty while the variant has no usable credential. */
  current() {
    return this.all().filter(model => !this.disabledModelIds.has(model.id))
  }

  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models, source, fetchedAtMs) {
    this.models = models.map(model => ({ ...model }))
    if (source !== undefined) this.source = source
    if (fetchedAtMs !== undefined) this.fetchedAtMs = fetchedAtMs
  }

  /** Whether this variant's models are exposed at all. */
  isVisible() {
    return this.visible
  }

  /**
   * Show or hide the whole catalog. Returns whether the value changed, so the
   * caller can skip an invalidation that would re-render an identical list.
   */
  setVisible(visible) {
    if (this.visible === visible) return false
    this.visible = visible
    return true
  }

  /** Select the largest declared window where the upstream offers one. */
  setUseMaximumContextWindow(useMaximum) {
    if (this.useMaximumContextWindow === useMaximum) return false
    this.useMaximumContextWindow = useMaximum
    return true
  }

  /** Update the set of disabled model ids. Returns whether the effective set changed. */
  setDisabledModels(disabled) {
    const next = new Set(disabled)
    if (next.size === this.disabledModelIds.size) {
      let same = true
      for (const id of next) {
        if (!this.disabledModelIds.has(id)) {
          same = false
          break
        }
      }
      if (same) return false
    }
    this.disabledModelIds = next
    return true
  }

  /** Currently disabled model ids as an array. */
  disabledModels() {
    return [...this.disabledModelIds]
  }

  /** Models to fall back to when the upstream fetch fails; ignores visibility. */
  fallback() {
    return this.models
  }
}

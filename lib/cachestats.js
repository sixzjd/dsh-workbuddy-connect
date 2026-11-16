/**
 * Cache-hit accounting for the model card.
 *
 * The upstream bills a cached prefix at a fraction of a fresh one, so the hit
 * rate is the difference between a cheap conversation and an expensive one.
 * Until now the plugin never read `usage` on the streaming path at all — which
 * is the only path the upstream serves — so the card could say nothing about
 * it, and the only way to see the number was to guess from a bill.
 *
 * Deliberately closed over nothing: these are the two pure transforms the shim
 * and the card need, so they can be tested without a socket or a body.
 */

/**
 * Pull the `usage` block out of a chunk of forwarded SSE text.
 *
 * Called with text the relay is about to hand to the client, so it must be
 * infallible and must never throw: a usage block it cannot read is worth
 * nothing, while an exception here would break a response that is already
 * streaming. Lines that do not mention `usage` are skipped without parsing,
 * because on a long completion every content delta would otherwise be parsed
 * twice for nothing.
 *
 * @param {string} text Complete SSE lines (event boundaries already honoured).
 * @returns {object|undefined} The last usage block in the text.
 */
export function usageFromSseText(text) {
  let usage
  const source = typeof text === 'string' ? text : ''
  for (const line of source.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    // Cheap guard first: the overwhelming majority of events carry a content
    // delta and no usage, and JSON.parse on each of them is pure waste.
    if (!payload.includes('"usage"')) continue
    try {
      const data = JSON.parse(payload)
      if (data?.usage !== undefined && data?.usage !== null && typeof data.usage === 'object') usage = data.usage
    } catch {
      // A block that does not parse is not this function's problem to report.
      continue
    }
  }
  return usage
}

/** The empty accumulator. */
export function emptyCacheUsage() {
  return { promptTokens: 0, cachedTokens: 0, turns: 0, lastRate: null, rate: null }
}

/**
 * Fold one turn's `usage` into the running cache totals.
 *
 * Cached tokens are clamped to the prompt they belong to: the upstream reports
 * `cached_tokens` separately, and a value larger than `prompt_tokens` would
 * otherwise produce a hit rate above 100% — a number the card must never show,
 * because it would be obviously wrong and would hide the real figure.
 *
 * A turn without a usable `prompt_tokens` is ignored rather than counted as a
 * miss. Some upstream events (and every aborted stream) omit usage entirely,
 * and folding those in as zero-cache turns would pull the average down for
 * reasons that have nothing to do with the cache.
 *
 * @param {object|undefined} previous Accumulator from the prior call.
 * @param {object|undefined} usage The upstream's `usage` block.
 * @returns {object} The next accumulator.
 */
export function accumulateCacheUsage(previous, usage) {
  const state = previous ?? emptyCacheUsage()
  const prompt = Number(usage?.prompt_tokens)
  if (!Number.isFinite(prompt) || prompt <= 0) return state
  const reported = Number(usage?.prompt_tokens_details?.cached_tokens)
  const cached = Number.isFinite(reported) ? Math.min(Math.max(reported, 0), prompt) : 0
  const promptTokens = state.promptTokens + prompt
  const cachedTokens = state.cachedTokens + cached
  return {
    promptTokens,
    cachedTokens,
    turns: state.turns + 1,
    lastRate: cached / prompt,
    rate: promptTokens === 0 ? null : cachedTokens / promptTokens,
  }
}
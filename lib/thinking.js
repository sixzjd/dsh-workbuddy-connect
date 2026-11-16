/**
 * Resolve a model's reasoning capability into pi-ai's `thinkingLevelMap`.
 *
 * The upstream's declared set wins outright: when it names a non-empty
 * `supportedEfforts`, exactly those values are offered and nothing else. A
 * row the upstream left undeclared gets no control at all — its selectable set
 * is client-side knowledge the catalog does not carry.
 *
 * The `off` slot is pi-ai's default level, and it is offered only when the
 * upstream declares `canDisableThinking: true`. Without that declaration the
 * slot is `null`, which hides it: a model that cannot disable thinking would
 * otherwise present "off" next to its only real level, with both putting the
 * same value on the wire — a control that looks like a choice and is not one.
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
      off: reasoning.canDisableThinking === true ? fallback ?? null : null,
      minimal: null,
      low: declared.includes('low') ? 'low' : null,
      medium: declared.includes('medium') ? 'medium' : null,
      high: declared.includes('high') ? 'high' : null,
      xhigh: declared.includes('xhigh') ? 'xhigh' : null,
      max: declared.includes('max') ? 'max' : null,
    },
  }
}

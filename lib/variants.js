/**
 * The two WorkBuddy products this one plugin serves.
 *
 * Both are the same client framework in different regions, and they differ by
 * upstream realm, catalog endpoint, and display identity. Everything that
 * varies between them is collected here as one descriptor, so no module has to
 * carry its own `if (international)` branch and a third variant would be a data
 * change rather than a refactor.
 *
 * Each variant signs in independently, through its own realm's device
 * authorization flow. The two therefore never share a credential, and a realm
 * that is unreachable from the user's network (the international one, from some
 * mainland networks) cannot block the other's login.
 *
 * @module dsh-workbuddy-connect/variants
 */

/** One WorkBuddy product variant. */
export const WORKBUDDY_VARIANTS = [
  {
    /** Provider id registered with DSH. */
    id: 'workbuddy',
    /** Model-group heading and card title stem. */
    displayName: 'WorkBuddy',
    /** Product name as users know it, for diagnostics and error copy. */
    appName: 'WorkBuddy',
    /** Which upstream realm this variant's credentials must belong to. */
    region: 'cn',
    /** The id every model of this route advertises. */
    modelIdentity: 'workbuddy',
    /** Basename of the plugin-owned credential file under the data dir. */
    authFilename: '.workbuddy-auth.json',
    /** Basename of the plugin-owned saved-catalog file under the state dir. */
    catalogFilename: '.workbuddy-catalog.json',
    /** Basename of the plugin-owned settings file under the data dir. */
    settingsFilename: '.workbuddy-settings.json',
    /** Site the human signs in at. */
    signInUrl: 'https://www.codebuddy.cn',
  },
  {
    id: 'workbuddy-global',
    modelIdentity: 'workbuddy',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
    region: 'global',
    authFilename: '.workbuddy-ai-auth.json',
    catalogFilename: '.workbuddy-ai-catalog.json',
    settingsFilename: '.workbuddy-ai-settings.json',
    signInUrl: 'https://www.workbuddy.ai',
  },
]

/**
 * The model identity every WorkBuddy model advertises.
 *
 * Deliberately NOT the same string as a route id: a message is only
 * "same-model" when provider, api AND model id all match, so the identity has
 * to be shared for a transcript to keep its thinking blocks when the user
 * switches region — and it must not be reachable as a route a user could pick,
 * because it names one model, not one gateway.
 *
 * The international route is therefore `workbuddy-global` and the identity
 * `workbuddy`; the CN route is `workbuddy` and happens to share the name.
 */
export const WORKBUDDY_MODEL_IDENTITY = 'workbuddy'

/**
 * Registry keys an adapter serving `providerId` must publish so that every
 * stamp its models carry resolves inside its own region.
 *
 * The route id first, then the model identity, de-duplicated — route-first so
 * `profiles()` opens with the route the adapter actually serves. CN yields one
 * key (`workbuddy` is both its route and the shared identity) and the
 * international region yields two (`workbuddy-global`, `workbuddy`); each
 * region must publish the shared one, or every request in that region dies
 * with `Unknown provider: workbuddy` before a byte is sent.
 */
export function modelIdentityKeysOf(providerId, identity = WORKBUDDY_MODEL_IDENTITY) {
  return [...new Set([providerId, identity].filter(key => key !== undefined))]
}

/** The international variant — the one this plugin leads with. */
export const GLOBAL_VARIANT = WORKBUDDY_VARIANTS[1]

/** The CN variant. */
export const CN_VARIANT = WORKBUDDY_VARIANTS[0]

/** Look up a variant by provider id. */
export function variantFor(id) {
  return WORKBUDDY_VARIANTS.find(variant => variant.id === id)
}

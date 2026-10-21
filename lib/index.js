/**
 * dsh-workbuddy-connect — host half.
 *
 * Registers a `workbuddy` and a `workbuddy-ai` LLM provider whose models are
 * served by the WorkBuddy desktop products (CN: `copilot.tencent.com`;
 * international: `www.workbuddy.ai`).
 *
 * The upstream is a closed, client-shaped API: it gates on the User-Agent, it
 * refuses a body whose first message is not a system prompt, it rejects the
 * OpenAI-only `store` field, it accepts `tool_choice` only in its string form,
 * it answers `stream: true` only, and it wants a whole family of attribution
 * headers. None of that can live in the profile config, so the plugin owns the
 * wire format through a loopback shim: pi-ai speaks plain OpenAI-completions
 * to the shim, and the shim speaks WorkBuddy to the gateway.
 *
 * The credential is the plugin's own: a device-authorization login, obtained
 * by the settings card, refreshed on demand. Nothing is read out of the
 * desktop app's own state, so the plugin works whether or not that app is
 * installed.
 *
 * @module dsh-workbuddy-connect
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { WorkBuddyCredentialStore, WorkBuddyLoginClient, readJsonFile, writeJsonAtomic } from './auth.js'
import { WorkBuddyCatalog, fallbackFor } from './catalog.js'
import { createWorkBuddyAdapter } from './adapter.js'
import { createWorkBuddyShim } from './shim.js'
import { WorkBuddyUpstreamClient, modelWithCurrentPromotion, prepareChatBody, prepareInternationalChatBody, realmOf, regionOf } from './upstream.js'
import { readDesktopCredential, findDesktopExecutable } from './atrest.js'
import { workbuddyPluginDataDir, workbuddyStateDir } from './paths.js'
import { WORKBUDDY_VARIANTS, variantFor } from './variants.js'

export const name = 'llm-workbuddy'
export const inject = ['llm']

const PLUGIN_VERSION = '0.1.0'

/** How often the model catalog is refreshed from the upstream. */
const CATALOG_REFRESH_MS = 30 * 60_000

/** How often the credit balance is refreshed for the card. */
const CREDITS_REFRESH_MS = 5 * 60_000

/** Base path of this plugin's same-origin card routes. */
const ROUTE_BASE = '/plugins/dsh-workbuddy-connect'

/**
 * Per-process control keys, minted once so a fiber hot-reload does not 403 the
 * open card.
 */
let processKeys
function controlKeys() {
  processKeys ??= {
    login: randomBytes(24).toString('hex'),
    models: randomBytes(24).toString('hex'),
    auth: randomBytes(24).toString('hex'),
  }
  return processKeys
}

/**
 * The guard every state-changing card route shares: a loopback Host and
 * Origin, plus the in-process key the card receives with its status document.
 *
 * Loopback alone is *not* authentication — any local process can address
 * `127.0.0.1`, and these routes write a credential to disk.
 */
function routeGuard(req, key) {
  const host = req.headers.host
  if (typeof host !== 'string' || !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && !/^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))) return false
  const presented = req.headers['x-dsh-workbuddy-connect-key']
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Read a route body with a hard ceiling. */
async function readRouteBody(req, limit = 65536) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Strip token-like content from a message before it reaches the browser. */
function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|pat)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/**
 * One variant's whole runtime: credential store, catalog, upstream client,
 * shim, and adapter.
 *
 * The pieces are per variant rather than per plugin because the two products
 * disagree about almost everything: which upstream realm a credential belongs
 * to, which catalog document answers, which chat path is served, and which
 * credential file is written. Sharing one instance would mean every one of
 * those decisions carried a variant parameter.
 */
class VariantRuntime {
  /**
   * @param {object} variant The variant descriptor.
   * @param {object} options Constructor dependencies.
   */
  constructor(variant, options) {
    this.variant = variant
    this.logger = options.logger
    this.dataDir = options.dataDir
    this.stateDir = options.stateDir
    this.client = options.client
    this.login = options.login
    this.onChange = options.onChange
    /** Pending login attempts, keyed by the upstream's state string. */
    this.attempts = new Map()

    this.catalog = new WorkBuddyCatalog({ region: variant.region, initial: fallbackFor(variant.region) })
    this.store = new WorkBuddyCredentialStore({
      variant,
      refresh: credential => this.client.refreshToken(credential),
    })
    this.settings = readJsonFile(join(this.dataDir, variant.settingsFilename)) ?? {}
    if (Array.isArray(this.settings.disabledModels)) this.catalog.setDisabledModels(this.settings.disabledModels)
    if (this.settings.useMaximumContextWindow === true) this.catalog.setUseMaximumContextWindow(true)
    this.credits = undefined
    this.creditsError = undefined
    /**
     * Whether the upstream has refused this credential since the last
     * successful call.
     *
     * The desktop app rotates its own session behind the plugin's back, so a
     * stored token can go stale while the card still reads "signed in". The
     * upstream saying so is the only reliable signal, and the card needs it:
     * without it the user sees a stale badge and an unexplained 401.
     */
    this.sessionStale = false
  }

  /** Record that the upstream refused the stored credential. */
  markSessionStale() {
    if (this.sessionStale) return
    this.sessionStale = true
    this.onChange?.()
  }

  /** Forget a stale-session mark, after a call the upstream accepted. */
  markSessionFresh() {
    if (!this.sessionStale) return
    this.sessionStale = false
    this.onChange?.()
  }

  /** The saved-catalog path for this variant. */
  catalogPath() {
    return join(this.stateDir, this.variant.catalogFilename)
  }

  /** The settings path for this variant. */
  settingsPath() {
    return join(this.dataDir, this.variant.settingsFilename)
  }

  /** Persist the settings this variant owns. */
  saveSettings() {
    writeJsonAtomic(this.settingsPath(), {
      version: 1,
      disabledModels: this.catalog.disabledModels(),
      useMaximumContextWindow: this.catalog.useMaximumContextWindow === true,
    })
  }

  /**
   * Seed the catalog from the account's last successful live list, so a
   * restart serves the same roster the account actually had.
   */
  seedFromSavedCatalog() {
    const saved = readJsonFile(this.catalogPath())
    if (!Array.isArray(saved?.models) || saved.models.length === 0) return
    this.catalog.set(saved.models, 'saved', saved.fetchedAtMs)
  }

  /**
   * Refresh the model catalog from the upstream.
   *
   * The three-level degradation is explicit: a successful fetch becomes
   * `live`, a failure leaves whatever was in force (saved or fallback) and
   * records the reason, so the card can say which one the user is looking at.
   */
  async refreshCatalog() {
    try {
      const credential = await this.store.resolve()
      const models = await this.client.fetchModels(credential)
      // The rows are stored RAW: a promotion is re-derived on every read
      // (it is time-boxed, so a cached "Free now" must stop claiming itself
      // when the window closes). Applying it here as well would layer the
      // badge on twice — once by the fetch and once by every read.
      this.catalog.set(models, 'live', Date.now())
      this.catalog.lastError = undefined
      writeJsonAtomic(this.catalogPath(), {
        version: 1,
        fetchedAtMs: this.catalog.fetchedAtMs,
        models,
      })
      this.onChange?.()
      return true
    } catch (error) {
      this.catalog.lastError = safeMessage(error)
      this.logger?.warn?.(`dsh-workbuddy-connect: ${this.variant.displayName} catalog refresh failed`, error)
      return false
    }
  }

  /** Refresh the credit balance for the card. */
  async refreshCredits() {
    try {
      const credential = await this.store.resolve()
      this.credits = await this.client.fetchCredits(credential)
      this.creditsError = undefined
    } catch (error) {
      this.creditsError = safeMessage(error)
    }
  }

  /**
   * The status document this variant contributes to the card.
   *
   * Never throws: a status read must never be the thing that breaks the card.
   */
  async status() {
    const auth = await this.store.status()
    // `catalog.all()` already re-derives the current promotion; applying it a
    // second time here would repeat its badge.
    const disabled = this.catalog.disabledModels()
    const models = this.catalog.all().map(current => ({
      id: current.id,
      name: current.name,
      contextWindow: current.contextWindow,
      maxTokens: current.maxTokens,
      defaultContextWindow: current.defaultContextWindow,
      supportedContextWindows: current.supportedContextWindows,
      supportsImages: current.supportsImages === true,
      free: current.billing?.free === true,
      rate: current.billing?.rateUnknown === true ? null : current.billing?.credits,
      rateUnknown: current.billing?.rateUnknown === true,
      badges: current.billing?.badges ?? [],
      efforts: current.reasoning?.supportedEfforts ?? [],
      enabled: !disabled.includes(current.id),
    }))
    return {
      provider: this.variant.id,
      displayName: this.variant.displayName,
      appName: this.variant.appName,
      region: this.variant.region,
      signInUrl: this.variant.signInUrl,
      // Whether the desktop app is installed, so the card can offer the
      // one-click import. The check is a few `existsSync` calls — it never
      // spawns the app, so it is cheap enough for a status poll.
      desktopAvailable: findDesktopExecutable() !== undefined,
      auth: { ...auth, sessionStale: this.sessionStale },
      catalog: {
        source: this.catalog.source,
        fetchedAt: this.catalog.fetchedAtMs,
        error: this.catalog.lastError,
        models,
      },
      credits: this.credits ?? null,
      creditsError: this.creditsError ?? null,
      useMaximumContextWindow: this.catalog.useMaximumContextWindow === true,
    }
  }
}

/**
 * Start the providers: one runtime, one shim and one adapter per variant.
 *
 * An empty catalog hides the model group in DSH's picker, which is how a
 * provider with nothing to serve disappears without touching registration.
 */
export async function apply(ctx, config = {}) {
  const dataDir = workbuddyPluginDataDir()
  const stateDir = workbuddyStateDir()
  const client = new WorkBuddyUpstreamClient()
  const login = new WorkBuddyLoginClient()
  const { login: loginKey, models: modelsKey, auth: authKey } = controlKeys()

  const runtimes = new Map()
  const adapters = new Map()
  const shims = new Map()
  const disposers = []

  /** Re-snapshot every adapter after a catalog change. */
  const refresh = () => {
    for (const built of adapters.values()) built.invalidate()
    ctx.emit('llm/adapters-updated')
  }

  for (const variant of WORKBUDDY_VARIANTS) {
    const runtime = new VariantRuntime(variant, {
      logger: ctx.logger,
      dataDir,
      stateDir,
      client,
      login,
      onChange: refresh,
    })
    runtime.seedFromSavedCatalog()
    // A variant with no credential shows no models at all: offering the
    // compiled-in roster to a signed-out user would advertise models that can
    // only fail.
    const auth = await runtime.store.status()
    runtime.catalog.setVisible(auth.state === 'signed-in')
    runtimes.set(variant.id, runtime)

    // The shim speaks to the upstream; the adapter speaks to the shim.
    const shim = createWorkBuddyShim({
      store: runtime.store,
      client,
      catalog: runtime.catalog,
      logger: ctx.logger,
      prepareBody: (raw, options) => (variant.region === 'global'
        ? prepareInternationalChatBody(raw, options)
        : prepareChatBody(raw, options)),
      defaultEffortFor: id => runtime.catalog.current().find(entry => entry.id === id)?.reasoning?.defaultEffort,
      // The upstream refusing the stored credential is the only trustworthy
      // signal that the session was rotated away; the card turns it into a
      // visible hint instead of a stale "signed in" badge.
      onSessionDead: () => runtime.markSessionStale(),
      onSessionFresh: () => runtime.markSessionFresh(),
      // `DSH_WORKBUDDY_DUMP_BODY=/tmp/wb-body.json` records the exact request
      // this process sends, which is the only way to tell a body-shape refusal
      // from a credential one.
      ...process.env['DSH_WORKBUDDY_DUMP_BODY'] === undefined
        ? {}
        : { dumpBodyPath: process.env['DSH_WORKBUDDY_DUMP_BODY'] },
    })
    shims.set(variant.id, shim)

    const built = createWorkBuddyAdapter({
      shim,
      catalog: runtime.catalog,
      providerId: variant.id,
      displayName: variant.displayName,
      // The identity every model of this route advertises. It is shared across
      // the two regions on purpose — see `modelIdentityKeysOf`.
      modelIdentity: variant.modelIdentity,
      // Lazy service lookup: the adapter asks for the host's attachment
      // service only when a request actually carries an image.
      resolveAttachments: () => ctx.get('attachments'),
    })
    adapters.set(variant.id, built)
  }

  // Register synchronously, before any await: the headless host starts its
  // first turn the moment the fiber is ready and does not await an async setup
  // continuation, so an adapter registered after an `await` loses the race.
  for (const [id, built] of adapters) {
    try {
      const releaseAdapter = ctx.llm.registerAdapter([id], built.adapter)
      disposers.push(releaseAdapter)
    } catch (error) {
      ctx.logger?.error?.(`dsh-workbuddy-connect: registerAdapter failed for ${id}`, error)
    }
  }
  try {
    const releaseDirectory = ctx.llm.registerConfigurableProviders(WORKBUDDY_VARIANTS.map(variant => ({
      provider: variant.id,
      displayName: variant.displayName,
      settingsNs: ctx.fiber?.entry?.options?.id ?? variant.id,
      settingsPath: [],
      declared: false,
    })))
    disposers.push(releaseDirectory)
  } catch (error) {
    ctx.logger?.error?.('dsh-workbuddy-connect: registerConfigurableProviders failed', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A disposer that throws must not stop the others.
      }
    }
  })

  // The first catalog fetch runs in the background: serving starts on the
  // saved/built-in roster and upgrades to the live list when it lands.
  for (const runtime of runtimes.values()) {
    void runtime.refreshCatalog().then(() => refresh())
    void runtime.refreshCredits()
  }
  // When the listen event lands (including the ephemeral-port fallback), the
  // descriptors' embedded baseUrl may have changed — re-snapshot them.
  for (const shim of shims.values()) {
    void shim.ready.then(up => {
      if (up) refresh()
    })
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const runtime of runtimes.values()) {
        void runtime.refreshCatalog().then(() => refresh())
        void runtime.refreshCredits()
      }
    }, CATALOG_REFRESH_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  //#region card routes
  const statusHandler = (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end()
      return
    }
    const host = req.headers.host
    if (typeof host !== 'string' || !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) {
      res.statusCode = 403
      res.end()
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined && !/^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))) {
      res.statusCode = 403
      res.end()
      return
    }
    void (async () => {
      const variants = {}
      for (const [id, runtime] of runtimes) variants[id] = await runtime.status()
      const payload = JSON.stringify({
        status: 'ok',
        version: PLUGIN_VERSION,
        variants,
        loginKey,
        modelsKey,
        authKey,
      })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(payload)
    })().catch(error => {
      ctx.logger?.warn?.('dsh-workbuddy-connect: status route failed', error)
      if (!res.headersSent) {
        res.statusCode = 500
        res.end()
      }
    })
  }

  const loginHandler = async (req, res) => {
    if (req.method !== 'POST' || !routeGuard(req, loginKey)) {
      res.statusCode = req.method === 'POST' ? 403 : 405
      res.end()
      return
    }
    const text = await readRouteBody(req)
    let action
    try {
      action = JSON.parse(text ?? '')
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    const provider = typeof action?.provider === 'string' ? action.provider : ''
    const runtime = runtimes.get(provider)
    if (runtime === undefined) {
      res.statusCode = 400
      res.end()
      return
    }
    try {
      if (action?.action === 'begin') {
        const attempt = await login.begin(runtime.variant.region)
        runtime.attempts.set(attempt.state, { startedAtMs: Date.now() })
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ status: 'pending', authUrl: attempt.authUrl, state: attempt.state }))
        return
      }
      if (action?.action === 'poll') {
        const state = typeof action.state === 'string' ? action.state : ''
        const attempt = runtime.attempts.get(state)
        if (attempt === undefined) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ status: 'pending' }))
          return
        }
        const outcome = await login.poll({ state, authUrl: '', region: runtime.variant.region })
        if (outcome.status !== 'complete') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ status: 'pending' }))
          return
        }
        login.forget(state)
        runtime.attempts.delete(state)
        const { tokens, account } = outcome
        const region = tokens.domain === '' ? runtime.variant.region : (tokens.domain.endsWith('workbuddy.ai') ? 'global' : 'cn')
        const credential = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAtMs: Date.now() + (tokens.expiresInSec > 0 ? tokens.expiresInSec * 1000 : 0),
          domain: tokens.domain,
          region,
          uid: account.uid,
          ...account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId },
          ...account.nickname === undefined ? {} : { nickname: account.nickname },
          source: 'login',
        }
        await runtime.store.save(credential)
        runtime.catalog.setVisible(true)
        await runtime.refreshCatalog()
        await runtime.refreshCredits()
        refresh()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ status: 'complete' }))
        return
      }
      if (action?.action === 'cancel') {
        const state = typeof action.state === 'string' ? action.state : ''
        login.forget(state)
        runtime.attempts.delete(state)
        res.statusCode = 204
        res.end()
        return
      }
      res.statusCode = 400
      res.end()
    } catch (error) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ status: 'error', error: safeMessage(error) }))
    }
  }

  const modelsHandler = async (req, res) => {
    if (req.method !== 'POST' || !routeGuard(req, modelsKey)) {
      res.statusCode = req.method === 'POST' ? 403 : 405
      res.end()
      return
    }
    const text = await readRouteBody(req)
    let action
    try {
      action = JSON.parse(text ?? '')
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    const provider = typeof action?.provider === 'string' ? action.provider : ''
    const runtime = runtimes.get(provider)
    if (runtime === undefined) {
      res.statusCode = 400
      res.end()
      return
    }
    if (action?.action === 'set-model' && typeof action.model === 'string' && typeof action.enabled === 'boolean') {
      // One model, one new state. The card never sends a list derived from a
      // snapshot of the page: a snapshot is stale the moment the catalog
      // refreshes, and a complement computed from a stale one can disable
      // every model but the one that was clicked.
      const known = new Set(runtime.catalog.all().map(model => model.id))
      if (!known.has(action.model)) {
        res.statusCode = 400
        res.end()
        return
      }
      const next = new Set(runtime.catalog.disabledModels())
      if (action.enabled) next.delete(action.model)
      else next.add(action.model)
      const list = [...next]
      runtime.catalog.setDisabledModels(list)
      runtime.settings.disabledModels = list
      runtime.saveSettings()
      refresh()
      res.statusCode = 204
      res.end()
      return
    }
    if (action?.action === 'set-all' && typeof action.enabled === 'boolean') {
      const list = action.enabled ? [] : runtime.catalog.all().map(model => model.id)
      runtime.catalog.setDisabledModels(list)
      runtime.settings.disabledModels = list
      runtime.saveSettings()
      refresh()
      res.statusCode = 204
      res.end()
      return
    }
    if (action?.action === 'set-disabled' && Array.isArray(action.models)) {
      // Kept for compatibility with an older card. The list is the set of
      // models to KEEP, and the server turns it into the disabled set — the
      // card never gets to name a list of things to remove.
      const known = new Set(runtime.catalog.all().map(model => model.id))
      const keep = new Set(action.models.filter(id => typeof id === 'string' && known.has(id)))
      const next = [...known].filter(id => !keep.has(id))
      runtime.catalog.setDisabledModels(next)
      runtime.settings.disabledModels = next
      runtime.saveSettings()
      refresh()
      res.statusCode = 204
      res.end()
      return
    }
    if (action?.action === 'set-max-window' && typeof action.enabled === 'boolean') {
      runtime.catalog.setUseMaximumContextWindow(action.enabled)
      runtime.settings.useMaximumContextWindow = action.enabled
      runtime.saveSettings()
      refresh()
      res.statusCode = 204
      res.end()
      return
    }
    if (action?.action === 'refresh') {
      await runtime.refreshCatalog()
      await runtime.refreshCredits()
      refresh()
      res.statusCode = 204
      res.end()
      return
    }
    res.statusCode = 400
    res.end()
  }

  const authHandler = async (req, res) => {
    if (req.method !== 'POST' || !routeGuard(req, authKey)) {
      res.statusCode = req.method === 'POST' ? 403 : 405
      res.end()
      return
    }
    const text = await readRouteBody(req)
    let action
    try {
      action = JSON.parse(text ?? '')
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    const provider = typeof action?.provider === 'string' ? action.provider : ''
    const runtime = runtimes.get(provider)
    if (runtime === undefined) {
      res.statusCode = 400
      res.end()
      return
    }
    if (action?.action === 'logout') {
      await runtime.store.logout()
      runtime.catalog.setVisible(false)
      runtime.credits = undefined
      refresh()
      res.statusCode = 204
      res.end()
      return
    }
    if (action?.action === 'import-desktop') {
      // Adopt the session the WorkBuddy desktop app is already signed in to.
      // A convenience, not a dependency: the plugin's own device-authorization
      // login stays the primary path and works without the app installed.
      try {
        const credential = await readDesktopCredential()
        if (credential === undefined) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: 'no desktop session found' }))
          return
        }
        const region = regionOf(credential.domain)
        if (region !== runtime.variant.region) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            ok: false,
            error: `the desktop app is signed in to ${region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy (CN)'}, not ${runtime.variant.appName}`,
          }))
          return
        }
        await runtime.store.save({ ...credential, region })
        runtime.catalog.setVisible(true)
        await runtime.refreshCatalog()
        await runtime.refreshCredits()
        refresh()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true }))
        return
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: safeMessage(error) }))
        return
      }
    }
    res.statusCode = 400
    res.end()
  }
  //#endregion

  // Card routes on the host web server (same-origin for the browser half).
  // Deferred injection: a headless host without the webServer service simply
  // never runs this callback, and the model channel keeps working.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const a = webCtx.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/status`, handler: statusHandler })
      const b = webCtx.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/login`, handler: loginHandler })
      const c = webCtx.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/models`, handler: modelsHandler })
      const d = webCtx.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/auth`, handler: authHandler })
      return () => {
        a()
        b()
        c()
        d()
      }
    }, 'dsh-workbuddy-connect: web routes')
  })

  ctx.effect(() => async () => {
    for (const shim of shims.values()) {
      try {
        await shim.close()
      } catch {
        // A shim that fails to close cleanly must not block the teardown.
      }
    }
  })
}

export default { name, inject, apply }

// Internal surfaces exported for tests and CLI use.
export {
  VariantRuntime,
  WORKBUDDY_VARIANTS,
  controlKeys,
  fallbackFor,
  prepareChatBody,
  prepareInternationalChatBody,
  realmOf,
  safeMessage,
  variantFor,
}

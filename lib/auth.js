/**
 * WorkBuddy credential storage and device-authorization login.
 *
 * Every credential the plugin holds comes from the device-authorization flow
 * below, which is what makes this store's write paths the whole story: a login
 * writes one, and a refresh replaces one. Nothing here reads a file the
 * WorkBuddy desktop app wrote, so the plugin works whether or not that app is
 * installed and wherever it happens to keep its state.
 *
 * Two details of the login are load-bearing:
 *
 * - **One cookie jar per attempt.** The CN gateway tags the `auth/state`
 *   response with a routing cookie and correlates the browser's completion with
 *   the state it issued, so the state request and every later poll must present
 *   the same jar. A shared jar would let two concurrent logins (the CN and
 *   international cards) answer for each other.
 * - **A pending login is not an error.** `auth/token` answers HTTP 200 with
 *   business code 11217 while the human has not finished, so the envelope's
 *   code — not the HTTP status — decides pending from complete.
 *
 * @module dsh-workbuddy-connect/auth
 */
import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { realmOf, regionOf } from './upstream.js'
import { createAccountStore } from './accounts.js'
import { workbuddyPluginDataDir } from './paths.js'

/** The one provenance a stored credential can have: this plugin's own login. */
export const WORKBUDDY_CREDENTIAL_SOURCE = 'login'

/** Basename of the plugin-owned credential file inside the plugin's data directory. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Basename of the international variant's credential file. */
export const WORKBUDDY_AI_AUTH_FILENAME = '.workbuddy-ai-auth.json'

/** The on-disk document version this writer produces. */
const OWN_FORMAT_VERSION = 1

/** Upstream host per realm; both serve the identical plugin login paths. */
const LOGIN_BASE = {
  cn: 'https://copilot.tencent.com',
  global: 'https://www.workbuddy.ai',
}

/**
 * Origin and Referer per realm. They are not the same host as the API: the CN
 * deployment serves `copilot.tencent.com` for the `codebuddy.cn` site, and the
 * gateway rejects a request whose Origin does not match the realm it targets.
 */
const LOGIN_ORIGIN = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
}

/** CLI identity the login endpoints expect; unrelated to the chat User-Agent. */
const LOGIN_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** Login round trips are interactive; a slow one is dead, not merely slow. */
const LOGIN_TIMEOUT_MS = 30_000

/** Business code `auth/token` returns while the browser half is unfinished. */
export const LOGIN_PENDING_CODE = 11217

/** Path of the state issuer, relative to the realm's base URL. */
const AUTH_STATE_PATH = '/v2/plugin/auth/state?platform=CLI'

function authTokenPath(state) {
  return `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`
}

function loginAccountPath(state) {
  return `/v2/plugin/login/account?state=${encodeURIComponent(state)}`
}

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export function isDocument(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

/**
 * Parse a WorkBuddy credential document in either on-disk layout: the nested
 * form `{"auth":{...},"account":{...}}` this plugin writes and the flat form
 * hand-written files use. Returns undefined when the document carries no access
 * token.
 */
export function parseWorkBuddyAuth(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isDocument(parsed)) return undefined
  let auth
  let identity
  if (isDocument(parsed['auth'])) {
    auth = parsed['auth']
    identity = isDocument(parsed['account']) ? parsed['account'] : {}
  } else {
    auth = parsed
    identity = parsed
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const realm = optionalString(parsed['region']) ?? optionalString(auth['realm'])
  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs: typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    ...realm === undefined ? {} : { region: realm.trim().toLowerCase() === 'global' ? 'global' : 'cn' },
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: WORKBUDDY_CREDENTIAL_SOURCE,
  }
}

/**
 * Serialize the plugin-owned document in the nested cross-tool layout.
 *
 * `expiresAt` is written in **seconds**, matching the published format this
 * one comes from: the two write the same file, so a value in the wrong unit
 * would be read as an expiry decades away rather than rejected. Readers here
 * accept either unit, which is what makes that safe.
 */
function ownDocument(credential) {
  const region = realmOf(credential)
  return {
    version: OWN_FORMAT_VERSION,
    region,
    auth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: Math.floor(credential.expiresAtMs / 1000),
      ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: Math.floor(credential.refreshExpiresAtMs / 1000) },
      domain: credential.domain,
      realm: region,
    },
    account: {
      uid: credential.uid,
      ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
      ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
    },
  }
}

/** Write a JSON document atomically: a temporary file renamed over the target. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Read a JSON document, or undefined when it is absent or unreadable. */
export function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (isDocument(parsed)) return parsed
  } catch {
    // An absent or malformed file is simply "no document".
  }
  return undefined
}

/**
 * Credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin (or
 * already expired), and keep the refreshed credential in the plugin-owned file.
 * A failed refresh still returns a not-yet-expired token, so an unreachable
 * refresh endpoint does not take down a working session.
 */
export class WorkBuddyCredentialStore {
  /**
   * @param {object} options
   * @param {object} [options.variant] The variant this store belongs to.
   * @param {string} [options.ownPath] Explicit credential path.
   * @param {(credential: object) => Promise<object>} options.refresh Upstream refresh.
   * @param {number} [options.refreshMarginMs] Refresh this long before expiry.
   */
  constructor(options) {
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.dataDir = options.dataDir ?? workbuddyPluginDataDir()
    this.ownPath = options.ownPath ?? join(
      this.dataDir,
      options.variant ? options.variant.authFilename : WORKBUDDY_AUTH_FILENAME,
    )
    /**
     * The realm's account list.
     *
     * `ownPath` stays meaningful: it is the single-file location this store used
     * before accounts existed, and it is where a downgrade would look. Imports
     * from it are additive, so the two layouts agree instead of competing.
     */
    this.accounts = createAccountStore({ realm: options.variant?.region ?? 'cn', dataDir: this.dataDir })
    this.inflight = undefined
  }

  /**
   * Read the active credential, importing the pre-upgrade file on first use.
   *
   * The import runs at read time rather than in a constructor so it cannot make
   * construction fail: a status read must never be the thing that breaks the
   * card.
   */
  async #activeWithMigration() {
    const active = await this.accounts.active()
    if (active !== undefined) return active
    if (await this.accounts.importLegacyFile(this.ownPath)) return this.accounts.active()
    return undefined
  }

  /** The plugin-owned credential path, for diagnostics. */
  ownAuthPath() {
    return this.ownPath
  }

  /**
   * Read the stored credential without refreshing anything.
   *
   * A credential belonging to the other realm is refused rather than used: one
   * plugin serves both products, and sending one realm's token to the other's
   * endpoint would leak it across products.
   */
  async current() {
    const credential = await this.readOwn()
    if (credential === undefined || this.variant === undefined) return credential
    const region = realmOf(credential)
    if (region !== this.variant.region) {
      throw new Error(
        `${this.variant.displayName} holds a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
        + ` (domain ${JSON.stringify(credential.domain)}) in ${this.ownPath};`
        + ` sign in again for ${this.variant.appName}, or remove that file`,
      )
    }
    return credential
  }

  /**
   * Persist a credential a login just obtained. This is the store's only write
   * path besides refresh; the login route is its only caller.
   */
  async save(credential) {
    if (this.variant !== undefined) {
      const region = realmOf(credential)
      if (region !== this.variant.region) {
        throw new Error(
          `refusing to store a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
          + ` for ${this.variant.displayName}`,
        )
      }
    }
    await this.accounts.save(credential)
    // The single-file copy is kept in step as well: it is what a downgrade
    // reads, and what the "import the desktop session" path already wrote.
    await this.saveOwn(credential)
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve() {
    const credential = await this.current()
    if (credential === undefined) {
      const app = this.variant?.appName ?? 'WorkBuddy'
      throw new Error(
        `workbuddy: not signed in to ${app}; sign in from the plugin's settings card`
        + ` (the credential is stored at ${this.ownPath})`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential).finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status() {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        region: realmOf(credential),
      }
    } catch (error) {
      // A realm mismatch (or an unreadable file) is a *diagnosable* signed-out
      // state, not a silent one: the user needs the path to the file that is
      // wrong, and which product it actually belongs to.
      return { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Sign out completely.
   *
   * This used to remove only the active account. With several saved, the
   * account store's "promote another on removal" behaviour turned "退出登录"
   * into a silent switch: the card showed "signed in" again on its next poll,
   * and requests went out under an account the user had just signed out of.
   * Sign-out means ALL accounts for this edition, plus the downgrade copy.
   *
   * Deleting individual accounts is the separate "删除当前" action.
   */
  async logout() {
    await this.accounts.clear()
    // The single-file copy kept for downgrades would otherwise be migrated back
    // on the very next read, making "退出登录" / "清除全部" a no-op. Sign-out and
    // clear are the ONLY operations that are allowed to remove it.
    try {
      const { rm } = await import('node:fs/promises')
      await rm(this.ownPath, { force: true })
    } catch {
      // Nothing to remove, or a filesystem error: signing out is idempotent.
    }
  }

  needsRefresh(credential) {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  async refreshNow(credential) {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again from the settings card')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: WORKBUDDY_CREDENTIAL_SOURCE,
      }
      // Both copies must be updated. resolve() reads the account store, while
      // the legacy single file is kept for downgrades; refreshing only the
      // latter left the active account holding the expired token — the user saw
      // "expired" and every request carried the stale credential.
      await this.accounts.save(refreshed)
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + " sign in again from the plugin's settings card",
      )
    }
  }

  async saveOwn(credential) {
    // The plugin's data directory is created here rather than assumed: the first
    // write of a fresh install is what brings it into being.
    writeJsonAtomic(this.ownPath, ownDocument(credential))
  }

  async readOwn() {
    try {
      return await this.#activeWithMigration()
    } catch {
      // An unreadable account list means "not signed in". The only recovery
      // either way is to sign in again, and a status read must never be the
      // thing that breaks the card.
      return undefined
    }
  }
}

/** A minimal cookie jar, scoped to one login attempt. */
class LoginCookieJar {
  constructor() {
    this.cookies = new Map()
  }

  /** Record every cookie the response set, last write winning per name. */
  absorb(response) {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (name !== '') this.cookies.set(name, value)
    }
  }

  /** The Cookie header for this attempt, or undefined when it holds nothing. */
  header() {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

/** One upstream `{code,msg,data}` reply, decoded tolerantly. */
async function readEnvelope(response) {
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy login: upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (!isDocument(parsed)) {
    throw new Error(`workbuddy login: upstream returned an unexpected document (http ${response.status})`)
  }
  return {
    code: typeof parsed['code'] === 'number' ? parsed['code'] : 0,
    msg: typeof parsed['msg'] === 'string' ? parsed['msg'] : '',
    data: 'data' in parsed ? parsed['data'] : undefined,
  }
}

/**
 * Normalize a realm spelling, folding anything unrecognised onto CN so a
 * missing or mistyped value behaves like the deployment the plugin shipped for.
 */
export function normalizeLoginRegion(region) {
  return String(region ?? '').trim().toLowerCase() === 'global' ? 'global' : 'cn'
}

/**
 * The login client. One instance serves both cards; each attempt owns its own
 * cookie jar, keyed by the state it issued.
 */
export class WorkBuddyLoginClient {
  constructor(fetchImpl = globalThis.fetch) {
    this.fetchImpl = fetchImpl
    this.jars = new Map()
  }

  /** Request headers for one realm, carrying the attempt's cookies when it has any. */
  headers(region, jar) {
    const origin = LOGIN_ORIGIN[region]
    const cookie = jar?.header()
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': origin,
      'Referer': `${origin}/`,
      'User-Agent': LOGIN_USER_AGENT,
      ...cookie === undefined ? {} : { 'Cookie': cookie },
    }
  }

  /**
   * Issue one attempt: obtain the state and the URL the human must open.
   *
   * The response's cookies are retained under the returned state, because the
   * poll that finishes this attempt has to present them.
   */
  async begin(region) {
    const jar = new LoginCookieJar()
    const response = await this.fetchImpl(`${LOGIN_BASE[region]}${AUTH_STATE_PATH}`, {
      method: 'POST',
      headers: this.headers(region),
      body: '{}',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    })
    jar.absorb(response)
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) {
      throw new Error(`workbuddy login: auth state failed (http ${response.status}, code ${envelope.code}): ${envelope.msg.slice(0, 160)}`)
    }
    const data = isDocument(envelope.data) ? envelope.data : {}
    const state = optionalString(data['state'])
    const authUrl = optionalString(data['authUrl'])
    if (state === undefined || authUrl === undefined) {
      throw new Error('workbuddy login: auth state reply carried no state or authUrl')
    }
    this.jars.set(state, jar)
    return { state, authUrl, region }
  }

  /** Drop a finished or abandoned attempt's jar. */
  forget(state) {
    this.jars.delete(state)
  }

  /** How many attempts currently hold a jar; diagnostics and tests. */
  pendingCount() {
    return this.jars.size
  }

  /**
   * Poll one attempt once. The caller drives the cadence.
   *
   * `pending` covers both "the human has not finished" (business code 11217)
   * and "the gateway refused this poll yet" (a 4xx while the browser half is
   * still open). A transport failure, or a 5xx, is a real error and is thrown:
   * retrying those as pending would hide an outage behind a spinner that never
   * resolves.
   */
  async poll(attempt) {
    const jar = this.jars.get(attempt.state)
    const response = await this.fetchImpl(
      `${LOGIN_BASE[attempt.region]}${authTokenPath(attempt.state)}`,
      { method: 'GET', headers: this.headers(attempt.region, jar), signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS) },
    )
    jar?.absorb(response)
    if (response.status >= 500) {
      throw new Error(`workbuddy login: token endpoint failed (http ${response.status})`)
    }
    if (response.status >= 400) return { status: 'pending' }
    const envelope = await readEnvelope(response)
    if (envelope.code === LOGIN_PENDING_CODE) return { status: 'pending' }
    if (envelope.code !== 0) return { status: 'pending' }
    const data = isDocument(envelope.data) ? envelope.data : {}
    const accessToken = optionalString(data['accessToken'])
    if (accessToken === undefined) return { status: 'pending' }
    const tokens = {
      accessToken,
      refreshToken: optionalString(data['refreshToken']) ?? '',
      expiresInSec: typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0 ? data['expiresIn'] : 0,
      domain: optionalString(data['domain']) ?? '',
    }
    return { status: 'complete', tokens, account: await this.fetchAccount(attempt, tokens.accessToken, jar) }
  }

  /**
   * Read the account identity for a finished attempt.
   *
   * Best effort by design: the token bundle is what makes the credential
   * usable, and the identity only improves the display name and the
   * `X-User-Id` header. A failure here must not discard a working login.
   */
  async fetchAccount(attempt, accessToken, jar) {
    try {
      const response = await this.fetchImpl(
        `${LOGIN_BASE[attempt.region]}${loginAccountPath(attempt.state)}`,
        {
          method: 'GET',
          headers: { ...this.headers(attempt.region, jar), 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
        },
      )
      jar?.absorb(response)
      if (!response.ok) return { uid: '' }
      const envelope = await readEnvelope(response)
      const data = isDocument(envelope.data) ? envelope.data : {}
      const enterpriseId = optionalString(data['enterpriseId'])
      const nickname = optionalString(data['nickname'])
      return {
        uid: optionalString(data['uid']) ?? '',
        ...enterpriseId === undefined ? {} : { enterpriseId },
        ...nickname === undefined ? {} : { nickname },
      }
    } catch {
      // Best effort: the credential is already usable.
      return { uid: '' }
    }
  }
}

export { regionOf, realmOf }

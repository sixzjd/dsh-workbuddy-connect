/**
 * More than one account per realm.
 *
 * The plugin used to hold exactly one credential per variant, in one file at the
 * data dir root. That is the common case and stays the common case — but the
 * upstream lets one person have several accounts, and swapping between them meant
 * signing out and back in through a device-authorization flow each time.
 *
 * Layout: one directory per realm, one file per account, one pointer naming the
 * active one.
 *
 *     <dataDir>/accounts/cn/<uidHash>.json
 *     <dataDir>/accounts/cn/active.json      -> { "uidHash": "…" }
 *     <dataDir>/accounts/global/…
 *
 * The file name is a hash of the uid rather than the uid itself: a directory
 * listing is cheap to leak (a screenshot, a bug report paste) and a uid is a
 * stable account identifier. The hash is not a secret — it is derived from the
 * uid, which is why the uid is still stored *inside* the file where it is
 * needed.
 *
 * The realm split is a safety property, not tidiness: the two products' tokens
 * are not interchangeable, and a CN token offered to the international gateway
 * fails at request time, far from the point where the wrong account was picked.
 *
 * @module dsh-workbuddy-connect/accounts
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorkBuddyAuth, readJsonFile, writeJsonAtomic } from './auth.js'
import { realmOf } from './upstream.js'

/** Directory name under the plugin data dir. */
const ACCOUNTS_DIR_NAME = 'accounts'

/** The pointer file naming the active account, per realm. */
const POINTER_FILENAME = 'active.json'

/** Characters a uid hash may use, so a hostile uid cannot escape the directory. */
const UID_HASH_PATTERN = /^[0-9a-f]{16}$/

/**
 * Hash a uid into a file name.
 *
 * Truncated to 16 hex characters (64 bits): this is a file name, not a security
 * boundary, and a collision would need two real accounts sharing a truncated
 * digest to matter. The full uid is preserved inside the file.
 */
export function uidHashOf(uid) {
  return createHash('sha256').update(`workbuddy-account:${uid}`).digest('hex').slice(0, 16)
}

/** Refuse a uid that yields no usable hash, rather than writing to `undefined`. */
function requireHash(uid) {
  if (typeof uid !== 'string' || uid === '') throw new Error('workbuddy: account has no uid; cannot store it')
  const hash = uidHashOf(uid)
  if (!UID_HASH_PATTERN.test(hash)) throw new Error('workbuddy: account uid did not produce a usable file name')
  return hash
}

/**
 * One realm's account list.
 *
 * Stateless apart from its directory: every method reads the disk. That is what
 * lets a switch take effect for the very next request without restarting, and it
 * means a stale in-memory copy can never disagree with what is stored.
 */
export class WorkBuddyAccountStore {
  /**
   * @param {object} options
   * @param {'cn'|'global'} options.realm Which product's accounts these are.
   * @param {string} options.dataDir The plugin data directory.
   */
  constructor(options) {
    this.realm = options.realm
    this.dir = join(options.dataDir, ACCOUNTS_DIR_NAME, options.realm)
  }

  pointerPath() {
    return join(this.dir, POINTER_FILENAME)
  }

  /** Every stored credential file, ignoring the pointer. */
  #credentialFiles() {
    let entries
    try {
      entries = readdirSync(this.dir)
    } catch {
      return []
    }
    return entries
      .filter(name => name.endsWith('.json') && name !== POINTER_FILENAME)
      .map(name => join(this.dir, name))
  }

  #readCredential(path) {
    try {
      return parseWorkBuddyAuth(readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
  }

  /** The active account's uid hash, or undefined when nothing is active. */
  async activeHash() {
    const pointer = readJsonFile(this.pointerPath())
    const hash = pointer?.['uidHash']
    if (typeof hash !== 'string' || !UID_HASH_PATTERN.test(hash)) return undefined
    // A pointer to a file that no longer exists is the same as no pointer: the
    // honest answer is "nothing is active", not a broken credential.
    return existsSync(join(this.dir, `${hash}.json`)) ? hash : undefined
  }

  /**
   * The active credential, or undefined.
   *
   * Verified against this realm on the way out. A credential that names another
   * realm is not returned: it would be sent to the wrong gateway.
   */
  async active() {
    const hash = await this.activeHash()
    if (hash === undefined) return undefined
    const credential = this.#readCredential(join(this.dir, `${hash}.json`))
    if (credential === undefined) return undefined
    if (realmOf(credential) !== this.realm) return undefined
    return credential
  }

  /**
   * Import the single credential file this plugin used to keep, once.
   *
   * Every existing install has exactly one credential at the data dir root, and
   * an upgrade must not look like a sign-out. The import is additive: the legacy
   * file is left in place, because it is also what an older version of the plugin
   * would read after a downgrade, and deleting the user's only credential to
   * tidy up is not worth that risk.
   *
   * Idempotent: importing the same file twice updates one account.
   *
   * @param {string} legacyPath The single-file credential path.
   * @returns {Promise<boolean>} Whether anything was imported.
   */
  async importLegacyFile(legacyPath) {
    let text
    try {
      text = readFileSync(legacyPath, 'utf8')
    } catch {
      return false
    }
    const credential = parseWorkBuddyAuth(text)
    if (credential === undefined) return false
    if (realmOf(credential) !== this.realm) return false
    if (typeof credential.uid !== 'string' || credential.uid === '') return false
    const hash = uidHashOf(credential.uid)
    const target = join(this.dir, `${hash}.json`)
    // Never overwrite a newer stored copy with the legacy one: after the first
    // import the account file is the one that gets refreshed, so the legacy file
    // is progressively staler.
    if (!existsSync(target)) {
      writeJsonAtomic(target, credentialDocument(credential))
    }
    // Only claim the active slot if nothing holds it yet, so an upgrade does not
    // silently switch away from an account the user chose afterwards.
    if (await this.activeHash() === undefined) {
      writeJsonAtomic(this.pointerPath(), { version: 1, uidHash: hash })
    }
    return true
  }

  /**
   * Store a credential and make it the active one.
   *
   * Saving is "use this account now": the caller has just signed in or imported
   * it, and a save that left some other account active would look like the
   * sign-in had not worked.
   */
  async save(input) {
    // Accepts either a parsed credential or the document shape that lives on
    // disk. Both arrive in practice: a sign-in produces the former, and importing
    // an existing file (or migrating the single-file layout) produces the latter.
    const credential = normalizeCredential(input)
    if (credential === undefined) throw new Error('workbuddy: refusing to store an unreadable credential')
    const realm = realmOf(credential)
    if (realm !== this.realm) {
      throw new Error(
        `refusing to store a ${realm === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
        + ` in the ${this.realm === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} account list`,
      )
    }
    const hash = requireHash(credential.uid)
    writeJsonAtomic(join(this.dir, `${hash}.json`), credentialDocument(credential))
    writeJsonAtomic(this.pointerPath(), { version: 1, uidHash: hash })
  }

  /**
   * Make an existing account active.
   *
   * Throws when the uid is not stored. Falling back to "no account" would sign
   * the user out, and falling back to a different account would send their
   * requests to somebody else's — both worse than an error the card can show.
   */
  async activate(handle) {
    const hash = await this.#resolveHandle(handle)
    writeJsonAtomic(this.pointerPath(), { version: 1, uidHash: hash })
  }

  /**
   * Turn a handle into a stored account's hash.
   *
   * A handle is the uid hash the list handed out, or a full uid when the caller
   * already has one (a sign-in does). Callers that only ever saw the list must
   * use the hash: the list deliberately does not carry the full uid.
   */
  async #resolveHandle(handle) {
    if (typeof handle !== 'string' || handle === '') {
      throw new Error('workbuddy: an account handle is required')
    }
    const direct = UID_HASH_PATTERN.test(handle) ? handle : undefined
    if (direct !== undefined && existsSync(join(this.dir, `${direct}.json`))) return direct
    const hash = requireHash(handle)
    if (!existsSync(join(this.dir, `${hash}.json`))) {
      throw new Error(`workbuddy: unknown account ${JSON.stringify(handle.slice(0, 8))}; add it first`)
    }
    return hash
  }

  /**
   * Forget one account.
   *
   * When the removed account was the active one, another is promoted rather
   * than leaving the variant signed out while a usable credential is still on
   * disk. When it was the last one, nothing is promoted and the variant is
   * genuinely signed out.
   */
  async remove(handle) {
    const hash = await this.#resolveHandle(handle)
    // Read the pointer BEFORE deleting the file. `activeHash()` treats a pointer
    // to a missing file as "nothing active", so asking afterwards would always
    // look like this account was not the active one and the promotion below
    // would never run.
    const wasActive = await this.activeHash() === hash
    const target = join(this.dir, `${hash}.json`)
    if (existsSync(target)) rmSync(target, { force: true })
    if (!wasActive) return
    rmSync(this.pointerPath(), { force: true })
    const remaining = (await this.list()).filter(account => account.hash !== hash)
    // `remaining` is already ordered oldest-first by uid, which is stable and
    // predictable; the point is only that *something* usable becomes active.
    if (remaining.length > 0) await this.activate(remaining[0].hash)
  }

  /**
   * The accounts this realm holds, oldest name first.
   *
   * Deliberately a summary: the page renders this, so it carries no token and no
   * full uid. `expired` is reported rather than filtered — an expired account is
   * precisely the one the user needs to see, so they know to sign in again.
   */
  async list() {
    const activeHash = await this.activeHash()
    const accounts = []
    for (const path of this.#credentialFiles()) {
      const credential = this.#readCredential(path)
      if (credential === undefined) continue
      if (realmOf(credential) !== this.realm) continue
      if (typeof credential.uid !== 'string' || credential.uid === '') continue
      const hash = uidHashOf(credential.uid)
      accounts.push({
        // NOT the full uid: the handle is the hash, and the short prefix is
        // enough for a human to tell two accounts apart. A screenshot of the
        // card should not be a copy of a stable account identifier.
        uidShort: credential.uid.slice(0, 8),
        hash,
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        expiresAtMs: credential.expiresAtMs,
        expired: !(credential.expiresAtMs > Date.now()),
        active: hash === activeHash,
      })
    }
    accounts.sort((a, b) => a.uidShort.localeCompare(b.uidShort))
    return accounts
  }
}

/**
 * Serialize in the cross-tool layout the store already writes.
 *
 * Duplicated from auth.js's private `ownDocument` on purpose: that one is not
 * exported, and widening its export would tempt other modules to depend on the
 * single-file layout this module exists to move past. The format itself must
 * stay identical — the same file is read by other tools.
 */
function normalizeCredential(input) {
  if (typeof input !== 'object' || input === null) return undefined
  if (typeof input.accessToken === 'string') return input
  // A document: parse it through the same reader the store uses for its own
  // files, so the two shapes cannot drift.
  return parseWorkBuddyAuth(JSON.stringify(input))
}

function credentialDocument(credential) {
  const region = realmOf(credential)
  return {
    version: 1,
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

/** Create the store for one realm. */
export function createAccountStore(options) {
  return new WorkBuddyAccountStore(options)
}

/** The accounts directory for one realm, for diagnostics. */
export function accountsDirOf(dataDir, realm) {
  return join(dataDir, ACCOUNTS_DIR_NAME, realm)
}

/** Create it if absent (mode 0700: it holds credentials). */
export function ensureAccountsDir(dataDir, realm) {
  const dir = accountsDirOf(dataDir, realm)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
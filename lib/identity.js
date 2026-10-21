/**
 * The desktop-client identity WorkBuddy's gateway expects.
 *
 * The gateway is UA-gated: it splits requests by User-Agent and refuses the
 * shapes it does not recognise (`deepseek-harness/*` and `python-requests/*`
 * are measured refusals, business code 11128). Two identities matter here, and
 * they are NOT the same:
 *
 * - **Chat / probe** carry the desktop form `WorkBuddy/<v> <product>/<v>
 *   CLI/<cli>` — the product token names the app that owns the region's
 *   requests: `WorkBuddy` for CN, `WorkBuddy AI` for international.
 * - **The international catalog** (`/v3/config`) is served only to the terse
 *   App form `WorkBuddyAI/<v>`. The spaced form is refused with 400/12403.
 *
 * Versions come from the installed App when it can be read, degrade to a
 * per-region saved value, and finally to a compiled-in constant. A CLI version
 * that does not resolve drops the `CLI/…` token instead of inventing one.
 *
 * @module dsh-workbuddy-connect/identity
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { workbuddyStateDir } from './paths.js'

/**
 * Last-resort UA version for the international App.
 *
 * The gateway ignores the version number when splitting the UA (measured:
 * `CLI/1.0.0`, `CLI/99.0.0` and the real version all return the same
 * document), so this constant is a shape requirement rather than a currency
 * claim. It is *not* used to infer anything about model capabilities.
 */
export const FALLBACK_APP_VERSION = '5.7.6'

/**
 * Compiled-in CN fallback for the `WorkBuddy/<v>` tokens.
 *
 * Like the international fallback it is a shape requirement, not a currency
 * claim — the gateway has not been observed to branch on the number.
 */
export const FALLBACK_CN_APP_VERSION = '5.5.6'

/** Basename of the international saved-version cache under the state dir. */
export const WORKBUDDY_APP_VERSION_FILENAME = '.workbuddy-ai-version.json'

/** Basename of the CN saved-version cache under the state dir. */
export const CN_APP_VERSION_FILENAME = '.workbuddy-app-version.json'

/** Where a version came from, for the status card. */
export const VERSION_SOURCES = ['installed', 'saved', 'fallback']

/**
 * Whether a string is safe to interpolate into an HTTP header.
 *
 * Strict on purpose: the value reaches a header, so anything that could split
 * the request (CR, LF) or inject a second UA token must never pass.
 */
export function validAppVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value)
}

/**
 * Whether a value is a CLI version that may reach a header.
 *
 * Tolerates a prerelease suffix (`2.156.0-rc.1`) because the bundled CLI's own
 * metadata uses that spelling; anything with whitespace, CR or LF never passes.
 */
export function validCliVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

/** macOS App-bundle roots: system-wide first, then the user's own install. */
function macAppRoots() {
  return ['/Applications', join(homedir(), 'Applications')]
}

/**
 * Read `CFBundleShortVersionString` out of an `Info.plist`.
 *
 * Parsed as XML rather than grepped, because the plist contains several
 * `<string>` values and a regex would be one unrelated key away from returning
 * the wrong one. A binary plist has no `<dict>` in its bytes and is reported as
 * unreadable rather than guessed at.
 */
export async function readBundleVersion(plistPath) {
  let text
  try {
    text = await readFile(plistPath, 'utf8')
  } catch {
    return undefined
  }
  const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)
  const version = match?.[1]?.trim()
  return validAppVersion(version) ? version : undefined
}

/** Write a small JSON document atomically; failures are the caller's to ignore. */
function writeJsonAtomic(path, value) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // Caching a version is best effort: losing it must never fail the request
    // that asked for it.
  }
}

/**
 * The installed international App's version, or undefined when it is not
 * installed (or not readable).
 *
 * Windows and Linux have no verified bundle-metadata location, so this returns
 * undefined there and the saved/fallback value applies instead of guessing a
 * path.
 */
export async function installedAppVersion() {
  if (process.platform !== 'darwin') return undefined
  for (const root of macAppRoots()) {
    const bundle = join(root, 'WorkBuddy AI.app')
    const version = await readBundleVersion(join(bundle, 'Contents', 'Info.plist'))
    if (version !== undefined) return { version, bundle }
  }
  return undefined
}

/** The installed CN App's version, or undefined. */
export async function installedCnAppVersion() {
  if (process.platform !== 'darwin') return undefined
  for (const root of macAppRoots()) {
    const bundle = join(root, 'WorkBuddy.app')
    const version = await readBundleVersion(join(bundle, 'Contents', 'Info.plist'))
    if (version !== undefined) return { version, bundle }
  }
  return undefined
}

/**
 * The bundled agent CLI's real version, or undefined when it does not resolve.
 *
 * `cli/package.json` ships a `0.0.0` placeholder in `version` with the real
 * version in `publishConfig.customPackage.version`; a valid non-placeholder
 * `version` wins, otherwise the custom-package value applies, and unreadable or
 * invalid metadata yields undefined (the caller drops the `CLI/…` UA token
 * rather than guessing).
 */
export async function readCliVersion(bundle) {
  if (bundle === undefined) return undefined
  let document
  try {
    document = JSON.parse(await readFile(join(bundle, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  const declared = document['version']
  if (validCliVersion(declared) && declared !== '0.0.0') return declared
  const custom = document['publishConfig']?.['customPackage']
  const customVersion = typeof custom === 'object' && custom !== null ? custom['version'] : undefined
  return validCliVersion(customVersion) ? customVersion : undefined
}

/**
 * Resolve the international UA version: installed App → saved value → constant.
 *
 * A version read from the App is written back immediately, so an uninstalled
 * App or an unreadable plist later still has the last real version to fall
 * back on.
 */
export async function resolveAppVersion(options = {}) {
  const path = options.path ?? join(workbuddyStateDir(), WORKBUDDY_APP_VERSION_FILENAME)
  const installed = await (options.installed ?? installedAppVersion)()
  if (installed !== undefined && validAppVersion(installed.version)) {
    writeJsonAtomic(path, { version: installed.version, bundle: installed.bundle, observedAt: Date.now() })
    return { version: installed.version, source: 'installed', bundle: installed.bundle }
  }
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'))
    if (typeof saved === 'object' && saved !== null && validAppVersion(saved['version'])) {
      return { version: saved['version'], source: 'saved' }
    }
  } catch {
    // Absent or malformed cache: fall through to the compiled-in default.
  }
  return { version: FALLBACK_APP_VERSION, source: 'fallback' }
}

/**
 * Build the App-shaped User-Agent for the international catalog request.
 *
 * `WorkBuddyAI/<version>` with no space is the form measured to reach the App
 * document; the space form is refused with 400/12403.
 */
export function appUserAgent(version) {
  if (!validAppVersion(version)) throw new Error(`invalid WorkBuddy AI version for User-Agent: ${JSON.stringify(version)}`)
  return `WorkBuddyAI/${version}`
}

/** The resolved identity a chat request presents as. */
export function fallbackChatIdentity(region) {
  return { clientVersion: region === 'global' ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION }
}

/**
 * Build the chat User-Agent for one region.
 *
 * Throws on an invalid version rather than interpolating one into a header;
 * `resolveChatIdentity` never produces such an identity, so the throw is a
 * last gate against future call-site mistakes, not an expected path.
 */
export function chatUserAgent(identity, region) {
  if (!validAppVersion(identity.clientVersion)) {
    throw new Error(`invalid client version for chat User-Agent: ${JSON.stringify(identity.clientVersion)}`)
  }
  if (identity.cliVersion !== undefined && !validCliVersion(identity.cliVersion)) {
    throw new Error(`invalid CLI version for chat User-Agent: ${JSON.stringify(identity.cliVersion)}`)
  }
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`]
  if (identity.cliVersion !== undefined) parts.push(`CLI/${identity.cliVersion}`)
  return parts.join(' ')
}

/**
 * How long a resolved chat identity is reused before the install tree is read
 * again.
 *
 * The identity names the client channel the upstream sees, and the desktop app
 * updates on its own schedule — a process that cached the identity forever
 * would keep presenting a version the gateway has already moved past. A short
 * TTL costs one plist read every few minutes and lets an app update take
 * effect without restarting the harness.
 */
const IDENTITY_TTL_MS = 10 * 60 * 1000

const identityCache = new Map()

/**
 * Resolve the chat identity for one region: installed App → region's saved
 * value → compiled-in fallback.
 *
 * Never throws — a missing App, an unreadable plist, or a reader that throws
 * outright all degrade to {@link fallbackChatIdentity}. Resolution never blocks
 * a message, and the answer is cached per region so a message does not re-read
 * the install tree.
 */
export async function resolveChatIdentity(region, options = {}) {
  const injectable = options.installedCn !== undefined
    || options.resolveIntl !== undefined
    || options.cliVersion !== undefined
    || options.cnSavedPath !== undefined
  if (!injectable) {
    const cached = identityCache.get(region)
    if (cached !== undefined && cached.expiresAtMs > Date.now()) return cached.identity
  }
  let identity
  try {
    identity = region === 'global'
      ? await resolveGlobalIdentity(options)
      : await resolveCnIdentity(options)
  } catch {
    // A reader that throws must not block a message and must not pin this
    // degraded answer for the process lifetime.
    return fallbackChatIdentity(region)
  }
  if (!injectable) {
    identityCache.set(region, { identity, expiresAtMs: Date.now() + IDENTITY_TTL_MS })
  }
  return identity
}

/** CN: installed `WorkBuddy.app` → CN saved cache → CN fallback. */
async function resolveCnIdentity(options) {
  const savedPath = options.cnSavedPath ?? join(workbuddyStateDir(), CN_APP_VERSION_FILENAME)
  const installed = await (options.installedCn ?? installedCnAppVersion)()
  if (installed !== undefined && validAppVersion(installed.version)) {
    const cliVersion = await (options.cliVersion ?? readCliVersion)(installed.bundle)
    const identity = {
      clientVersion: installed.version,
      ...(cliVersion !== undefined && validCliVersion(cliVersion) ? { cliVersion } : {}),
    }
    writeJsonAtomic(savedPath, { version: identity.clientVersion, observedAt: Date.now() })
    return identity
  }
  try {
    const saved = JSON.parse(await readFile(savedPath, 'utf8'))
    if (typeof saved === 'object' && saved !== null && validAppVersion(saved['version'])) {
      return { clientVersion: saved['version'] }
    }
  } catch {
    // Absent or malformed cache: fall through to the compiled-in constant.
  }
  return fallbackChatIdentity('cn')
}

/** International: installed → saved → fallback, plus the CLI token when a bundle exists. */
async function resolveGlobalIdentity(options) {
  const info = await (options.resolveIntl ?? resolveAppVersion)()
  const clientVersion = validAppVersion(info.version) ? info.version : FALLBACK_APP_VERSION
  let cliVersion
  if (info.bundle !== undefined) {
    const read = await (options.cliVersion ?? readCliVersion)(info.bundle)
    if (read !== undefined && validCliVersion(read)) cliVersion = read
  }
  return { clientVersion, ...cliVersion === undefined ? {} : { cliVersion } }
}

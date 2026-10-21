/**
 * Reading the WorkBuddy desktop app's own session, when it is installed.
 *
 * Since WorkBuddy 5.6.0 the desktop app stores its credential *encrypted at
 * rest*: the access token, the refresh token and the nickname are each written
 * as `{"$wbEncrypted":1,"envelope":"<base64>"}`, where the envelope is
 * `{suite, keyId, nonce, authTag, ciphertext}` — AES-256-GCM with a 12-byte
 * nonce and a 16-byte tag, over a length-prefixed transcript that binds the
 * ciphertext to the exact field it was written for.
 *
 * The key is not a user secret: it is a build-time constant compiled into the
 * app's own Electron native module, and the app hands it out through
 * `loggerGet()`. This module therefore asks the very build that wrote the file
 * — running its binary as plain Node (`ELECTRON_RUN_AS_NODE=1`) and calling the
 * binding — rather than carrying a copy of a build-specific constant. The
 * derived key lives in memory for the process lifetime and is never written to
 * disk or logged.
 *
 * This is an **optional convenience**, not a dependency: the plugin's own
 * device-authorization login (see `auth.js`) is the primary path and works
 * whether or not the desktop app is installed. When the app *is* installed,
 * importing its session saves a browser round trip.
 *
 * @module dsh-workbuddy-connect/atrest
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How long the app is given to answer with its key payload. */
const KEY_FETCH_TIMEOUT_MS = 15_000

/** Envelope framing names, mapped to the single-byte AAD framing code. */
const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 }

/** Standard (symmetric) format identifiers, transcripted into the AAD. */
const STANDARD_FORMAT_ID = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' }

/** Domain separator the AAD transcript starts with. */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')

/** Scheme name of the symmetric envelope this module opens. */
const SYMMETRIC_SCHEME = 'sym-v1'

/** Environment override pointing at the WorkBuddy desktop executable. */
export const WORKBUDDY_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'

function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** Length-prefixed UTF-8 string: uint32 big-endian length followed by the bytes. */
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/**
 * The authenticated additional data for one `sym-v1` FIELD-framed envelope.
 *
 * Only the field framing is implemented: it is the shape the desktop app uses
 * for credential fields, and it is also the shape that cannot be confused with
 * a whole-file envelope, so an unexpected framing is a parse error rather than
 * a silently wrong transcript.
 */
function fieldAad(keyId, suite) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('workbuddy: envelope keyId is malformed')
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID.field),
    encodeLengthPrefixed(SYMMETRIC_SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE.field]),
    // Field framing carries no sequence, and the envelope is not final.
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/** Whether a value is the app's encrypted-field wrapper. */
export function isEncryptedFieldWrapper(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === 2
    && keys[0] === '$wbEncrypted'
    && keys[1] === 'envelope'
    && value['$wbEncrypted'] === 1
    && typeof value['envelope'] === 'string'
}

/**
 * The at-rest key id for a derived 32-byte key: the first 16 hex characters
 * of its SHA-256. The envelope's `keyId` is checked against this, so a
 * mismatched key fails loudly instead of returning garbage.
 */
export function deriveAtRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Derive the 32-byte field key from the app's key payload.
 *
 * The app hashes the payload's base64 STRING — not its decoded bytes — so the
 * same spelling is required here; hashing the decoded secret would produce a
 * different key and every field would fail to open.
 */
export function deriveAtRestKey(payloadJson) {
  let payload
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('workbuddy: the at-rest key payload is not valid JSON')
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('workbuddy: the at-rest key payload is not an object')
  }
  const secret = payload['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('workbuddy: the at-rest key payload carries no atRestSecretKey')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

/**
 * Open one encrypted field with a derived key and return its plaintext.
 *
 * Throws when the envelope is malformed, belongs to another key, or fails
 * authentication — a GCM tag mismatch is the signal that the transcript or the
 * key is wrong, and it must never degrade into a truncated token.
 */
export function openEncryptedField(field, key) {
  if (!isEncryptedFieldWrapper(field)) throw new Error('workbuddy: not an encrypted-field wrapper')
  let record
  try {
    record = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  } catch {
    throw new Error('workbuddy: the encrypted-field envelope is not valid base64 JSON')
  }
  const suite = record['suite']
  const keyId = record['keyId']
  const nonce = record['nonce']
  const authTag = record['authTag']
  const ciphertext = record['ciphertext']
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('workbuddy: the encrypted-field envelope is missing suite or keyId')
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('workbuddy: the encrypted-field envelope is missing nonce, authTag or ciphertext')
  }
  const expectedKeyId = deriveAtRestKeyId(key)
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: the encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

/** macOS App-bundle roots: system-wide first, then the user's own install. */
function macAppRoots() {
  return ['/Applications', join(homedir(), 'Applications')]
}

/**
 * The `CFBundleExecutable` out of an `Info.plist`.
 *
 * The binary is named `Electron` for BOTH WorkBuddy bundles — the app is an
 * Electron app, and every Electron app's executable is called `Electron` — so
 * the bundle identifier has to be confirmed before the binary is run. Running
 * some other Electron app's binary would ask the wrong program for a key.
 */
function bundleExecutable(bundle) {
  const plist = join(bundle, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return undefined
  let text
  try {
    text = readFileSync(plist, 'utf8')
  } catch {
    return undefined
  }
  const executable = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1]?.trim()
  if (executable === undefined || executable === '') return undefined
  const identifier = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1]?.trim()
  if (identifier === undefined || !/workbuddy/i.test(identifier)) return undefined
  const path = join(bundle, 'Contents', 'MacOS', executable)
  return existsSync(path) ? path : undefined
}

/**
 * The installed WorkBuddy desktop executable, or undefined.
 *
 * The international bundle is `WorkBuddy AI.app` and the CN one is
 * `WorkBuddy.app`; both are looked for, and the first that carries a
 * WorkBuddy bundle identifier wins.
 */
export function findDesktopExecutable() {
  const override = process.env[WORKBUDDY_APP_EXECUTABLE_ENV]
  if (override !== undefined && override.trim() !== '') return override.trim()
  if (process.platform !== 'darwin') return undefined
  for (const root of macAppRoots()) {
    for (const name of ['WorkBuddy AI.app', 'WorkBuddy.app']) {
      const found = bundleExecutable(join(root, name))
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Ask the installed desktop app for its key payload by running its own binary
 * as plain Node and calling the native binding.
 *
 * The binding is the app's own public surface for this value, so the plugin
 * never carries a copy of a build-specific constant. The child is given no
 * stdin and a hard timeout, and its stdout is the only thing read.
 */
export function fetchAtRestKeyPayload(executable) {
  return new Promise((resolve, reject) => {
    const source = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"
    execFile(
      executable,
      ['-e', source],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`))
          return
        }
        const payload = stdout.trim()
        if (payload === '') {
          reject(new Error('workbuddy: the desktop app returned an empty at-rest key payload'))
          return
        }
        resolve(payload)
      },
    )
  })
}

/** Process-lifetime cache of the derived key; never persisted. */
let cachedKey
let inflightKey

/**
 * The derived at-rest key, or undefined when the desktop app cannot be asked.
 *
 * A failure is remembered briefly so a machine without the app does not spawn
 * a child process for every probe.
 */
export async function resolveAtRestKey() {
  if (cachedKey !== undefined) return cachedKey
  inflightKey ??= (async () => {
    const executable = findDesktopExecutable()
    if (executable === undefined) return undefined
    try {
      const payload = await fetchAtRestKeyPayload(executable)
      return deriveAtRestKey(payload)
    } catch {
      // The app is installed but did not answer: treat it as "no key" rather
      // than as a hard failure, so the plugin's own login path still works.
      return undefined
    }
  })().finally(() => {
    inflightKey = undefined
  })
  cachedKey = await inflightKey
  return cachedKey
}

/**
 * The directory the desktop app keeps its credential files in.
 *
 * `WORKBUDDY_AUTH_FILE` overrides it, which is how a test or a relocated app
 * points the plugin at a specific document.
 */
export function desktopAuthDir() {
  const override = process.env['WORKBUDDY_AUTH_FILE']
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
}

/**
 * The newest credential document the desktop app wrote, or undefined.
 *
 * The app rotates its file (the `workbuddy-desktop*.info` family carries a
 * timestamp in its name), so the newest one by modification time is the
 * current session.
 */
export function findDesktopCredentialFile(dir = desktopAuthDir()) {
  const override = process.env['WORKBUDDY_AUTH_FILE']
  if (override !== undefined && override.trim() !== '') {
    return existsSync(override) ? override : undefined
  }
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  let best
  let bestAt = 0
  for (const entry of entries) {
    if (!entry.startsWith('workbuddy-desktop') || !entry.endsWith('.info')) continue
    const path = join(dir, entry)
    let at
    try {
      at = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (at > bestAt) {
      bestAt = at
      best = path
    }
  }
  return best
}

/**
 * The desktop app's current session, decrypted.
 *
 * Returns undefined when the app is not installed, has never signed in, or
 * cannot be asked for its key. Every failure inside is a reason to fall back
 * to the plugin's own login, never an error the user has to act on.
 */
export async function readDesktopCredential(dir = desktopAuthDir()) {
  const file = findDesktopCredentialFile(dir)
  if (file === undefined) return undefined
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null) return undefined
  const auth = document['auth']
  const account = document['account']
  if (typeof auth !== 'object' || auth === null) return undefined

  const key = await resolveAtRestKey()
  if (key === undefined) return undefined

  const open = (value) => {
    if (isEncryptedFieldWrapper(value)) return openEncryptedField(value, key)
    return typeof value === 'string' ? value : undefined
  }
  const accessToken = open(auth['accessToken'])
  if (accessToken === undefined || accessToken === '') return undefined
  const refreshToken = open(auth['refreshToken']) ?? ''
  const nickname = typeof account === 'object' && account !== null ? open(account['nickname']) : undefined
  const domain = typeof auth['domain'] === 'string' ? auth['domain'] : ''
  const expiresAt = typeof auth['expiresAt'] === 'number' ? auth['expiresAt'] : 0
  const refreshExpiresAt = typeof auth['refreshExpiresAt'] === 'number' ? auth['refreshExpiresAt'] : undefined
  const uid = typeof account === 'object' && account !== null && typeof account['uid'] === 'string' ? account['uid'] : ''
  const enterpriseId = typeof account === 'object' && account !== null && typeof account['enterpriseId'] === 'string'
    ? account['enterpriseId']
    : undefined
  return {
    accessToken,
    refreshToken,
    domain,
    expiresAtMs: expiresAt,
    ...refreshExpiresAt === undefined ? {} : { refreshExpiresAtMs: refreshExpiresAt },
    uid,
    ...nickname === undefined ? {} : { nickname },
    ...enterpriseId === undefined ? {} : { enterpriseId },
    source: 'desktop-app',
  }
}

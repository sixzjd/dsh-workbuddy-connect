/**
 * Whether this checkout is behind its git remote, and how it got installed.
 *
 * The harness only offers an "Update" button for the *official* on-demand
 * catalog: `updateAvailable()` requires a `pkg.installTarget`, and the plugin
 * manager computes one exclusively from `OFFICIAL_ON_DEMAND_CATALOG`. A
 * community bundle installed from `github:…` therefore has no `installTarget`
 * and never shows the button, however far behind it is.
 *
 * This module answers the two questions the card needs to stand in for that
 * missing button: *what am I pinned to* (read from the profile manifest and the
 * pnpm lockfile, never from network state) and *what does the remote say now*
 * (`git ls-remote`, the cheapest call that names a commit without cloning).
 *
 * It deliberately never writes anything. Installing is the plugin manager's
 * job — it owns the profile lock, the pnpm invocation and the reload lifecycle
 * — so this only produces a report for the card to act on.
 *
 * @module dsh-workbuddy-connect/updates
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The package this repository publishes; the manifest key and the git repo share the name. */
export const PACKAGE_NAME = 'dsh-workbuddy-connect'

/** How long a `git ls-remote` may take before the card reports "unknown". */
export const LS_REMOTE_TIMEOUT_MS = 15_000

/**
 * The branch an unpinned `github:` spec resolves to.
 *
 * pnpm resolves a bare git spec to the remote's HEAD, which for every
 * repository this plugin has ever been installed from is `main`.
 */
const DEFAULT_BRANCH = 'main'

/**
 * Parse a dependency spec into what the update check needs.
 *
 * Understands the three shapes a git-hosted bundle can be installed as, and
 * reports `local` for anything else (`file:`, `link:`, a registry range) so the
 * card can say "this copy cannot be updated from here" rather than offering a
 * button that would install something else over it.
 *
 * @param {string} spec The `dependencies[PACKAGE_NAME]` value.
 * @returns {{kind: 'git', url: string, ref?: string} | {kind: 'local'}}
 */
export function parseInstallSpec(spec) {
  if (typeof spec !== 'string') return { kind: 'local' }
  const trimmed = spec.trim()
  // `github:owner/repo`, `gitlab:…`, `bitbucket:…` — pnpm's host shorthands.
  const shorthand = /^(github|gitlab|bitbucket|gist):([^#]+)(?:#(.*))?$/i.exec(trimmed)
  if (shorthand !== null) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', gist: 'gist.github.com' }[shorthand[1].toLowerCase()]
    const repo = shorthand[2].replace(/^\/+/, '')
    return withRef(`https://${host}/${repo}.git`, shorthand[3])
  }
  // `git+https://…`, `git+ssh://…`, `git://…`
  const gitUrl = /^git\+(https?|ssh):\/\/(.+)$/i.exec(trimmed)
  if (gitUrl !== null) {
    const rest = gitUrl[2]
    const hash = rest.indexOf('#')
    const repo = hash === -1 ? rest : rest.slice(0, hash)
    const ref = hash === -1 ? undefined : rest.slice(hash + 1)
    return withRef(`${gitUrl[1].toLowerCase()}://${repo}`, ref)
  }
  // A plain HTTPS repository URL (no `.git` suffix required).
  const plain = /^(https?):\/\/([^#]+?)(?:#(.*))?$/i.exec(trimmed)
  if (plain !== null && /\.git$/i.test(plain[2])) return withRef(`${plain[1]}://${plain[2]}`, plain[3])
  return { kind: 'local' }
}

/** Attach a ref only when one was written; an empty `#` means "the default branch". */
function withRef(url, ref) {
  return ref === undefined || ref.trim() === '' ? { kind: 'git', url } : { kind: 'git', url, ref: ref.trim() }
}

/**
 * The commit a spec pins, if it pins one.
 *
 * A full or abbreviated object id is a pin; a branch or tag name is not, because
 * the question the card answers is "did upstream move past what I have", which
 * only a commit id can be compared against.
 *
 * @param {string} installSpec
 * @returns {string|undefined}
 */
export function pinnedCommit(installSpec) {
  const parsed = parseInstallSpec(installSpec)
  if (parsed.kind !== 'git' || parsed.ref === undefined) return undefined
  return /^[0-9a-f]{7,40}$/i.test(parsed.ref) ? parsed.ref.toLowerCase() : undefined
}

/**
 * The lines of one package's entry in a lockfile's importer block.
 *
 * Hand-rolled rather than a single regex because indentation is not fixed
 * (pnpm writes six spaces, a hand-edited lock has fewer) and because a regex
 * that misses the header has an obvious failure mode that is very hard to
 * notice: the search silently widens to the whole file and picks up a
 * *neighbouring* package's commit. That mistake reports another plugin's
 * version as this one's, which is exactly the kind of wrong answer a user
 * cannot sanity-check.
 *
 * The entry is the header line plus every following line that is indented
 * deeper than the header or blank.
 *
 * @param {string} lockText
 * @param {string} packageName
 * @returns {string} The entry's text, or '' when the package has no entry.
 */
function importerBlockOf(lockText, packageName) {
  const lines = lockText.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const header = /^([ \t]*)([^\s:#][^:]*):[ \t]*$/.exec(line)
    if (header === null || header[2].trim() !== packageName) continue
    const indent = header[1].length
    const collected = [line]
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]
      if (candidate.trim() === '') {
        collected.push(candidate)
        continue
      }
      const leading = /^[ \t]*/.exec(candidate)[0].length
      if (leading <= indent) break
      collected.push(candidate)
    }
    return collected.join('\n')
  }
  return ''
}

/**
 * The commit pnpm actually installed, as recorded in the lockfile.
 *
 * The manifest states the *request*, which can be a branch; the lockfile states
 * the *result*, which is always a resolved commit for a git dependency. Reading
 * the lockfile matters because `packages[].gitHead` is not written for git
 * dependencies, so this is the only on-disk record of what is running.
 *
 * @param {string} lockText The text of the profile's `pnpm-lock.yaml`.
 * @returns {string|undefined}
 */
export function installedCommitFromLock(lockText) {
  if (typeof lockText !== 'string') return undefined
  // The importer block names the package, then `version:` carries the resolved
  // git URL ending in `#<commit>`. Both `git+https://…` and the codeload
  // `https://…/tar.gz/<commit>` form appear in the wild.
  const scope = importerBlockOf(lockText, PACKAGE_NAME)
  const byHash = /version:\s*[^\s#]+#([0-9a-f]{7,40})\b/i.exec(scope)
  if (byHash !== null) return byHash[1].toLowerCase()
  const byPath = /version:\s*\S*?\/tar\.gz\/([0-9a-f]{7,40})\b/i.exec(scope)
  if (byPath !== null) return byPath[1].toLowerCase()
  return undefined
}

/**
 * Read what this profile has installed, without touching the network.
 *
 * @param {string} profileDir The profile directory.
 * @returns {{installSpec?: string, pinned?: string, installed?: string}}
 */
export function readLocalState(profileDir) {
  let installSpec
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const value = manifest.dependencies?.[PACKAGE_NAME] ?? manifest.devDependencies?.[PACKAGE_NAME]
    if (typeof value === 'string') installSpec = value
  } catch {}
  let installed
  try {
    installed = installedCommitFromLock(readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8'))
  } catch {}
  const pinned = installSpec === undefined ? undefined : pinnedCommit(installSpec)
  return {
    ...installSpec === undefined ? {} : { installSpec },
    ...pinned === undefined ? {} : { pinned },
    ...installed === undefined ? {} : { installed },
  }
}

/**
 * Ask the remote which commit its branch now names.
 *
 * @param {string} url The repository URL.
 * @param {string} [branch] Branch to resolve; the remote's default when omitted.
 * @param {{timeoutMs?: number, runner?: Function}} [options]
 * @returns {Promise<{sha: string} | {error: string}>}
 */
export async function remoteHead(url, branch = DEFAULT_BRANCH, options = {}) {
  const runner = options.runner ?? run
  try {
    const { stdout } = await runner('git', ['ls-remote', url, `refs/heads/${branch}`], {
      timeout: options.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
      // A stalled remote must not hold the card open; `git` is also stopped by
      // its own timeout, but the signal makes the kill prompt.
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    })
    const line = String(stdout).trim().split('\n')[0] ?? ''
    const sha = line.split('\t')[0]?.trim().toLowerCase()
    if (!/^[0-9a-f]{7,40}$/.test(sha ?? '')) return { error: 'the remote answered no commit for that branch' }
    return { sha }
  } catch (error) {
    const message = error?.killed || error?.signal !== undefined && error.signal !== null
      ? `git ls-remote timed out after ${options.timeoutMs ?? LS_REMOTE_TIMEOUT_MS}ms`
      : String(error?.stderr ?? error?.message ?? error)
    return { error: message.trim().split('\n').slice(0, 3).join(' ').slice(0, 300) }
  }
}

/**
 * The whole report: what is installed, what upstream has, and whether they differ.
 *
 * `state` is the card's whole input, and it is deliberately explicit about the
 * cases the button must stay disabled for:
 *
 *  - `local-copy` — installed from a path; there is no remote to compare with.
 *  - `unknown` — the remote could not be asked this time.
 *  - `current` / `behind` — the two states the card acts on.
 *
 * @param {string} profileDir
 * @param {{branch?: string, timeoutMs?: number, runner?: Function}} [options]
 * @returns {Promise<object>}
 */
export async function checkForUpdate(profileDir, options = {}) {
  const local = readLocalState(profileDir)
  if (local.installSpec === undefined) return { state: 'unknown', reason: 'the profile does not declare this plugin' }
  const parsed = parseInstallSpec(local.installSpec)
  if (parsed.kind !== 'git') {
    return {
      state: 'local-copy',
      reason: 'installed from a local path, so there is no remote to compare with',
      installSpec: local.installSpec,
    }
  }
  // A pin names the branch's future: compare against the branch it came from,
  // not the commit, or the remote would always answer "current".
  const branch = options.branch ?? DEFAULT_BRANCH
  const remote = await remoteHead(parsed.url, branch, options)
  if (remote.error !== undefined) {
    return {
      state: 'unknown',
      reason: remote.error,
      installSpec: local.installSpec,
      ...local.installed === undefined ? {} : { installed: local.installed },
    }
  }
  const installed = local.installed
  if (installed === undefined) {
    return { state: 'unknown', reason: 'the lockfile records no resolved commit for this package', remote: remote.sha, installSpec: local.installSpec, branch }
  }
  const behind = !sameCommit(installed, remote.sha)
  return {
    state: behind ? 'behind' : 'current',
    branch,
    installed,
    remote: remote.sha,
    installSpec: local.installSpec,
    // What a one-click update would install: the same repository, repinned to
    // the commit the remote names right now.
    ...behind ? { targetSpec: `${baseSpecOf(local.installSpec)}#${remote.sha}` } : {},
  }
}

/**
 * Whether two commit ids name the same commit.
 *
 * A lockfile can carry an abbreviated id where the manifest carried a full one,
 * so a prefix match counts — but only in that direction, and only for ids long
 * enough to be unambiguous.
 */
export function sameCommit(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (left === '' || right === '') return false
  if (left === right) return true
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  return shorter.length >= 7 && longer.startsWith(shorter)
}

/** The spec with any ref removed, so a new commit can be appended. */
export function baseSpecOf(installSpec) {
  const trimmed = String(installSpec).trim()
  const hash = trimmed.lastIndexOf('#')
  return hash === -1 ? trimmed : trimmed.slice(0, hash)
}

/**
 * The spec a one-click update should install.
 *
 * Repinning to a commit (rather than installing the branch) keeps the profile
 * reproducible and keeps the next update check meaningful: a branch spec would
 * leave `installed` and `remote` indistinguishable.
 *
 * @param {object} report A report from {@link checkForUpdate}.
 * @returns {string|undefined}
 */
export function updateSpecFrom(report) {
  if (report?.state !== 'behind' || typeof report.remote !== 'string') return undefined
  return `${baseSpecOf(report.installSpec)}#${report.remote}`
}

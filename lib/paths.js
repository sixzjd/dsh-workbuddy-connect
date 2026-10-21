/**
 * The plugin's data directory — the ONE place every file the plugin owns lives.
 *
 * Layout: `<profile>/.dsh-workbuddy-connect/` with the credential at the root
 * and the rebuildable caches under `state/`. Everything the plugin writes —
 * credentials, saved catalogs, the App-version cache, the settings file — lands
 * here, so a profile directory never collects loose `.workbuddy-*` files and
 * "clear the caches" can never be mistaken for "clear the credential".
 *
 * The profile is discovered the way the credential store always did: by asking
 * the profiles tree which one *declares* this package in its manifest. A plugin
 * is installed into a profile by link, so walking up from this module's own
 * location would miss the profile for exactly the install shape a developer
 * uses (`file:` / `link:` dependencies).
 *
 * Fallbacks, in order: `DSH_WORKBUDDY_DATA_DIR` env override → the discovered
 * profile → the Harness home (a checkout running its own tests, or a host
 * loading the plugin from outside any profile).
 *
 * @module dsh-workbuddy-connect/paths
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The per-profile directory the plugin's data folder lives under. */
export const WORKBUDDY_DATA_DIR_NAME = '.dsh-workbuddy-connect'

/** The directory inside the data dir where the rebuildable state files live. */
export const WORKBUDDY_STATE_DIR_NAME = 'state'

/** Environment override for the whole data directory. */
export const WORKBUDDY_DATA_DIR_ENV = 'DSH_WORKBUDDY_DATA_DIR'

const PROFILES_DIR_NAME = 'profiles'

/** The npm name of this package, as a profile's manifest declares it. */
const PLUGIN_PACKAGE_NAME = 'dsh-workbuddy-connect'

/** The Harness home: `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome() {
  const override = process.env.DSH_HOME
  if (override !== undefined && override.trim() !== '') return override
  return join(homedir(), '.dsh')
}

function pluginPackageRoot() {
  try {
    // `<root>/lib/paths.js` — the package root is one level up.
    return dirname(dirname(fileURLToPath(import.meta.url)))
  } catch {
    return undefined
  }
}

/**
 * Whether a profile directory declares this plugin.
 *
 * Read from the profile's manifest rather than inferred from this module's own
 * location, because DSH installs a plugin into a profile by *link*: the manifest
 * carries `"dsh-workbuddy-connect": "file:…"` or `"link:/path"`, while Node
 * resolves the module to that real path, which can lie outside `$DSH_HOME`.
 */
function profileDeclaresPlugin(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    return typeof manifest.dependencies?.[PLUGIN_PACKAGE_NAME] === 'string'
      || typeof manifest.devDependencies?.[PLUGIN_PACKAGE_NAME] === 'string'
  } catch {
    return false
  }
}

/**
 * Whether a profile's installed copy of this plugin resolves to this package.
 *
 * This is what separates two profiles that both declare the plugin — a `web` and
 * a `desktop` profile can each list it — so the data directory follows the
 * profile whose copy is actually running rather than the first one found.
 */
function profileLinksToThisPackage(profileDir) {
  const own = pluginPackageRoot()
  if (own === undefined) return false
  try {
    return realpathSync(join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME)) === realpathSync(own)
  } catch {
    return false
  }
}

/**
 * The profile directory this plugin belongs to, or undefined when none can be
 * determined.
 *
 * A single declaring profile is accepted without the link test, so a normal
 * (non-linked) install still resolves.
 */
export function discoverProfileDir() {
  const profilesRoot = join(resolveDshHome(), PROFILES_DIR_NAME)
  let entries
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(profilesRoot, entry.name)
    if (profileDeclaresPlugin(dir)) candidates.push(dir)
  }
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  return candidates.find(candidate => profileLinksToThisPackage(candidate))
}

/**
 * The plugin's data directory: `<profile>/.dsh-workbuddy-connect`.
 *
 * Falls back to the Harness home when no profile can be discovered, so the
 * plugin always has somewhere to write; `DSH_WORKBUDDY_DATA_DIR` overrides
 * either way.
 */
export function workbuddyPluginDataDir() {
  const override = process.env[WORKBUDDY_DATA_DIR_ENV]
  if (override !== undefined && override.trim() !== '') return override
  const base = discoverProfileDir() ?? resolveDshHome()
  return join(base, WORKBUDDY_DATA_DIR_NAME)
}

/**
 * The directory the rebuildable state files live in:
 * `<data dir>/state/` (saved catalogs, App-version cache).
 */
export function workbuddyStateDir() {
  return join(workbuddyPluginDataDir(), WORKBUDDY_STATE_DIR_NAME)
}

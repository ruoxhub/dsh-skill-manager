import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseFrontmatter, stripFrontmatter } from '../frontmatter.ts'
import { readZipEntries } from '../import.ts'
import type {
  GetSuitePluginDetailOptions,
  InstallSuitePluginOptions,
  InstallSuitePluginResult,
  KnownMarketplacesConfig,
  MarketplaceSourceConfig,
  SuiteCommandItem,
  SuiteMarketplaceDetail,
  SuitePluginDetail,
  SuitePluginItem,
  SuiteSkillDetailItem,
} from './types.ts'

const execFileAsync = promisify(execFile)

/** Return the path to ~/.agents/plugins/known_marketplaces.json */
export function getMarketplacesJsonPath(agentsHome: string): string {
  const standardPath = join(agentsHome, 'plugins', 'known_marketplaces.json')
  const legacyPath = join(agentsHome, 'plugins', 'marketplaces.json')
  if (!existsSync(standardPath) && existsSync(legacyPath)) {
    return legacyPath
  }
  return standardPath
}

/** Return the path to ~/.agents/plugins/marketplaces */
export function getMarketplacesDirPath(agentsHome: string): string {
  return join(agentsHome, 'plugins', 'marketplaces')
}

/** Return the user-level skills path: ~/.agents/skills */
export function getUserSkillsDirPath(agentsHome: string): string {
  return join(agentsHome, 'skills')
}

/** Return the project-level skills path: <workspace>/.agents/skills */
export function getProjectSkillsDirPath(workspacePath: string): string {
  return join(workspacePath, '.agents', 'skills')
}

/** Ensure ~/.agents/plugins and marketplaces.json are initialized */
export function ensureInitialized(agentsHome: string): KnownMarketplacesConfig {
  const configPath = getMarketplacesJsonPath(agentsHome)
  const marketplacesDir = getMarketplacesDirPath(agentsHome)

  if (!existsSync(marketplacesDir)) {
    mkdirSync(marketplacesDir, { recursive: true })
  }

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      return JSON.parse(raw) as KnownMarketplacesConfig
    } catch {
      // Corrupt file, will re-initialize
    }
  }

  const initialConfig: KnownMarketplacesConfig = {}

  // Check known_marketplaces.json from workbuddy, codebuddy, or claude to seed initial marketplaces
  const candidateConfigPaths = [
    join(homedir(), '.workbuddy', 'plugins', 'known_marketplaces.json'),
    join(homedir(), '.codebuddy', 'plugins', 'known_marketplaces.json'),
    join(homedir(), '.claude', 'plugins', 'known_marketplaces.json'),
  ]

  for (const cPath of candidateConfigPaths) {
    if (existsSync(cPath)) {
      try {
        const raw = readFileSync(cPath, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, any>

        for (const [key, item] of Object.entries(parsed)) {
          if (initialConfig[key]) continue

          const targetDir = join(marketplacesDir, key)
          const srcDir = item.installLocation

          if (srcDir && existsSync(srcDir)) {
            if (!existsSync(targetDir)) {
              try {
                symlinkSync(srcDir, targetDir, 'junction')
              } catch {
                try {
                  cpSync(srcDir, targetDir, { recursive: true })
                } catch {
                  // If symlink or copy fails, use srcDir as fallback
                }
              }
            }
          }

          initialConfig[key] = {
            name: item.manifestName || key,
            manifestName: item.manifestName || key,
            source: item.source ?? targetDir,
            type: item.type ?? 'zip',
            installLocation: targetDir,
            description: item.description ?? (item.manifest?.description || `Marketplace: ${key}`),
            isBuiltIn: !!item.isBuiltIn,
            autoUpdate: item.autoUpdate !== false,
            lastUpdated: item.lastUpdated || new Date().toISOString(),
            manifest: item.manifest,
          }
        }
      } catch {
        // Ignore parse error from external tool
      }
    }
  }

  try {
    writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), 'utf8')
  } catch {
    // Write failed
  }

  return initialConfig
}

/** Read known marketplaces */
export function listMarketplaces(agentsHome: string): MarketplaceSourceConfig[] {
  const config = ensureInitialized(agentsHome)
  return Object.entries(config).map(([key, item]) => normalizeMarketplaceEntry(key, item))
}

/**
 * Fill in the fields an external tool may omit.
 *
 * CodeBuddy, WorkBuddy and Claude write `known_marketplaces.json` with a
 * directory-shaped record keyed by marketplace name that carries
 * `manifestName` but no `name`. This panel serves the record to the browser and
 * then addresses it again by that same served name, so a missing `name` reached
 * the install route as `marketplace: undefined` and came back 400 "marketplace
 * is required" (surfaced in the panel as a failed install). The map key is
 * authoritative here, and a `manifestName` is a display alias that must resolve
 * back to that key as well.
 * @param key - the record's key in known_marketplaces.json.
 * @param item - the stored record.
 * @returns the record with `name` and `manifestName` populated.
 */
function normalizeMarketplaceEntry(key: string, item: MarketplaceSourceConfig): MarketplaceSourceConfig {
  const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name : key
  const manifestName = typeof item.manifestName === 'string' && item.manifestName.trim() !== '' ? item.manifestName : name
  return { ...item, name, manifestName }
}

/**
 * Resolve a marketplace record by the key or any alias the panel may have
 * served: the map key itself, `name`, or `manifestName`.
 * @param config - the parsed known_marketplaces.json.
 * @param name - a name the client received from this panel.
 * @returns the record and its key, or undefined when nothing matches.
 */
function findMarketplace(
  config: KnownMarketplacesConfig,
  name: string,
): { key: string; item: MarketplaceSourceConfig } | undefined {
  if (Object.hasOwn(config, name)) {
    return { key: name, item: normalizeMarketplaceEntry(name, config[name]) }
  }
  const wanted = name.trim().toLowerCase()
  for (const [key, raw] of Object.entries(config)) {
    const item = normalizeMarketplaceEntry(key, raw)
    if (item.name.toLowerCase() === wanted || item.manifestName?.toLowerCase() === wanted) {
      return { key, item }
    }
  }
  return undefined
}

/** Find marketplace.json inside a marketplace directory */
function findMarketplaceManifestPath(dir: string): string | null {
  const candidates = [
    join(dir, '.codebuddy-plugin', 'marketplace.json'),
    join(dir, '.claude-plugin', 'marketplace.json'),
    join(dir, '.cursor-plugin', 'marketplace.json'),
    join(dir, '.marketplace', 'marketplace.json'),
    join(dir, 'marketplace.json'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      return c
    }
  }
  return null
}

/**
 * Flatten a manifest plugin `source` into a display/URL string.
 *
 * Claude-family marketplaces ship `source` in two shapes: a relative path
 * string ("vendored") and an object such as
 * `{ source: 'url', url: 'https://…' }` (remote). A bare `String(source)`
 * turned the object into the literal `"[object Object]"`, which the panel then
 * showed as the plugin's source and handed to `resolve()` as a path — hence the
 * `The "paths[1]" argument must be of type string` crash. Keep the object's
 * URL/repo/path so both the detail view and install can act on it.
 * @param source - the raw manifest `source` value.
 * @returns a string for display, or undefined when there is nothing usable.
 */
export function pluginSourceString(source: unknown): string | undefined {
  if (typeof source === 'string') return source.trim() === '' ? undefined : source
  if (source === null || typeof source !== 'object') return undefined
  const record = source as { url?: unknown; repo?: unknown; path?: unknown; source?: unknown }
  for (const candidate of [record.url, record.repo, record.path]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return undefined
}

/**
 * Where a plugin's files live inside a marketplace directory, if anywhere.
 *
 * Only a string `source` names a path relative to the marketplace root. An
 * object `source` describes a remote repository the marketplace index points at
 * and does not vendor, so there is nothing local to install from.
 * @param dir - the marketplace directory.
 * @param pluginName - the plugin's manifest name.
 * @param source - the raw manifest `source` value.
 * @returns the existing plugin directory, or null when it is not vendored.
 */
function resolvePluginDir(dir: string, pluginName: string, source: unknown): string | null {
  if (typeof source === 'string' && source.trim() !== '') {
    const candidate = resolve(dir, source)
    if (existsSync(candidate)) return candidate
  }
  for (const candidate of [join(dir, 'plugins', pluginName), join(dir, pluginName)]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Check if a plugin is installed under skills dir */
function isPluginInstalled(skillsDir: string, pluginName: string, manifestSkills?: string[]): boolean {
  if (!existsSync(skillsDir)) return false

  // 1. Check exact plugin folder name
  const directPath = join(skillsDir, pluginName, 'SKILL.md')
  if (existsSync(directPath)) return true

  // 2. Check each skill declared in manifest
  if (manifestSkills && manifestSkills.length > 0) {
    for (const s of manifestSkills) {
      const skillBaseName = basename(s)
      if (existsSync(join(skillsDir, skillBaseName, 'SKILL.md'))) {
        return true
      }
    }
  }

  return false
}

/** Get detail and plugins list for a specific marketplace */
export function getMarketplaceDetail(
  agentsHome: string,
  marketplaceName: string,
  options?: {
    targetRoot?: 'user' | 'project'
    workspacePath?: string
    query?: string
  },
): SuiteMarketplaceDetail {
  const config = ensureInitialized(agentsHome)
  const found = findMarketplace(config, marketplaceName)
  const item = found?.item
  const marketplacesDir = getMarketplacesDirPath(agentsHome)
  const dir = item?.installLocation && existsSync(item.installLocation)
    ? item.installLocation
    : join(marketplacesDir, found?.key ?? marketplaceName)

  if (!existsSync(dir)) {
    // A record can outlive its directory: another tool may have written
    // known_marketplaces.json without materializing installLocation, or the
    // user deleted the folder. Answering 500 here made the whole 套件 tab look
    // broken for one stale entry, so report it as an empty, explained listing.
    return {
      name: item?.name ?? marketplaceName,
      plugins: [],
      unavailableReason: `Marketplace directory not found: ${item?.installLocation ?? dir}`,
    }
  }

  const manifestPath = findMarketplaceManifestPath(dir)
  if (!manifestPath) {
    return {
      name: item?.name ?? marketplaceName,
      plugins: [],
      unavailableReason: `Marketplace manifest (marketplace.json) not found in ${dir}`,
    }
  }

  let manifest: any
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    throw new Error(`Failed to parse marketplace manifest: ${err instanceof Error ? err.message : String(err)}`)
  }

  const rawPlugins: any[] = Array.isArray(manifest.plugins) ? manifest.plugins : []

  const targetSkillsDir = options?.targetRoot === 'project' && options?.workspacePath
    ? getProjectSkillsDirPath(options.workspacePath)
    : getUserSkillsDirPath(agentsHome)

  const q = options?.query?.trim().toLowerCase()

  const plugins: SuitePluginItem[] = []
  for (const p of rawPlugins) {
    const name = String(p.name || '')
    if (!name) continue

    const description = p.description ? String(p.description) : undefined
    const description_en = p.description_en ? String(p.description_en) : undefined

    if (q) {
      const matchName = name.toLowerCase().includes(q)
      const matchDesc = description?.toLowerCase().includes(q) ?? false
      const matchDescEn = description_en?.toLowerCase().includes(q) ?? false
      if (!matchName && !matchDesc && !matchDescEn) {
        continue
      }
    }

    const installed = isPluginInstalled(targetSkillsDir, name, Array.isArray(p.skills) ? p.skills : undefined)

    plugins.push({
      name,
      description,
      description_en,
      version: p.version ? String(p.version) : undefined,
      source: pluginSourceString(p.source),
      category: p.category ? String(p.category) : undefined,
      author: typeof p.author === 'object' ? p.author : (p.author ? { name: String(p.author) } : undefined),
      homepage: p.homepage ? String(p.homepage) : undefined,
      repository: p.repository ? String(p.repository) : undefined,
      license: p.license ? String(p.license) : undefined,
      skills: Array.isArray(p.skills) ? p.skills : undefined,
      installed,
      installedPath: installed ? join(targetSkillsDir, name) : undefined,
    })
  }

  return {
    name: item?.name ?? marketplaceName,
    description: manifest.description,
    description_en: manifest.description_en,
    plugins,
  }
}

/** Add a new marketplace source */
export async function addMarketplace(
  agentsHome: string,
  sourceInput: string,
  customName?: string,
): Promise<MarketplaceSourceConfig> {
  const trimmed = sourceInput.trim()
  if (!trimmed) {
    throw new Error('Marketplace source cannot be empty')
  }

  const config = ensureInitialized(agentsHome)
  const marketplacesDir = getMarketplacesDirPath(agentsHome)

  let name = customName?.trim()
  let repoUrl = ''
  let isLocal = false
  let localPath = ''

  // Determine source type
  if (trimmed.startsWith('./') || trimmed.startsWith('../') || isAbsolute(trimmed)) {
    isLocal = true
    localPath = resolve(trimmed)
    if (!existsSync(localPath)) {
      throw new Error(`Local directory does not exist: ${trimmed}`)
    }
    if (!name) {
      name = basename(localPath)
    }
  } else if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    // owner/repo (GitHub)
    repoUrl = `https://github.com/${trimmed}.git`
    if (!name) {
      name = trimmed.split('/')[1] || trimmed
    }
  } else if (trimmed.startsWith('git@') || trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    repoUrl = trimmed
    if (!name) {
      const match = trimmed.match(/\/([^/]+?)(?:\.git|\.zip)?$/)
      name = match ? match[1] : `marketplace-${Date.now()}`
    }
  } else {
    throw new Error(`Unsupported marketplace source format: ${trimmed}`)
  }

  name = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  const targetDir = join(marketplacesDir, name)

  // 1. Check if known_marketplaces.json in external tool already has this marketplace
  const candidateConfigPaths = [
    join(homedir(), '.workbuddy', 'plugins', 'known_marketplaces.json'),
    join(homedir(), '.codebuddy', 'plugins', 'known_marketplaces.json'),
    join(homedir(), '.claude', 'plugins', 'known_marketplaces.json'),
  ]

  let existingExternalLoc: string | undefined
  for (const cPath of candidateConfigPaths) {
    if (existsSync(cPath)) {
      try {
        const raw = JSON.parse(readFileSync(cPath, 'utf8')) as Record<string, any>
        for (const [k, item] of Object.entries(raw)) {
          const itemSource = typeof item.source === 'string' ? item.source : (item.source?.url || item.source?.path)
          if (k.toLowerCase() === name.toLowerCase() || itemSource === trimmed || itemSource === repoUrl) {
            if (item.installLocation && existsSync(item.installLocation)) {
              existingExternalLoc = item.installLocation
              break
            }
          }
        }
      } catch {
        // Ignore
      }
    }
    if (existingExternalLoc) break
  }

  if (existingExternalLoc) {
    if (!existsSync(targetDir)) {
      try {
        symlinkSync(existingExternalLoc, targetDir, 'junction')
      } catch {
        try {
          cpSync(existingExternalLoc, targetDir, { recursive: true })
        } catch {
          // Fallback to existing path
        }
      }
    }
  } else if (isLocal) {
    const manifest = findMarketplaceManifestPath(localPath)
    if (!manifest) {
      throw new Error(`No marketplace.json found in local path: ${localPath}`)
    }

    if (!existsSync(targetDir)) {
      try {
        symlinkSync(localPath, targetDir, 'junction')
      } catch {
        cpSync(localPath, targetDir, { recursive: true })
      }
    }
  } else if (repoUrl.endsWith('.zip')) {
    // Download and extract the archive in-process. Shelling out to
    // `powershell`/`unzip` made this path depend on a binary the host may not
    // have (PowerShell 7-only hosts ship `pwsh`, not `powershell`), so the add
    // route answered `spawn powershell ENOENT`. The repo already carries a
    // dependency-free reader in import.ts — reuse it.
    const response = await fetch(repoUrl)
    if (!response.ok) {
      throw new Error(`Failed to download zip from ${repoUrl}: HTTP ${response.status}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())

    mkdirSync(targetDir, { recursive: true })
    try {
      extractZipInto(buffer, targetDir)
    } catch (e) {
      throw new Error(`Failed to extract zip archive: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    // git clone
    if (existsSync(targetDir)) {
      // Pull if already exists
      try {
        await execFileAsync('git', ['-C', targetDir, 'pull'])
      } catch {
        // Continue
      }
    } else {
      await execFileAsync('git', ['clone', '--depth', '1', repoUrl, targetDir])
    }
  }

  const manifestPath = findMarketplaceManifestPath(targetDir) || (existingExternalLoc ? findMarketplaceManifestPath(existingExternalLoc) : null)
  if (!manifestPath) {
    throw new Error(`Marketplace cloned/installed, but no marketplace.json found in ${targetDir}`)
  }

  let manifestData: any = {}
  try {
    manifestData = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    // Ignore
  }

  const finalName = manifestData.name || name
  const configEntry: MarketplaceSourceConfig = {
    name: finalName,
    manifestName: finalName,
    source: {
      source: isLocal ? 'directory' : (repoUrl.endsWith('.zip') ? 'zip' : 'git'),
      path: trimmed,
      url: trimmed,
    },
    type: isLocal ? 'directory' : (repoUrl.endsWith('.zip') ? 'zip' : 'git'),
    installLocation: targetDir,
    description: manifestData.description || manifestData.metadata?.description || `Marketplace ${finalName}`,
    isBuiltIn: false,
    autoUpdate: true,
    lastUpdated: new Date().toISOString(),
  }

  config[finalName] = configEntry
  const configPath = getMarketplacesJsonPath(agentsHome)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

  return configEntry
}

/** Recursively find directories containing SKILL.md */
function findSkillDirs(baseDir: string): { name: string; dir: string }[] {
  const results: { name: string; dir: string }[] = []
  if (!existsSync(baseDir)) return results

  if (existsSync(join(baseDir, 'SKILL.md'))) {
    results.push({ name: basename(baseDir), dir: baseDir })
    return results
  }

  try {
    const entries = readdirSync(baseDir, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const sub = join(baseDir, ent.name)
        if (existsSync(join(sub, 'SKILL.md'))) {
          results.push({ name: ent.name, dir: sub })
        } else {
          // Check one more level (e.g. skills/<name>/SKILL.md)
          try {
            const subs = readdirSync(sub, { withFileTypes: true })
            for (const s of subs) {
              if (s.isDirectory() && existsSync(join(sub, s.name, 'SKILL.md'))) {
                results.push({ name: s.name, dir: join(sub, s.name) })
              }
            }
          } catch {
            // Ignore
          }
        }
      }
    }
  } catch {
    // Ignore
  }

  return results
}

/** Install a suite's plugin into ~/.agents/skills or <project>/.agents/skills */
export function installSuitePlugin(options: InstallSuitePluginOptions): InstallSuitePluginResult {
  const { agentsHome, marketplaceName, pluginName, targetRoot, workspacePath } = options
  const config = ensureInitialized(agentsHome)
  const item = findMarketplace(config, marketplaceName)?.item
  const marketplacesDir = getMarketplacesDirPath(agentsHome)
  const dir = item?.installLocation && existsSync(item.installLocation)
    ? item.installLocation
    : join(marketplacesDir, item?.name ?? marketplaceName)

  if (!existsSync(dir)) {
    throw new Error(`Marketplace directory not found: ${marketplaceName}`)
  }

  const manifestPath = findMarketplaceManifestPath(dir)
  if (!manifestPath) {
    throw new Error(`Marketplace manifest not found in ${dir}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const rawPlugins: any[] = Array.isArray(manifest.plugins) ? manifest.plugins : []
  const pluginDef = rawPlugins.find(p => p.name === pluginName)
  if (!pluginDef) {
    throw new Error(`Plugin ${pluginName} not found in marketplace ${marketplaceName}`)
  }

  // Resolve the plugin's local directory. A string `source` is a path inside
  // the marketplace; an object `source` names a remote repository the index
  // points at without vendoring it, so there is nothing local to copy.
  const pluginDir = resolvePluginDir(dir, pluginName, pluginDef.source)
  if (pluginDir === null) {
    const remote = pluginSourceString(pluginDef.source)
    throw new Error(
      remote
        ? `Plugin ${pluginName} is not available locally: marketplace ${marketplaceName} points it at ${remote}`
        : `Plugin directory not found for ${pluginName} in ${dir}`,
    )
  }

  // Determine target skills root
  const destSkillsDir = targetRoot === 'project' && workspacePath
    ? getProjectSkillsDirPath(workspacePath)
    : getUserSkillsDirPath(agentsHome)

  if (!existsSync(destSkillsDir)) {
    mkdirSync(destSkillsDir, { recursive: true })
  }

  // Find skill directories to copy
  const skillDirs = findSkillDirs(pluginDir)
  const installedSkills: string[] = []

  if (skillDirs.length > 0) {
    for (const s of skillDirs) {
      const destDir = join(destSkillsDir, s.name)
      cpSync(s.dir, destDir, { recursive: true })
      installedSkills.push(s.name)
    }
  } else {
    // If no SKILL.md found directly, copy the whole plugin folder as a skill folder
    const destDir = join(destSkillsDir, pluginName)
    cpSync(pluginDir, destDir, { recursive: true })
    installedSkills.push(pluginName)
  }

  return {
    ok: true,
    name: pluginName,
    installedSkills,
    targetDir: destSkillsDir,
  }
}

/** Remove a marketplace from marketplaces.json */
export function removeMarketplace(agentsHome: string, name: string): void {
  const config = ensureInitialized(agentsHome)
  const found = findMarketplace(config, name)
  if (found === undefined) return
  delete config[found.key]
  const configPath = getMarketplacesJsonPath(agentsHome)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}

/** Refresh/pull a marketplace source */
export async function refreshMarketplace(agentsHome: string, name: string): Promise<MarketplaceSourceConfig> {
  const config = ensureInitialized(agentsHome)
  const found = findMarketplace(config, name)
  if (found === undefined) {
    throw new Error(`Marketplace not found: ${name}`)
  }
  const item = config[found.key]

  if (item.type === 'git' && item.installLocation && existsSync(item.installLocation)) {
    try {
      await execFileAsync('git', ['-C', item.installLocation, 'pull'])
    } catch {
      // Ignore git pull error
    }
  }

  item.lastUpdated = new Date().toISOString()
  const configPath = getMarketplacesJsonPath(agentsHome)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  return normalizeMarketplaceEntry(found.key, item)
}

/**
 * Extract a downloaded marketplace archive into `targetDir`.
 *
 * Archives come from the network, so every entry is treated as hostile: an
 * absolute path or a `..` segment is refused rather than written outside the
 * marketplace directory. Release archives usually wrap their content in one
 * top-level folder (`repo-main/.claude-plugin/…`); when every entry shares such
 * a wrapper it is stripped so the manifest lands where the panel looks for it.
 * @param archive - the raw archive bytes.
 * @param targetDir - the marketplace directory to fill.
 * @throws when the archive is malformed or an entry escapes the target.
 */
function extractZipInto(archive: Buffer, targetDir: string): void {
  const entries = readZipEntries(archive).filter(entry => entry.path !== '' && !entry.path.endsWith('/'))
  if (entries.length === 0) {
    throw new Error('archive contains no files')
  }

  // Strip a shared top-level wrapper directory, if there is exactly one.
  const roots = new Set(entries.map(entry => entry.path.split('/')[0]))
  const wrapper = roots.size === 1 && entries.every(entry => entry.path.includes('/'))
    ? entries[0].path.split('/')[0]
    : null

  const root = resolve(targetDir)
  for (const entry of entries) {
    const relative = wrapper === null ? entry.path : entry.path.slice(wrapper.length + 1)
    if (relative === '') continue
    // Reject absolute paths, drive letters and any `..` segment.
    if (isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) {
      throw new Error(`archive entry escapes the target directory: ${entry.path}`)
    }
    const destination = resolve(root, relative)
    if (destination !== root && !destination.startsWith(root + sep)) {
      throw new Error(`archive entry escapes the target directory: ${entry.path}`)
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, entry.data)
  }
}

/** Simple frontmatter parser for markdown files */
export function parseMarkdownFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const block = match[1]
  const res: Record<string, string> = {}
  const lines = block.split(/\r?\n/)
  let currentKey: string | null = null
  let currentValue = ''

  for (const line of lines) {
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (keyMatch) {
      if (currentKey) res[currentKey] = currentValue.trim()
      currentKey = keyMatch[1]
      currentValue = keyMatch[2]
    } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
      currentValue += ' ' + line.trim()
    }
  }
  if (currentKey) res[currentKey] = currentValue.trim()

  for (const k of Object.keys(res)) {
    let val = res[k]
    if (val.startsWith('>')) {
      val = val.replace(/^>\s*/, '').trim()
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    res[k] = val
  }
  return res
}

/** Get detailed information for a specific suite plugin */
export function getSuitePluginDetail(opts: GetSuitePluginDetailOptions): SuitePluginDetail {
  const { marketplaceName, pluginName, agentsHome } = opts
  const mpDetail = getMarketplaceDetail(agentsHome, marketplaceName)
  const pluginItem = mpDetail.plugins.find(p => p.name === pluginName)

  const detail: SuitePluginDetail = {
    name: pluginName,
    marketplaceName,
    description: pluginItem?.description || '',
    description_en: pluginItem?.description_en,
    version: pluginItem?.version || '1.0.0',
    source: pluginItem?.source,
    category: pluginItem?.category,
    author: pluginItem?.author,
    homepage: pluginItem?.homepage,
    repository: pluginItem?.repository,
    license: pluginItem?.license,
    installed: pluginItem?.installed || false,
    commands: [],
    skillItems: [],
    mcpServers: [],
    hooks: [],
  }

  const config = ensureInitialized(agentsHome)
  const item = findMarketplace(config, marketplaceName)?.item
  const marketplacesDir = getMarketplacesDirPath(agentsHome)
  const mpDir = item?.installLocation && existsSync(item.installLocation)
    ? item.installLocation
    : join(marketplacesDir, item?.name ?? marketplaceName)

  if (!existsSync(mpDir)) {
    return detail
  }

  // Resolve plugin directory. `pluginItem.source` is already flattened to a
  // string, so an object-shaped manifest source can no longer be handed to
  // resolve() as a path.
  let pluginDir: string | null = null
  if (pluginItem?.source) {
    const candidate = resolve(mpDir, pluginItem.source)
    if (existsSync(candidate)) {
      pluginDir = candidate
    }
  }
  if (pluginDir === null) {
    for (const candidate of [
      join(mpDir, pluginName),
      join(mpDir, 'plugins', pluginName),
      join(mpDir, 'external_plugins', pluginName),
    ]) {
      if (existsSync(candidate)) {
        pluginDir = candidate
        break
      }
    }
  }

  if (pluginDir === null) {
    return detail
  }

  // 1. Scan commands
  const cmdDir = join(pluginDir, 'commands')
  if (existsSync(cmdDir)) {
    try {
      const files = readdirSync(cmdDir)
      for (const f of files) {
        if (f.endsWith('.md')) {
          const raw = readFileSync(join(cmdDir, f), 'utf8')
          const fm = parseMarkdownFrontmatter(raw)
          detail.commands?.push({
            name: '/' + f.replace(/\.md$/, ''),
            description: fm.description || '',
            argumentHint: fm['argument-hint'],
          })
        }
      }
    } catch {
      // Ignore reading error
    }
  }

  // 2. Scan skills
  const skillDirs = findSkillDirs(pluginDir)
  const seenSkillNames = new Set<string>()

  for (const s of skillDirs) {
    const skillMd = join(s.dir, 'SKILL.md')
    if (existsSync(skillMd)) {
      try {
        const raw = readFileSync(skillMd, 'utf8')
        const fm = parseFrontmatter(raw)
        const sName = fm.name || s.name
        if (!seenSkillNames.has(sName)) {
          seenSkillNames.add(sName)
          detail.skillItems?.push({
            name: sName,
            description: fm.description || '',
            whenToUse: fm.whenToUse,
            path: skillMd,
            content: stripFrontmatter(raw).trim(),
            modelInvocable: fm.disableModelInvocation !== true,
            userInvocable: fm.userInvocable !== false,
          })
        }
      } catch {
        // Ignore reading error
      }
    }
  }

  // Fallback: If no skills found in pluginDir, scan mpDir for matching skills
  if ((!detail.skillItems || detail.skillItems.length === 0) && mpDir && existsSync(mpDir) && mpDir !== pluginDir) {
    const mpSkillDirs = findSkillDirs(mpDir)
    for (const s of mpSkillDirs) {
      if (s.name.toLowerCase() === pluginName.toLowerCase() || s.dir.toLowerCase().includes(pluginName.toLowerCase())) {
        const skillMd = join(s.dir, 'SKILL.md')
        if (existsSync(skillMd)) {
          try {
            const raw = readFileSync(skillMd, 'utf8')
            const fm = parseFrontmatter(raw)
            const sName = fm.name || s.name
            if (!seenSkillNames.has(sName)) {
              seenSkillNames.add(sName)
              detail.skillItems?.push({
                name: sName,
                description: fm.description || detail.description || '',
                whenToUse: fm.whenToUse,
                path: skillMd,
                content: stripFrontmatter(raw).trim(),
                modelInvocable: fm.disableModelInvocation !== true,
                userInvocable: fm.userInvocable !== false,
              })
            }
          } catch {
            // Ignore reading error
          }
        }
      }
    }
  }

  // 3. Scan MCP and Hooks from plugin.json
  const manifestCandidates = [
    join(pluginDir, '.codebuddy-plugin', 'plugin.json'),
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    join(pluginDir, 'plugin.json'),
  ]

  for (const mPath of manifestCandidates) {
    if (existsSync(mPath)) {
      try {
        const pJson = JSON.parse(readFileSync(mPath, 'utf8'))
        if (pJson.mcpServers) {
          if (typeof pJson.mcpServers === 'string') {
            const mcpFilePath = resolve(pluginDir, pJson.mcpServers)
            if (existsSync(mcpFilePath)) {
              try {
                const mcpData = JSON.parse(readFileSync(mcpFilePath, 'utf8'))
                if (mcpData.mcpServers && typeof mcpData.mcpServers === 'object') {
                  detail.mcpServers = Object.keys(mcpData.mcpServers)
                }
              } catch {}
            }
          } else if (typeof pJson.mcpServers === 'object') {
            detail.mcpServers = Object.keys(pJson.mcpServers)
          }
        }
        if (pJson.hooks) {
          if (typeof pJson.hooks === 'string') {
            detail.hooks = [basename(pJson.hooks)]
          } else if (Array.isArray(pJson.hooks)) {
            detail.hooks = pJson.hooks.map((h: any) => (typeof h === 'string' ? basename(h) : String(h)))
          }
        }
      } catch {}
      break
    }
  }

  return detail
}


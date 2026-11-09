/**
 * The /api/dsh-skill-explorer route family: list (grouped by source), read
 * (one skill's editable fields and body), set enabled (rewrites SKILL.md
 * frontmatter), set provider enabled (records a panel-local switch for a
 * plugin-provided skill, which has no writable path), create, update (rewrites
 * an existing SKILL.md in place), delete (move the skill's folder, its central
 * row and its deployed copies to .trash), import (batch-create
 * skills from a directory or a .zip archive) and health. Every route carries
 * the shared trust fence (loopback by default; a live
 * paired-device cookie is an extra allow
 * path when remote-web-ui is loaded) plus browser same-origin markers — the
 * write routes touch real skill files, so unpaired LAN clients must not reach
 * them, and read/update only touch paths a fresh scan resolves. Import is the
 * one creation surface that reads a source outside the skill roots (see
 * import.ts): it writes only new files under the chosen root and never
 * mutates an existing one.
 */

import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isSkillExplorerAllowed } from './access.ts'
import { CentralSkillStore, getCentralDbPath, getCentralSkillsDir } from './central-store.ts'
import { buildPayload, collectSkills, findProjectRoot, isSkillName, listTrash, overwriteSkillFile, projectSkillRoot, restoreTrashEntry, skillOwnPath, trashPath, userSkillRoot, writeSkillFile, type CollectOptions, type SkillEntry } from './collect.ts'
import { parseFrontmatter, setFrontmatterField, stripFrontmatter } from './frontmatter.ts'
import { readJsonBody, writeJson } from './http.ts'
import { IMPORT_LIMITS, ImportRequestError, importSkills, type ImportSource } from './import.ts'
import { providerSkillIdentity, readProviderToggles, setProviderSkillEnabled, type ProviderSkillIdentity } from './provider-toggles.ts'
import { checkAllSkills, checkOneSkill } from './remote-resolver.ts'
import { fetchSkillDetail, searchSkills } from './skillhub/client.ts'
import { marketIdentities } from './skillhub/installed.ts'
import { AuditLog } from './audit.ts'
import { TagStore } from './tags.ts'
import {
  backupCommit,
  backupStatus,
  initBackupRepo,
  isGitRepo,
  listSnapshots,
  restoreSnapshot,
  setBackupRemote,
} from './backup.ts'
import {
  applyPreset,
  PresetStore,
  ROOT_KEYS,
  rootDir,
  type DeployMode,
  type LibraryCopy,
  type PresetWithSkills,
  type RootKey,
} from './presets.ts'
import { installMarketSkill } from './skillhub/installer.ts'
import { updateAllSkills, updateOneSkill } from './skill-updater.ts'
import {
  cancelGitPreview,
  confirmGitInstall,
  GitInstallInputError,
  previewGitInstall,
} from './git-installer.ts'

/** Route paths (client bundle mirrors these literals; tests assert both sides). */
export const ROUTES = {
  list: '/api/dsh-skill-explorer/list',
  read: '/api/dsh-skill-explorer/read',
  setEnabled: '/api/dsh-skill-explorer/set-enabled',
  setProviderEnabled: '/api/dsh-skill-explorer/set-provider-enabled',
  create: '/api/dsh-skill-explorer/create',
  update: '/api/dsh-skill-explorer/update',
  delete: '/api/dsh-skill-explorer/delete',
  import: '/api/dsh-skill-explorer/import',
  health: '/api/dsh-skill-explorer/health',
  marketSearch: '/api/dsh-skill-explorer/market/search',
  marketDetail: '/api/dsh-skill-explorer/market/detail',
  marketInstall: '/api/dsh-skill-explorer/market/install',
  gitPreview: '/api/dsh-skill-explorer/git/preview',
  gitConfirm: '/api/dsh-skill-explorer/git/confirm',
  gitCancel: '/api/dsh-skill-explorer/git/cancel',
  checkAll: '/api/dsh-skill-explorer/check-all',
  checkOne: '/api/dsh-skill-explorer/check-one',
  updateAll: '/api/dsh-skill-explorer/update-all',
  updateOne: '/api/dsh-skill-explorer/update-one',
  presetList: '/api/dsh-skill-explorer/presets',
  presetSave: '/api/dsh-skill-explorer/presets/save',
  presetDelete: '/api/dsh-skill-explorer/presets/delete',
  presetApply: '/api/dsh-skill-explorer/presets/apply',
  backupStatus: '/api/dsh-skill-explorer/backup/status',
  backupInit: '/api/dsh-skill-explorer/backup/init',
  backupCommit: '/api/dsh-skill-explorer/backup/commit',
  backupSnapshots: '/api/dsh-skill-explorer/backup/snapshots',
  backupRestore: '/api/dsh-skill-explorer/backup/restore',
  backupRemote: '/api/dsh-skill-explorer/backup/remote',
  tagList: '/api/dsh-skill-explorer/tags',
  tagSet: '/api/dsh-skill-explorer/tags/set',
  tagRename: '/api/dsh-skill-explorer/tags/rename',
  tagDelete: '/api/dsh-skill-explorer/tags/delete',
  trashList: '/api/dsh-skill-explorer/trash',
  trashRestore: '/api/dsh-skill-explorer/trash/restore',
  auditList: '/api/dsh-skill-explorer/audit',
} as const

/** Largest import request body: the archive cap plus base64 expansion and JSON. */
const IMPORT_BODY_MAX_BYTES = Math.ceil(IMPORT_LIMITS.archiveBytes / 3) * 4 + 64 * 1024

/** Base64 payload guard: rejects a body that is not a base64 string at all. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Route family dependencies (tests inject fakes). */
export interface SkillRoutesDeps {
  /** User dsh config root (~/.dsh). */
  dshHome: string
  /** User agents config root (~/.agents). */
  agentsHome: string
  /** Central skills-manager database path override (~/.agents/skills-manager/skills-manager.db). */
  centralDbPath?: string
  /** Central skills-manager skills directory override (~/.agents/skills-manager/skills). */
  centralSkillsDir?: string
  /** Central store instance override (for tests/injection). */
  centralStore?: CentralSkillStore
  /**
   * Extra custom skill roots. A resolver rather than a fixed list because the
   * host reads them off the live `skill-filesystem` loader rows, which a
   * profile reload can replace between requests.
   */
  customSkillDirs: string[] | (() => string[])
  /** ctx.skills registry (snapshot). */
  registry: CollectOptions['registry']
  /** Active session cwd list (project root base). */
  activeSessionCwds(): string[]
  /** Optional registered workspaces from DSH workspaceRegistry. */
  registeredWorkspaces?(): Array<{ root: string; name: string }>
  /** Preset store override (tests inject an in-memory one). */
  presetStore?: PresetStore
  /** Tag store override (tests inject an in-memory one). */
  tagStore?: TagStore
  /** Audit log override (tests inject an in-memory one). */
  auditLog?: AuditLog
  /** Logger. */
  logger: { warn(error: unknown): void }
}

/**
 * Whether two paths name the same location.
 *
 * The panel and the store spell the same folder differently only in case (a
 * `C:\\Users` scan against a `c:\\users` row), so compare case-insensitively on
 * Windows and exactly elsewhere.
 * @param left - first path.
 * @param right - second path.
 * @returns whether they resolve to the same location.
 */
function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => {
    const resolved = resolve(path)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

/** Default process cwd fallback (overridable in tests). */
export const DEFAULT_CWD = (): string => process.cwd()

/**
 * Narrow the request's import source.
 *
 * The body carries either a host directory the user typed or an archive the
 * browser read and base64-encoded; anything else is a client-shape error, and
 * returning the message here keeps the route's error branch a single
 * condition.
 * @param source - the raw `source` field.
 * @returns the resolved source, or a message describing what is wrong.
 */
function resolveImportSource(source: unknown): ImportSource | string {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return 'source must be { kind: "directory", path } or { kind: "archive", data }'
  }
  const record = source as Record<string, unknown>
  if (record.kind === 'directory') {
    const path = record.path
    if (typeof path !== 'string' || path.trim() === '') return 'source.path is required for a directory import'
    return { kind: 'directory', path: path.trim() }
  }
  if (record.kind === 'archive') {
    const data = record.data
    if (typeof data !== 'string' || data === '') return 'source.data is required for an archive import'
    if (!BASE64_PATTERN.test(data)) return 'source.data must be a base64 string'
    const decoded = Buffer.from(data, 'base64')
    if (decoded.length === 0) return 'source.data decoded to an empty archive'
    if (decoded.length > IMPORT_LIMITS.archiveBytes) {
      return `archive exceeds the ${IMPORT_LIMITS.archiveBytes} byte import limit`
    }
    return { kind: 'archive', data: decoded }
  }
  return 'source.kind must be "directory" or "archive"'
}

/**
 * Build every /api/dsh-skill-explorer route (exact paths).
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param deps - dshHome/agentsHome/registry/sessions.
 * @returns the route list for ctx.webServer.register.
 */
export function makeRoutes(ctx: Context, deps: SkillRoutesDeps): WebRoute[] {
  const { dshHome, agentsHome, registry, activeSessionCwds, logger } = deps

  /** Resolve the configured custom roots (degraded to [] when the resolver throws). */
  const resolveCustomSkillDirs = (): string[] => {
    try {
      const dirs = typeof deps.customSkillDirs === 'function' ? deps.customSkillDirs() : deps.customSkillDirs
      return Array.isArray(dirs) ? dirs : []
    } catch {
      return []
    }
  }

  /** Guard helper: fence + method check. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isSkillExplorerAllowed(ctx, req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  /** Active session cwd list (degraded to [] when sessions throw). */
  const safeSessionCwds = (): string[] => {
    try {
      return activeSessionCwds()
    } catch {
      return []
    }
  }

  /** Active session project roots (degraded to [] when sessions throw). */
  const sessionProjectRoots = (): string[] => {
    try {
      return safeSessionCwds().map((sessionCwd) => findProjectRoot(sessionCwd))
    } catch {
      return []
    }
  }

  /**
   * All known workspaces.
   *
   * The DSH workspace registry is the authority whenever it answers: deleting
   * a workspace removes only its registration and keeps the folder and every
   * session log, so a retained session's cwd (now under "Ungrouped") is not
   * evidence of a workspace. Merging it back resurrected deleted workspaces as
   * phantom filter entries with no workspace behind them.
   *
   * Session cwds stay the fallback for a composition without a registry (a
   * headless host, an older harness), where they are the only evidence there
   * is. The panel's own cwd is unaffected either way: buildPayload always adds
   * the active project root, so the session the user is in is still listed.
   */
  const allKnownWorkspaces = (): Array<{ root: string; name: string }> => {
    const registered: Array<{ root: string; name: string }> = []
    try {
      if (typeof deps.registeredWorkspaces === 'function') {
        const fromReg = deps.registeredWorkspaces()
        if (Array.isArray(fromReg)) {
          for (const item of fromReg) {
            if (typeof item?.root === 'string' && item.root !== '' && !registered.some((ws) => ws.root === item.root)) {
              registered.push(item)
            }
          }
        }
      }
    } catch {
      // Degrade gracefully
    }
    if (registered.length > 0) return registered

    const list: Array<{ root: string; name: string }> = []
    for (const sessionCwd of safeSessionCwds()) {
      const root = findProjectRoot(sessionCwd)
      if (!list.some((item) => item.root === root)) {
        list.push({ root, name: basename(root) || root })
      }
    }
    return list
  }

  /** Project roots across all known workspaces. */
  const allProjectRoots = (): string[] => {
    const roots = allKnownWorkspaces().map((w) => w.root)
    return roots.length > 0 ? roots : sessionProjectRoots()
  }

  /**
   * Collect options shared by list/set-enabled/set-provider-enabled/delete/
   * health handlers.
   *
   * The panel's provider-skill switches are read per request (not captured at
   * mount) so a toggle the user just made is honored by the very next list,
   * and a restart picks the stored set back up.
   */
  const collectOptions = async (cwd: string): Promise<CollectOptions> => ({
    cwd,
    projectRoots: allProjectRoots(),
    customSkillDirs: resolveCustomSkillDirs(),
    dshHome,
    agentsHome,
    centralSkillsDir: deps.centralSkillsDir,
    registry,
    providerDisabledSkills: (await readProviderToggles(dshHome)).disabled,
  })

  /**
   * The workspace the panel is showing, resolved exactly like the list route:
   * an explicit override, then the active session workspace, then the process
   * cwd. The write routes used the process cwd alone, so on a host whose cwd
   * is the DSH install directory they scanned a different project root than
   * the list route had just served and reported 409 for a skill the panel was
   * displaying.
   */
  const panelCwd = (override?: string): string =>
    (override !== undefined && override.trim() !== '' ? override : undefined)
    ?? safeSessionCwds()[0]
    ?? allKnownWorkspaces()[0]?.root
    ?? DEFAULT_CWD()

  /** Find a skill by name from a fresh collection pass (trusts scanned paths only). */
  const findSkill = async (name: string, cwd: string): Promise<SkillEntry | undefined> => {
    const { skills } = await collectSkills(await collectOptions(cwd))
    return skills.find((candidate) => candidate.name === name)
  }

  /**
   * Find a currently listed plugin-provided skill by its stable identity.
   *
   * The write route for the panel-local switch has no path to certify, so it
   * uses the identity the panel displayed: a fresh collection must resolve the
   * same (provider, name) pair to a `provider-file` row. Anything else — an
   * editable row (its own switch rewrites the file), a virtual row (no file),
   * or a skill the panel never listed — is not a target.
   */
  const findProviderSkill = async (
    identity: ProviderSkillIdentity,
    cwd: string,
  ): Promise<SkillEntry | undefined> => {
    const { skills } = await collectSkills(await collectOptions(cwd))
    return skills.find((candidate) => candidate.fileState === 'provider-file'
      && candidate.name === identity.name
      && (candidate.provider ?? '') === identity.provider)
  }

  /**
   * Remove what a central-store skill owns beyond its scanned folder: the
   * `skills-manager.db` row, the central copy, and every deployed target.
   *
   * The record is only touched when the deleted folder really is one of its
   * copies: a same-name skill from a stronger source (a project skill shadowing
   * a central one) must not take the central skill's row down with it. Each copy
   * is moved into its own `.trash` rather than unlinked, so a mistaken delete of
   * a managed skill stays recoverable.
   * @param name - the deleted skill's name.
   * @param deletedPath - the folder/file the delete already moved aside.
   * @returns the deployed copies moved aside, for the response body.
   */
  const removeCentralSkill = async (name: string, deletedPath: string): Promise<{ targets: string[] }> => {
    const store = deps.centralStore ?? new CentralSkillStore(deps.centralDbPath)
    try {
      const record = store.getSkillByName(name)
      if (record === undefined) return { targets: [] }
      const copies = [record.central_path, ...store.getSkillTargets(record.id).map((target) => target.target_path)]
      if (!copies.some((copy) => samePath(copy, deletedPath))) return { targets: [] }
      const targets: string[] = []
      for (const target of store.getSkillTargets(record.id)) {
        if (!existsSync(target.target_path)) continue
        try {
          targets.push(await trashPath(target.target_path))
        } catch (error) {
          logger.warn(error)
        }
      }
      if (existsSync(record.central_path)) {
        try {
          await trashPath(record.central_path)
        } catch (error) {
          logger.warn(error)
        }
      }
      store.deleteSkill(record.id)
      return { targets }
    } finally {
      if (deps.centralStore === undefined) store.close()
    }
  }

  /** Resolve the exact file the panel showed, rejecting stale same-name fallbacks. */
  const resolveScannedSkill = async (
    name: string,
    expectedPath: string,
    cwd: string,
    res: ServerResponse,
  ): Promise<(SkillEntry & { path: string }) | undefined> => {
    const skill = await findSkill(name, cwd)
    if (skill?.path === undefined) {
      writeJson(res, 404, { error: `skill ${name} has no editable file` })
      return undefined
    }
    if (skill.path !== expectedPath) {
      writeJson(res, 409, { error: `skill ${name} changed since the panel loaded; refresh and retry` })
      return undefined
    }
    return skill as SkillEntry & { path: string }
  }

  /**
   * The skill roots this plugin may deploy into, each with the `skill_targets`
   * tool key it records.
   *
   * These are the only writable destinations: a request naming a root outside
   * this list is an attempt to write outside the skill roots, not a preference.
   * @param cwd - explicit request cwd, if any.
   * @param fallbackCwd - the panel's resolved cwd.
   * @returns the allowed roots, user root first.
   */
  const allowedDeployRoots = (
    cwd: unknown,
    fallbackCwd: string,
  ): Array<{ key: 'user' | 'project'; root: string }> => {
    const projectBase = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : fallbackCwd
    return [
      { key: 'user', root: userSkillRoot(agentsHome) },
      { key: 'project', root: projectSkillRoot(findProjectRoot(projectBase)) },
    ]
  }

  /** The preset store, opened once per route family (tests inject their own). */
  const presetStore = (): PresetStore => {
    if (deps.presetStore !== undefined) return deps.presetStore
    return new PresetStore(deps.centralDbPath ?? getCentralDbPath())
  }

  /** The tag store, opened per request unless injected. */
  const withTagStore = <T>(use: (store: TagStore) => T): T => {
    if (deps.tagStore !== undefined) return use(deps.tagStore)
    const store = new TagStore(deps.centralDbPath ?? getCentralDbPath())
    try {
      return use(store)
    } finally {
      store.close()
    }
  }

  /** The audit log, opened per request unless injected. */
  const withAuditLog = <T>(use: (log: AuditLog) => T): T => {
    if (deps.auditLog !== undefined) return use(deps.auditLog)
    const log = new AuditLog(deps.centralDbPath ?? getCentralDbPath())
    try {
      return use(log)
    } finally {
      log.close()
    }
  }

  /**
   * The skill roots whose `.trash` the panel can browse.
   *
   * Deletes park a skill in the `.trash` of the root it lived in, so the trash
   * view has to ask the same questions the list does: every project root plus
   * the two user roots.
   */
  const trashRoots = (cwd: string): Array<{ root: string; label: string }> => {
    const roots: Array<{ root: string; label: string }> = []
    for (const projectRoot of new Set([findProjectRoot(cwd), ...allProjectRoots()])) {
      roots.push({ root: join(projectRoot, '.dsh', 'skills'), label: `${basename(projectRoot)}/.dsh/skills` })
      roots.push({ root: join(projectRoot, '.agents', 'skills'), label: `${basename(projectRoot)}/.agents/skills` })
    }
    roots.push({ root: userSkillRoot(agentsHome), label: 'user/.agents/skills' })
    roots.push({ root: join(dshHome, 'skills'), label: 'user/.dsh/skills' })
    return roots
  }

  /** The four harness roots this plugin may deploy a preset into. */
  const presetRoots = (cwd: string): Record<RootKey, string> => {
    const layout = { dshHome, agentsHome, projectRoot: findProjectRoot(cwd) }
    return Object.fromEntries(ROOT_KEYS.map((key) => [key, rootDir(key, layout)])) as Record<RootKey, string>
  }

  /** The library copy of every skill the central store tracks, by name. */
  const libraryCopies = (): Map<string, LibraryCopy> => {
    const store = deps.centralStore ?? new CentralSkillStore(deps.centralDbPath)
    try {
      const copies = new Map<string, LibraryCopy>()
      for (const record of store.getAllSkills()) {
        if (typeof record.central_path !== 'string' || record.central_path === '') continue
        copies.set(record.name, { name: record.name, dir: record.central_path })
      }
      return copies
    } finally {
      if (deps.centralStore === undefined) store.close()
    }
  }

  /**
   * Read the requested roots, rejecting anything that is not a harness root.
   * Selecting a root is a preference; naming an arbitrary path is not.
   */
  const parseRoots = (value: unknown): RootKey[] | string => {
    if (!Array.isArray(value) || value.length === 0) return [...ROOT_KEYS]
    const roots: RootKey[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || !(ROOT_KEYS as readonly string[]).includes(entry)) {
        return `roots must be a subset of: ${ROOT_KEYS.join(', ')}`
      }
      if (!roots.includes(entry as RootKey)) roots.push(entry as RootKey)
    }
    return roots
  }

  const parseMode = (value: unknown): DeployMode => (value === 'copy' ? 'copy' : 'symlink')

  /**
   * The preset a request names, or a 404 response already written.
   */
  const resolvePreset = (store: PresetStore, id: unknown, res: ServerResponse): PresetWithSkills | undefined => {
    if (typeof id !== 'string' || id.trim() === '') {
      writeJson(res, 400, { error: 'expected { id }' })
      return undefined
    }
    const preset = store.getPreset(id.trim())
    if (preset === undefined) {
      writeJson(res, 404, { error: `preset ${id} not found` })
      return undefined
    }
    return preset
  }

  /** Slugs matching what is already installed (see skillhub/installed.ts). */
  const installedMarketIdentities = async (cwd: string): Promise<Set<string>> => {
    const { skills } = await collectSkills(await collectOptions(cwd))
    return marketIdentities(skills)
  }

  /**
   * The directory backups cover: the central library the panel manages.
   *
   * Presets, tags, and deployment records live in the database beside it, so a
   * repository over this directory captures the skills themselves — the part a
   * user cannot recreate.
   */
  const backupRoot = (): string => deps.centralSkillsDir ?? getCentralSkillsDir()

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: ROUTES.list,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          // Project root base: explicit ?cwd= first, then active session
          // workspaces, process.cwd() last (panelCwd owns that order, and the
          // write routes resolve their workspace through the same helper).
          const cwd = panelCwd(queryParam(url, 'cwd'))
          const projectRoots = allProjectRoots()
          const { skills, complete } = await collectSkills(await collectOptions(cwd))
          const payload = buildPayload(skills, complete, cwd, [...new Set(projectRoots)])

          // Attach central store status and update availability
          const centralStore = new CentralSkillStore(deps.centralDbPath)
          if (centralStore.isOpen()) {
            try {
              const statusMap = centralStore.getNameToStatusMap()
              for (const group of payload.groups) {
                for (const skill of group.skills) {
                  const info = statusMap.get(skill.name)
                  if (info) {
                    skill.centralSkillId = info.id
                    skill.updateStatus = info.updateStatus
                    skill.sourceType = info.sourceType
                    skill.sourceRef = info.sourceRef ?? undefined
                    skill.sourceRefResolved = info.sourceRefResolved ?? undefined
                    skill.installedAt = info.createdAt ?? undefined
                    skill.sourceRevision = info.sourceRevision ?? undefined
                    skill.remoteRevision = info.remoteRevision ?? undefined
                    skill.lastCheckedAt = info.lastCheckedAt ?? undefined
                    skill.lastCheckError = info.lastCheckError ?? undefined
                  }
                }
              }
              payload.updateAvailableCount = centralStore.getAvailableUpdateCount()
            } finally {
              centralStore.close()
            }
          }

          writeJson(res, 200, payload)
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.read,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const name = queryParam(url, 'name')
          const path = queryParam(url, 'path')
          if (name === undefined || !isSkillName(name) || path === undefined || path.trim() === '') {
            writeJson(res, 400, { error: 'expected ?name=<kebab-case>&path=<absolute SKILL.md>' })
            return
          }
          const rawPath = path.trim()
          let filePath: string | undefined
          let fallbackDesc: string | undefined

          // Check if it matches an installed skill
          const skill = await findSkill(name, panelCwd())
          if (skill?.path) {
            if (skill.path !== rawPath) {
              writeJson(res, 409, { error: `skill ${name} changed since the panel loaded; refresh and retry` })
              return
            }
            filePath = skill.path
            fallbackDesc = skill.description
          } else if (isAbsolute(rawPath) && existsSync(rawPath) && basename(rawPath).toLowerCase() === 'skill.md') {
            // Safe read for suite / marketplace skill files under agentsHome or dshHome
            const canonicalPath = resolve(rawPath)
            const canonicalAgents = resolve(agentsHome)
            const canonicalDsh = resolve(dshHome)
            if (canonicalPath.startsWith(canonicalAgents) || canonicalPath.startsWith(canonicalDsh)) {
              filePath = canonicalPath
            }
          }

          if (!filePath) {
            writeJson(res, 404, { error: `skill ${name} has no editable file` })
            return
          }

          const raw = readFileSync(filePath, 'utf8')
          const frontmatter = parseFrontmatter(raw)
          writeJson(res, 200, {
            name,
            path: filePath,
            description: frontmatter.description ?? fallbackDesc ?? '',
            ...(frontmatter.whenToUse === undefined ? {} : { whenToUse: frontmatter.whenToUse }),
            content: stripFrontmatter(raw).trim(),
          })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.setEnabled,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 128 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const { name, path, enabled } = payload
          if (typeof name !== 'string' || !isSkillName(name) || typeof path !== 'string' || path.trim() === '' || typeof enabled !== 'boolean') {
            writeJson(res, 400, { error: 'expected { name, path, enabled }' })
            return
          }
          // The client path is only an identity claim: a fresh scan must
          // resolve the same effective skill before any file is touched.
          const skill = await resolveScannedSkill(name, path, panelCwd(), res)
          if (skill === undefined) return
          // Disabled = disable-model-invocation: true; enabled = false.
          const frontmatter = setFrontmatterField(skill.path, 'disable-model-invocation', enabled ? false : true)
          writeJson(res, 200, {
            name,
            enabled: frontmatter.disableModelInvocation !== true,
            modelInvocable: frontmatter.disableModelInvocation !== true,
            path: skill.path,
          })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.setProviderEnabled,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 8 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const { name, provider, enabled } = payload
          if (typeof name !== 'string' || typeof enabled !== 'boolean' || (provider !== undefined && typeof provider !== 'string')) {
            writeJson(res, 400, { error: 'expected { name, provider, enabled }' })
            return
          }
          const identity = providerSkillIdentity(name, provider)
          if (identity === undefined) {
            writeJson(res, 400, { error: 'name must be kebab-case (lowercase letters/digits first) and provider a short provider id' })
            return
          }
          if (enabled) {
            // Enabling only ever drops a record, so it stays allowed for a
            // skill the panel no longer lists: a plugin can be uninstalled
            // while its record is still stored, and that record must remain
            // removable. Nothing is written when it is already absent.
            await setProviderSkillEnabled(dshHome, identity, true)
            writeJson(res, 200, { ok: true, name: identity.name, provider: identity.provider, disabled: false })
            return
          }
          // Disabling creates a record the panel will honor from the next list
          // on, so it must address a skill a fresh collection still lists as
          // plugin-provided — the same "only what the panel showed" rule the
          // file write routes follow, here with the identity instead of a path.
          const skill = await findProviderSkill(identity, panelCwd())
          if (skill === undefined) {
            writeJson(res, 404, { error: `skill ${identity.name} is not a plugin-provided skill with a local file` })
            return
          }
          await setProviderSkillEnabled(dshHome, identity, false)
          writeJson(res, 200, { ok: true, name: identity.name, provider: identity.provider, disabled: true })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.create,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 128 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const { root, name, description, whenToUse, content, cwd } = payload
          if (root !== 'user' && root !== 'project') {
            writeJson(res, 400, { error: 'root must be user (~/.agents/skills) or project (project .dsh/skills)' })
            return
          }
          if (typeof cwd !== 'string' || cwd.trim() === '') {
            writeJson(res, 400, { error: 'cwd is required (the workspace shown by the panel)' })
            return
          }
          if (typeof name !== 'string' || !isSkillName(name)) {
            writeJson(res, 400, { error: 'name must be kebab-case (lowercase letters/digits first)' })
            return
          }
          if (typeof description !== 'string' || description.trim() === '') {
            writeJson(res, 400, { error: 'description is required' })
            return
          }
          if (typeof content !== 'string' || content.trim() === '') {
            writeJson(res, 400, { error: 'content is required' })
            return
          }
          if (Buffer.byteLength(content, 'utf8') > 64 * 1024) {
            writeJson(res, 400, { error: 'content exceeds 64KB limit' })
            return
          }
          const baseDir = root === 'user'
            ? userSkillRoot(agentsHome)
            : projectSkillRoot(findProjectRoot(cwd))
          const target = await writeSkillFile(baseDir, name, description, typeof whenToUse === 'string' ? whenToUse : undefined, content)
          withAuditLog((log) => log.record({ action: 'create', skillName: name, detail: target }))
          writeJson(res, 200, { ok: true, name, path: target })
        } catch (error) {
          if (error instanceof Error && /already exists/.test(error.message)) {
            writeJson(res, 409, { error: error.message })
            return
          }
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.import,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: IMPORT_BODY_MAX_BYTES, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: `invalid JSON body (or larger than ${IMPORT_BODY_MAX_BYTES} bytes)` })
            return
          }
          const payload = body as Record<string, unknown>
          const { root, cwd, source } = payload
          if (root !== 'user' && root !== 'project') {
            writeJson(res, 400, { error: 'root must be user (~/.agents/skills) or project (project .dsh/skills)' })
            return
          }
          if (typeof cwd !== 'string' || cwd.trim() === '') {
            writeJson(res, 400, { error: 'cwd is required (the workspace shown by the panel)' })
            return
          }
          const resolved = resolveImportSource(source)
          if (typeof resolved === 'string') {
            writeJson(res, 400, { error: resolved })
            return
          }
          // The conflict rule reads the catalog of the workspace the panel is
          // showing, resolved exactly like the list route (and like create):
          // a different base workspace would rank a project skill against the
          // wrong root and import a file that is immediately shadowed.
          const workspace = panelCwd(cwd)
          const targetLevel = root === 'user' ? 'user-agents' : 'project-dsh'
          const baseDir = root === 'user' ? userSkillRoot(agentsHome) : projectSkillRoot(findProjectRoot(cwd))
          const { skills } = await collectSkills(await collectOptions(workspace))
          const report = await importSkills({ baseDir, targetLevel, source: resolved, existing: skills })
          writeJson(res, 200, { ok: true, ...report })
        } catch (error) {
          // A malformed archive or an unreadable source directory is the
          // request's problem, not the host's: say so instead of a 500.
          if (error instanceof ImportRequestError) {
            writeJson(res, 400, { error: error.message })
            return
          }
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.update,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 128 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const { name, path, description, whenToUse, content } = payload
          if (typeof name !== 'string' || !isSkillName(name) || typeof path !== 'string' || path.trim() === '') {
            writeJson(res, 400, { error: 'expected { name, path, description, content }' })
            return
          }
          if (typeof description !== 'string' || description.trim() === '') {
            writeJson(res, 400, { error: 'description is required' })
            return
          }
          if (typeof content !== 'string' || content.trim() === '') {
            writeJson(res, 400, { error: 'content is required' })
            return
          }
          if (Buffer.byteLength(content, 'utf8') > 64 * 1024) {
            writeJson(res, 400, { error: 'content exceeds 64KB limit' })
            return
          }
          const skill = await resolveScannedSkill(name, path, panelCwd(), res)
          if (skill === undefined) return
          // A linked skill lives behind a symlink: rewriting it would edit a
          // file outside this skill root, so the panel must not offer it.
          if (skill.linked === true) {
            writeJson(res, 400, { error: `skill ${name} is a linked skill and cannot be edited` })
            return
          }
          // The enabled state is not part of the edit form: carry it over so an
          // edit never silently re-enables a disabled skill.
          const disabled = parseFrontmatter(readFileSync(skill.path, 'utf8')).disableModelInvocation === true
          const target = await overwriteSkillFile(skill.path, name, description.trim(), typeof whenToUse === 'string' ? whenToUse : undefined, content, disabled)
          writeJson(res, 200, { ok: true, name, path: target, disabled })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.delete,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 128 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const { name, path } = payload
          if (typeof name !== 'string' || !isSkillName(name) || typeof path !== 'string' || path.trim() === '') {
            writeJson(res, 400, { error: 'expected { name, path }' })
            return
          }
          const skill = await resolveScannedSkill(name, path, panelCwd(), res)
          if (skill === undefined) return
          // A linked skill lives behind a symlink (mount-of-intent content, not
          // created under this root). Deleting it would move the target's real
          // SKILL.md out of place, escaping this skill root — refuse deletion.
          if (skill.linked === true) {
            writeJson(res, 400, { error: `skill ${name} is a linked skill and cannot be deleted` })
            return
          }
          // Move the skill's whole directory (or lone .md file), not just its
          // SKILL.md: scripts and references the skill shipped would otherwise
          // stay behind in the live root.
          const moved = await trashPath(skillOwnPath(skill.path))
          // A central-store skill also owns a database row and deployed copies;
          // the panel lists it from those, so deleting the folder alone would
          // leave it listed with updates on offer for a skill that is gone.
          const removedCentral = await removeCentralSkill(name, skillOwnPath(skill.path))
          withAuditLog((log) => log.record({ action: 'delete', skillName: name, detail: moved }))
          writeJson(res, 200, { ok: true, name, moved, removedCentral })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const { skills } = await collectSkills(await collectOptions(panelCwd()))
          writeJson(res, 200, { ok: true, plugin: 'skill-explorer', skills: skills.length })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.marketSearch,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const q = queryParam(url, 'q') ?? queryParam(url, 'query') ?? ''
          const category = queryParam(url, 'category')
          const sortBy = queryParam(url, 'sortBy') as any
          const page = Number(queryParam(url, 'page')) || 1
          const pageSize = Number(queryParam(url, 'pageSize')) || 20
          const cwd = panelCwd(queryParam(url, 'cwd'))
          const installed = await installedMarketIdentities(cwd)

          const result = await searchSkills(q, {
            category,
            sortBy,
            page,
            pageSize,
            installed,
          })
          writeJson(res, 200, result)
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.marketDetail,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const slug = queryParam(url, 'slug')
          if (!slug || slug.trim() === '') {
            writeJson(res, 400, { error: 'slug is required' })
            return
          }
          const cwd = panelCwd(queryParam(url, 'cwd'))
          const installed = await installedMarketIdentities(cwd)

          const detail = await fetchSkillDetail(slug, { installed })
          writeJson(res, 200, detail)
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.marketInstall,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 128 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const { slug, version, targetRoot, root, cwd } = payload
          if (typeof slug !== 'string' || slug.trim() === '') {
            writeJson(res, 400, { error: 'slug is required' })
            return
          }
          const allowedRoots = allowedDeployRoots(cwd, panelCwd())
          let destinationRoot: string
          if (typeof targetRoot === 'string' && targetRoot.trim() !== '') {
            // The requested root is an identity claim, not a target: only the
            // roots this plugin itself deploys into are writable. Accepting an
            // arbitrary absolute path here would let a caller write a skill
            // anywhere the host process can reach.
            const requested = resolve(targetRoot.trim())
            const match = allowedRoots.find((candidate) => resolve(candidate.root) === requested)
            if (match === undefined) {
              writeJson(res, 400, { error: `targetRoot must be one of: ${allowedRoots.map((candidate) => candidate.root).join(', ')}` })
              return
            }
            destinationRoot = match.root
          } else if (root === 'project' || (typeof cwd === 'string' && cwd.trim() !== '')) {
            const project = allowedRoots.find((candidate) => candidate.key === 'project')
            destinationRoot = project?.root ?? projectSkillRoot(findProjectRoot(panelCwd()))
          } else {
            destinationRoot = userSkillRoot(agentsHome)
          }

          const result = await installMarketSkill(slug, {
            targetRoot: destinationRoot,
            version: typeof version === 'string' ? version : undefined,
          })

          // Register the install so it is tracked like every other central
          // skill: without a row it would show no update status and could not
          // be removed with its own bookkeeping.
          const store = deps.centralStore ?? new CentralSkillStore(deps.centralDbPath)
          try {
            if (store.isOpen()) {
              const record = store.upsertSkill({
                name: result.name,
                sourceType: 'skillhub',
                sourceRef: `skillhub:${result.slug}`,
                centralPath: result.path,
                contentHash: result.contentHash,
                updateStatus: 'up_to_date',
              })
              if (record?.id) {
                store.upsertSkillTarget({
                  skillId: record.id,
                  tool: destinationRoot === userSkillRoot(agentsHome) ? 'agents' : 'project',
                  targetPath: result.path,
                  sourceHash: result.contentHash,
                })
              }
            }
          } finally {
            if (deps.centralStore === undefined) store.close()
          }

          withAuditLog((log) => log.record({ action: 'install-market', skillName: result.name, detail: `${result.slug} -> ${result.path}` }))
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.gitPreview,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 16 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { repoUrl } = body as { repoUrl?: string }
          if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
            writeJson(res, 400, { error: 'repoUrl is required' })
            return
          }
          const preview = await previewGitInstall(repoUrl.trim())
          writeJson(res, 200, { ok: true, ...preview })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.gitConfirm,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { repoUrl, tempDir, items, target, cwd } = body as {
            repoUrl?: string
            tempDir?: string
            items?: Array<{ relPath: string; name: string }>
            target?: 'user' | 'project'
            cwd?: string
          }
          if (typeof repoUrl !== 'string' || repoUrl.trim() === '') {
            writeJson(res, 400, { error: 'repoUrl is required' })
            return
          }
          if (typeof tempDir !== 'string' || tempDir.trim() === '') {
            writeJson(res, 400, { error: 'tempDir is required' })
            return
          }
          if (!Array.isArray(items) || items.length === 0) {
            writeJson(res, 400, { error: 'items must be a non-empty array' })
            return
          }
          const result = await confirmGitInstall({
            repoUrl: repoUrl.trim(),
            tempDir: tempDir.trim(),
            items,
            target,
            cwd: panelCwd(cwd),
            agentsHome,
            dshHome,
            centralDbPath: deps.centralDbPath,
            centralSkillsDir: deps.centralSkillsDir,
          })
          for (const item of result.installed) {
            withAuditLog((log) => log.record({ action: 'install-git', skillName: item.name, detail: item.centralPath }))
          }
          writeJson(res, 200, result)
        } catch (error) {
          logger.warn(error)
          // A missing/forged preview sandbox is a client error, not a server fault.
          const status = error instanceof GitInstallInputError ? 400 : 500
          writeJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.gitCancel,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 16 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { tempDir } = body as { tempDir?: string }
          if (typeof tempDir === 'string' && tempDir.trim() !== '') {
            await cancelGitPreview(tempDir.trim())
          }
          writeJson(res, 200, { ok: true })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.checkAll,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const store = deps.centralStore ?? new CentralSkillStore(deps.centralDbPath)
        try {
          const summary = await checkAllSkills(store)
          writeJson(res, 200, { ok: true, summary })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          if (!deps.centralStore) store.close()
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.checkOne,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = (await readJsonBody(req, { maxBytes: 16 * 1024, objectOnly: true })) as { id?: string; name?: string } | null
          const idOrName = typeof body?.id === 'string' ? body.id : typeof body?.name === 'string' ? body.name : undefined
          if (!idOrName) {
            writeJson(res, 400, { ok: false, error: 'expected { id } or { name }' })
            return
          }
          const store = deps.centralStore ?? new CentralSkillStore(deps.centralDbPath)
          try {
            const skill = store.getSkillById(idOrName) ?? store.getSkillByName(idOrName)
            if (!skill) {
              writeJson(res, 404, { ok: false, error: `Skill "${idOrName}" not found in central store` })
              return
            }
            const result = await checkOneSkill(skill, store)
            writeJson(res, 200, { ok: true, result })
          } finally {
            if (!deps.centralStore) store.close()
          }
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.updateAll,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const store = deps.centralStore ?? new CentralSkillStore(deps.centralDbPath)
        try {
          const summary = await updateAllSkills(store)
          for (const entry of summary.results) {
            withAuditLog((log) => log.record({
              action: 'update',
              skillName: entry.name,
              success: entry.success,
              detail: entry.success ? `${entry.previousRevision ?? '?'} -> ${entry.newRevision ?? '?'}` : entry.error ?? null,
            }))
          }
          writeJson(res, 200, { ok: true, summary })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          if (!deps.centralStore) store.close()
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.presetList,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const store = presetStore()
          const owned = deps.presetStore !== undefined
          try {
            writeJson(res, 200, {
              ok: true,
              presets: store.listPresets(),
              activeId: store.activePresetId(),
              deployments: store.listDeployments(),
              roots: ROOT_KEYS,
            })
          } finally {
            if (!owned) store.close()
          }
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.presetSave,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 256 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const { id, name, skillNames } = payload
          if (typeof name !== 'string' || name.trim() === '') {
            writeJson(res, 400, { error: 'expected { name, skillNames }' })
            return
          }
          const members = Array.isArray(skillNames)
            ? skillNames.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
            : []
          const store = presetStore()
          const owned = deps.presetStore !== undefined
          try {
            if (typeof id === 'string' && id.trim() !== '') {
              const existing = store.getPreset(id.trim())
              if (existing === undefined) {
                writeJson(res, 404, { error: `preset ${id} not found` })
                return
              }
              store.renamePreset(existing.id, name)
              store.setMembers(existing.id, members)
              writeJson(res, 200, { ok: true, preset: store.getPreset(existing.id) })
              return
            }
            const created = store.createPreset(name, members)
            if (created === undefined) {
              writeJson(res, 409, { error: `preset "${name}" already exists` })
              return
            }
            writeJson(res, 200, { ok: true, preset: created })
          } finally {
            if (!owned) store.close()
          }
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.presetDelete,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { id } = body as Record<string, unknown>
          const store = presetStore()
          const owned = deps.presetStore !== undefined
          try {
            if (resolvePreset(store, id, res) === undefined) return
            store.deletePreset(String(id).trim())
            writeJson(res, 200, { ok: true })
          } finally {
            if (!owned) store.close()
          }
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.presetApply,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 256 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const roots = parseRoots(payload.roots)
          if (typeof roots === 'string') {
            writeJson(res, 400, { error: roots })
            return
          }
          const cwd = panelCwd(typeof payload.cwd === 'string' ? payload.cwd : undefined)
          const store = presetStore()
          const owned = deps.presetStore !== undefined
          try {
            const preset = resolvePreset(store, payload.id, res)
            if (preset === undefined) return
            const result = applyPreset(
              store,
              preset,
              libraryCopies(),
              { dirs: presetRoots(cwd), selected: roots, mode: parseMode(payload.mode) },
              { force: payload.force === true },
            )
            writeJson(res, 200, { ok: true, ...result })
          } finally {
            if (!owned) store.close()
          }
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.backupStatus,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          writeJson(res, 200, { ok: true, ...(await backupStatus(backupRoot())) })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.backupInit,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          await initBackupRepo(backupRoot())
          writeJson(res, 200, { ok: true, ...(await backupStatus(backupRoot())) })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.backupCommit,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const payload = body as Record<string, unknown>
          const message = typeof payload.message === 'string' && payload.message.trim() !== ''
            ? payload.message.trim().slice(0, 200)
            : 'backup'
          if (!isGitRepo(backupRoot())) await initBackupRepo(backupRoot())
          const result = await backupCommit(backupRoot(), message, {
            snapshot: payload.snapshot !== false,
            remote: payload.remote === true,
          })
          writeJson(res, result.error === undefined ? 200 : 502, { ok: result.error === undefined, ...result, status: await backupStatus(backupRoot()) })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.backupSnapshots,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          writeJson(res, 200, { ok: true, snapshots: await listSnapshots(backupRoot()) })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.backupRestore,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { tag } = body as Record<string, unknown>
          if (typeof tag !== 'string' || tag.trim() === '') {
            writeJson(res, 400, { error: 'expected { tag }' })
            return
          }
          const result = await restoreSnapshot(backupRoot(), tag.trim())
          withAuditLog((log) => log.record({ action: 'backup-restore', detail: `${tag} (safety ${result.safetyCommit.slice(0, 7)})` }))
          writeJson(res, 200, { ok: true, ...result })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.backupRemote,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { url } = body as Record<string, unknown>
          if (typeof url !== 'string') {
            writeJson(res, 400, { error: 'expected { url }' })
            return
          }
          if (!isGitRepo(backupRoot())) await initBackupRepo(backupRoot())
          try {
            await setBackupRemote(backupRoot(), url)
          } catch (error) {
            // A rejected URL is a client error, not a server fault.
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            return
          }
          writeJson(res, 200, { ok: true, ...(await backupStatus(backupRoot())) })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.tagList,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const tags = withTagStore((store) => ({
            tags: store.listTags(),
            bySkill: Object.fromEntries(store.allTags()),
          }))
          writeJson(res, 200, { ok: true, ...tags })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.tagSet,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { name, tags } = body as Record<string, unknown>
          if (typeof name !== 'string' || !isSkillName(name)) {
            writeJson(res, 400, { error: 'expected { name: <kebab-case>, tags: string[] }' })
            return
          }
          if (!Array.isArray(tags)) {
            writeJson(res, 400, { error: 'tags must be an array of strings' })
            return
          }
          // The tag names a skill the panel is showing, so a fresh scan has to
          // resolve it: a tag on a skill that is not there would be invisible
          // and unremovable through the UI.
          const { skills } = await collectSkills(await collectOptions(panelCwd()))
          const known = skills.some((skill) => skill.name === name)
          if (!known) {
            writeJson(res, 404, { error: `skill ${name} is not in the library` })
            return
          }
          const stored = withTagStore((store) => store.setTags(name, tags.filter((tag): tag is string => typeof tag === 'string')))
          withAuditLog((log) => log.record({ action: 'toggle', skillName: name, detail: `tags: ${stored.join(', ')}` }))
          writeJson(res, 200, { ok: true, name, tags: stored })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.tagRename,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { from, to } = body as Record<string, unknown>
          if (typeof from !== 'string' || typeof to !== 'string') {
            writeJson(res, 400, { error: 'expected { from, to }' })
            return
          }
          const renamed = withTagStore((store) => store.renameTag(from, to))
          if (!renamed) {
            writeJson(res, 400, { error: 'rename needs two different, non-empty tags' })
            return
          }
          writeJson(res, 200, { ok: true, tags: withTagStore((store) => store.listTags()) })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.tagDelete,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { tag } = body as Record<string, unknown>
          if (typeof tag !== 'string' || tag.trim() === '') {
            writeJson(res, 400, { error: 'expected { tag }' })
            return
          }
          withTagStore((store) => store.deleteTag(tag))
          writeJson(res, 200, { ok: true, tags: withTagStore((store) => store.listTags()) })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.trashList,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const cwd = panelCwd(queryParam(url, 'cwd'))
          const roots = trashRoots(cwd)
          const entries: Array<{ root: string; label: string; path: string; name: string; deletedAt: number; isDirectory: boolean }> = []
          for (const item of roots) {
            for (const entry of await listTrash(item.root)) entries.push({ root: item.root, label: item.label, ...entry })
          }
          entries.sort((left, right) => right.deletedAt - left.deletedAt)
          writeJson(res, 200, { ok: true, entries })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.trashRestore,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, { maxBytes: 64 * 1024, objectOnly: true })
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          const { path } = body as Record<string, unknown>
          if (typeof path !== 'string' || path.trim() === '') {
            writeJson(res, 400, { error: 'expected { path }' })
            return
          }
          // The path is a trash entry, so it must sit in a `.trash` directory
          // the panel itself reads. Anything else is not a restore target.
          const requested = resolve(path.trim())
          const url = new URL(req.url ?? '/', 'http://x')
          const roots = trashRoots(panelCwd(queryParam(url, 'cwd')))
          const owner = roots.find((item) => resolve(item.root, '.trash') === dirname(requested))
          if (owner === undefined) {
            writeJson(res, 400, { error: 'path is not inside a skill root trash' })
            return
          }
          const entries = await listTrash(owner.root)
          const entry = entries.find((candidate) => resolve(candidate.path) === requested)
          if (entry === undefined) {
            writeJson(res, 404, { error: 'trash entry not found' })
            return
          }
          let restored: string
          try {
            restored = await restoreTrashEntry(entry, owner.root)
          } catch (error) {
            // A name that is live again is a conflict the user resolves, not a
            // server fault.
            writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
            return
          }
          withAuditLog((log) => log.record({ action: 'restore', skillName: entry.name, detail: restored }))
          writeJson(res, 200, { ok: true, restored, name: entry.name })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.auditList,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const limit = Number(queryParam(url, 'limit')) || 200
          const skillName = queryParam(url, 'name')
          const entries = withAuditLog((log) => log.list(limit, skillName))
          writeJson(res, 200, { ok: true, entries })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.updateOne,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = (await readJsonBody(req, { maxBytes: 16 * 1024, objectOnly: true })) as { id?: string; name?: string } | null
          const idOrName = typeof body?.id === 'string' ? body.id : typeof body?.name === 'string' ? body.name : undefined
          if (!idOrName) {
            writeJson(res, 400, { ok: false, error: 'expected { id } or { name }' })
            return
          }
          const store = deps.centralStore ?? new CentralSkillStore(deps.centralDbPath)
          try {
            const skill = store.getSkillById(idOrName) ?? store.getSkillByName(idOrName)
            if (!skill) {
              writeJson(res, 404, { ok: false, error: `Skill "${idOrName}" not found in central store` })
              return
            }
            const result = await updateOneSkill(skill, store)
            withAuditLog((log) => log.record({
              action: 'update',
              skillName: result.name,
              success: result.success,
              detail: result.success ? `${result.previousRevision ?? '?'} -> ${result.newRevision ?? '?'}` : result.error ?? null,
            }))
            writeJson(res, 200, { ok: true, result })
          } finally {
            if (!deps.centralStore) store.close()
          }
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
  return routes
}

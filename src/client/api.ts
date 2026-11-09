/**
 * Skill center API client (browser half). Talks to the host route family over
 * same-origin fetch; the host enforces the trust fence on its side.
 */

/**
 * Route paths mirrored from the host (src/routes.ts ROUTES).
 *
 * DOCUMENT-RELATIVE on purpose (no leading slash): the harness serves the GUI
 * with `<base href="./">`, so a sub-path deployment (`/dsh/dsh/`) is the
 * entry directory. A root-absolute `/api/...` escapes that prefix and the
 * request never reaches the plugin's route (issue #1707); the official client
 * posts its own routes the same way (`api/session.list`).
 */
const API = {
  list: 'api/dsh-skill-explorer/list',
  read: 'api/dsh-skill-explorer/read',
  setEnabled: 'api/dsh-skill-explorer/set-enabled',
  setProviderEnabled: 'api/dsh-skill-explorer/set-provider-enabled',
  create: 'api/dsh-skill-explorer/create',
  update: 'api/dsh-skill-explorer/update',
  delete: 'api/dsh-skill-explorer/delete',
  import: 'api/dsh-skill-explorer/import',
  marketSearch: 'api/dsh-skill-explorer/market/search',
  marketDetail: 'api/dsh-skill-explorer/market/detail',
  marketInstall: 'api/dsh-skill-explorer/market/install',
  gitPreview: 'api/dsh-skill-explorer/git/preview',
  gitConfirm: 'api/dsh-skill-explorer/git/confirm',
  gitCancel: 'api/dsh-skill-explorer/git/cancel',
  backupStatus: 'api/dsh-skill-explorer/backup/status',
  backupInit: 'api/dsh-skill-explorer/backup/init',
  backupCommit: 'api/dsh-skill-explorer/backup/commit',
  backupSnapshots: 'api/dsh-skill-explorer/backup/snapshots',
  backupRestore: 'api/dsh-skill-explorer/backup/restore',
  backupRemote: 'api/dsh-skill-explorer/backup/remote',
  tagList: 'api/dsh-skill-explorer/tags',
  tagSet: 'api/dsh-skill-explorer/tags/set',
  tagRename: 'api/dsh-skill-explorer/tags/rename',
  tagDelete: 'api/dsh-skill-explorer/tags/delete',
  trashList: 'api/dsh-skill-explorer/trash',
  trashRestore: 'api/dsh-skill-explorer/trash/restore',
  auditList: 'api/dsh-skill-explorer/audit',
  presetList: 'api/dsh-skill-explorer/presets',
  presetSave: 'api/dsh-skill-explorer/presets/save',
  presetDelete: 'api/dsh-skill-explorer/presets/delete',
  presetApply: 'api/dsh-skill-explorer/presets/apply',
  checkAll: 'api/dsh-skill-explorer/check-all',
  checkOne: 'api/dsh-skill-explorer/check-one',
  updateAll: 'api/dsh-skill-explorer/update-all',
  updateOne: 'api/dsh-skill-explorer/update-one',
} as const

/**
 * What backs a skill locally (host-classified).
 *
 * - `editable`: a filesystem scan resolved the SKILL.md; `path` is writable.
 * - `provider-file`: a plugin provider reports a real instruction file the
 *   panel's scan did not resolve. The file exists, but the write routes do not
 *   trust this path, so the row offers no file controls — it does carry the
 *   enable switch, which the host records in the panel's own store (#1854).
 * - `virtual`: no instruction file exists; "no local file" is accurate.
 */
export type SkillFileState = 'editable' | 'provider-file' | 'virtual'

/** One skill entry as served by the host. */
export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  provider?: string
  level: string
  path?: string
  /** What backs this skill locally (see SkillFileState). */
  fileState: SkillFileState
  /** True for skills discovered through a symlink entry (deletion not allowed). */
  linked?: boolean
  modelInvocable: boolean
  userInvocable: boolean
  /** Project workspace root path this skill belongs to. */
  workspaceRoot?: string
  /** Display name of the workspace directory. */
  workspaceName?: string
  /** True when the skill belongs to the primary active session workspace. */
  isActiveWorkspace?: boolean
  /** Central store skill ID if tracked */
  centralSkillId?: string
  /** Update status from CentralSkillStore */
  updateStatus?: 'up_to_date' | 'update_available' | 'error' | 'unknown'
  /** Source type if tracked (e.g. 'git', 'skillssh', 'local') */
  sourceType?: string
  /** Source repo url if tracked, exactly as the user typed it */
  sourceRef?: string
  /** Normalized clone URL of that repo (identity of the imported repository) */
  sourceRefResolved?: string
  /** Epoch ms the skill was first written into the central store */
  installedAt?: number
  /** Current revision SHA */
  sourceRevision?: string
  /** Remote revision SHA if checked */
  remoteRevision?: string
  /** Last checked timestamp */
  lastCheckedAt?: number | null
  /** Last check error message */
  lastCheckError?: string | null
}

/** Group payload served by the host. */
export interface GroupPayload {
  key: string
  title: string
  hint: string
  skills: SkillEntry[]
  workspaceRoot?: string
  workspaceName?: string
}

/** Workspace item descriptor. */
export interface WorkspaceItem {
  root: string
  name: string
  active: boolean
}

/** List payload served by the host. */
export interface ListPayload {
  cwd: string
  projectRoots: string[]
  complete: boolean
  groups: GroupPayload[]
  workspaces?: WorkspaceItem[]
  updateAvailableCount?: number
  lastCheckedAt?: number | null
}

/** One tag with the number of skills carrying it. */
export interface TagCountEntry {
  tag: string
  count: number
}

/** GET /tags. */
export interface TagListPayload {
  ok: true
  tags: TagCountEntry[]
  bySkill: Record<string, string[]>
}

/** One trashed skill entry. */
export interface TrashEntryPayload {
  root: string
  label: string
  path: string
  name: string
  deletedAt: number
  isDirectory: boolean
}

/** GET /trash. */
export interface TrashListPayload {
  ok: true
  entries: TrashEntryPayload[]
}

/** One audit-log entry. */
export interface AuditEntryPayload {
  id: number
  ts: number
  action: string
  skill_name: string | null
  success: boolean
  detail: string | null
}

/** GET /audit. */
export interface AuditListPayload {
  ok: true
  entries: AuditEntryPayload[]
}

/** Library backup repository state. */
export interface BackupStatusPayload {
  ok: boolean
  isRepo: boolean
  remoteUrl: string | null
  hasChanges: boolean
  changedSkillCount: number
  ahead: number
  behind: number
  lastCommit: string | null
  lastCommitTime: string | null
  health: 'healthy' | 'no_repo' | 'no_remote' | 'no_upstream' | 'diverged' | 'error'
  error?: string
}

/** One restorable snapshot. */
export interface BackupSnapshotEntry {
  tag: string
  commit: string
  message: string
  timestamp: number
}

/** Result of a backup commit, including a failed push. */
export interface BackupCommitPayload {
  ok: boolean
  committed: boolean
  commit: string | null
  tag: string | null
  pushed: boolean
  error?: string
  status: BackupStatusPayload
}

/** A harness skill root a preset can deploy into. */
export type SkillRootKey = 'user-dsh' | 'user-agents' | 'project-dsh' | 'project-agents'

/** One stored preset. */
export interface SkillPresetRecord {
  id: string
  name: string
  description: string | null
  sort_order: number
  created_at: number
  updated_at: number
  skillNames: string[]
}

/** One recorded deployment of a library skill into a harness root. */
export interface DeploymentEntry {
  id: string
  preset_id: string | null
  skill_name: string
  root_key: SkillRootKey
  target_path: string
  mode: 'symlink' | 'copy'
  source_path: string
  source_hash: string | null
  deployed_at: number
}

/** GET /presets. */
export interface PresetListPayload {
  ok: true
  presets: SkillPresetRecord[]
  activeId: string | null
  deployments: DeploymentEntry[]
  roots: SkillRootKey[]
}

/** One (skill, root) outcome from an activation. */
export interface PresetOutcome {
  skillName: string
  rootKey: SkillRootKey
  targetPath: string
  deployed: boolean
  removed: boolean
  reason?: 'no-library-copy' | 'foreign-target' | 'local-changes' | 'not-in-preset'
}

/** POST /presets/apply. */
export interface ApplyPresetPayload {
  ok: true
  presetId: string
  deployed: PresetOutcome[]
  removed: PresetOutcome[]
}

/** Why a candidate the import read was not created. */
export type ImportSkipReason =
  | 'invalid-frontmatter'
  | 'invalid-name'
  | 'too-large'
  | 'duplicate'
  | 'exists'
  | 'shadowed'

/** One candidate's result from an import run. */
export interface ImportOutcome {
  /** The skill name, or the origin when no valid name was found. */
  name: string
  /** The archive entry or file path it was read from. */
  origin: string
  status: 'imported' | 'skipped'
  /** Why it was skipped (absent when imported). */
  reason?: ImportSkipReason
  /** The written SKILL.md path (imported only). */
  path?: string
}

/** The report an import run returns. */
export interface ImportReport {
  ok: true
  /** The source level the files were written into. */
  level: string
  /** One outcome per candidate, in source order. */
  outcomes: ImportOutcome[]
  imported: number
  skipped: number
}

/** Where the skills to import come from. */
export type ImportSourceRequest =
  | { kind: 'directory'; path: string }
  | { kind: 'archive'; data: string }

/** One thrown API error with the host-provided message. */
export class ApiError extends Error {}

/** Skill center API client. */
export class SkillApi {
  /** Fetch the grouped skill list. */
  async list(cwd?: string): Promise<ListPayload> {
    const url = typeof cwd === 'string' && cwd.trim() !== ''
      ? `${API.list}?cwd=${encodeURIComponent(cwd)}`
      : API.list
    return this.request<ListPayload>(url)
  }

  /** Enable or disable a skill (rewrites disable-model-invocation). */
  async setEnabled(name: string, path: string, enabled: boolean): Promise<{ name: string; enabled: boolean; modelInvocable: boolean; path?: string }> {
    return this.request(API.setEnabled, { method: 'POST', body: { name, path, enabled } })
  }

  /**
   * Switch a plugin-provided skill off/on in this panel.
   *
   * There is no path to certify: the row's file belongs to the provider and
   * sits outside the roots this panel scans, so the host records the
   * (provider, name) pair in the panel's own store instead of rewriting a
   * SKILL.md the panel does not own. The host answers with the stored state;
   * the invocable view itself comes from the next list call.
   */
  async setProviderEnabled(name: string, provider: string | undefined, enabled: boolean): Promise<{ ok: true; name: string; provider: string; disabled: boolean }> {
    return this.request(API.setProviderEnabled, { method: 'POST', body: { name, provider, enabled } })
  }

  /** Create a skill file under the user or project root. */
  async create(payload: { root: 'user' | 'project'; name: string; description: string; whenToUse?: string; content: string; cwd: string }): Promise<{ ok: true; name: string; path: string }> {
    return this.request(API.create, { method: 'POST', body: payload })
  }

  /** One skill's editable fields and body, resolved from the panel's path. */
  async read(name: string, path: string): Promise<{ name: string; path: string; description: string; whenToUse?: string; content: string }> {
    return this.request(`${API.read}?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`)
  }

  /** Rewrite an existing skill file in place (name and location unchanged). */
  async update(payload: { name: string; path: string; description: string; whenToUse?: string; content: string }): Promise<{ ok: true; name: string; path: string; disabled: boolean }> {
    return this.request(API.update, { method: 'POST', body: payload })
  }

  /**
   * Batch-create skills from a host directory or a .zip archive.
   *
   * The directory form names a path on the host (the route is loopback-only,
   * so the browser and the host are the same machine by construction); the
   * archive form carries the bytes the browser read, base64-encoded, so the
   * user can pick a file through the ordinary file dialog. Both only ever
   * create new files under the chosen root; a name that already resolves at
   * the same or a stronger source comes back skipped with its reason.
   */
  async importSkills(payload: { root: 'user' | 'project'; cwd: string; source: ImportSourceRequest }): Promise<ImportReport> {
    return this.request(API.import, { method: 'POST', body: payload })
  }

  /**
   * Delete a skill.
   *
   * The host moves the skill's whole folder (or lone `.md` file) into that
   * root's `.trash`, and, when the skill is tracked by the central store, its
   * database row and deployed copies as well.
   */
  async remove(name: string, path: string): Promise<{ ok: true; name: string; moved: string; removedCentral: { targets: string[] } }> {
    return this.request(API.delete, { method: 'POST', body: { name, path } })
  }

  /**
   * List every stored preset together with the deployment records.
   *
   * Presets live in the shared database rather than this browser's storage, so
   * they survive a cache clear and a different machine's browser.
   */
  async listPresets(): Promise<PresetListPayload> {
    return this.request(API.presetList)
  }

  /** Create (no id) or update (with id) a preset's name and members. */
  async savePreset(payload: { id?: string; name: string; skillNames: string[] }): Promise<{ ok: true; preset: SkillPresetRecord }> {
    return this.request(API.presetSave, { method: 'POST', body: payload })
  }

  /** Delete a preset. Its deployments stay on disk but stop being tracked. */
  async deletePreset(id: string): Promise<{ ok: true }> {
    return this.request(API.presetDelete, { method: 'POST', body: { id } })
  }

  /**
   * Activate a preset: deploy its members into the selected harness roots and
   * take back the deployments of skills it does not own.
   */
  async applyPreset(payload: { id: string; roots?: SkillRootKey[]; mode?: 'symlink' | 'copy'; cwd?: string; force?: boolean }): Promise<ApplyPresetPayload> {
    return this.request(API.presetApply, { method: 'POST', body: payload })
  }

  /** Every tag with its skill count, plus each skill's tags. */
  async listTags(): Promise<TagListPayload> {
    return this.request(API.tagList)
  }

  /** Replace one skill's tags. */
  async setTags(name: string, tags: string[]): Promise<{ ok: true; name: string; tags: string[] }> {
    return this.request(API.tagSet, { method: 'POST', body: { name, tags } })
  }

  /** Rename a tag everywhere it appears. */
  async renameTag(from: string, to: string): Promise<{ ok: true; tags: TagCountEntry[] }> {
    return this.request(API.tagRename, { method: 'POST', body: { from, to } })
  }

  /** Remove a tag from every skill. */
  async deleteTag(tag: string): Promise<{ ok: true; tags: TagCountEntry[] }> {
    return this.request(API.tagDelete, { method: 'POST', body: { tag } })
  }

  /** Trashed skills across every root the panel scans. */
  async listTrash(cwd?: string): Promise<TrashListPayload> {
    const query = cwd === undefined ? '' : `?cwd=${encodeURIComponent(cwd)}`
    return this.request(`${API.trashList}${query}`)
  }

  /** Restore one trashed skill into its own root. */
  async restoreTrash(path: string, cwd?: string): Promise<{ ok: true; restored: string; name: string }> {
    return this.request(API.trashRestore, { method: 'POST', body: { path, cwd } })
  }

  /** The newest audit entries, optionally for one skill. */
  async listAudit(params: { limit?: number; name?: string } = {}): Promise<AuditListPayload> {
    const sp = new URLSearchParams()
    if (params.limit !== undefined) sp.set('limit', String(params.limit))
    if (params.name !== undefined) sp.set('name', params.name)
    const qs = sp.toString()
    return this.request(qs === '' ? API.auditList : `${API.auditList}?${qs}`)
  }

  /** Read the library backup repository's state. */
  async backupStatus(): Promise<BackupStatusPayload> {
    return this.request(API.backupStatus)
  }

  /** Create the library's git repository if it does not exist yet. */
  async initBackup(): Promise<BackupStatusPayload> {
    return this.request(API.backupInit, { method: 'POST', body: {} })
  }

  /**
   * Commit the library and, by default, tag it as a restorable snapshot.
   * `remote: true` pushes afterwards; a rejected push comes back as `ok: false`
   * with the reason rather than throwing, because the commit still landed.
   */
  async backupCommit(payload: { message?: string; snapshot?: boolean; remote?: boolean }): Promise<BackupCommitPayload> {
    return this.request(API.backupCommit, { method: 'POST', body: payload })
  }

  /** Every restorable snapshot tag, newest first. */
  async backupSnapshots(): Promise<{ ok: true; snapshots: BackupSnapshotEntry[] }> {
    return this.request(API.backupSnapshots)
  }

  /** Restore a snapshot; the pre-restore state is committed first. */
  async restoreBackup(tag: string): Promise<{ ok: true; safetyCommit: string }> {
    return this.request(API.backupRestore, { method: 'POST', body: { tag } })
  }

  /** Point the library repository at a remote. */
  async setBackupRemote(url: string): Promise<BackupStatusPayload> {
    return this.request(API.backupRemote, { method: 'POST', body: { url } })
  }

  /** Search SkillHub market skills. */
  async searchMarket(params: { q?: string; category?: string; sortBy?: string; page?: number; pageSize?: number; cwd?: string } = {}): Promise<any> {
    const sp = new URLSearchParams()
    if (params.q) sp.set('q', params.q)
    if (params.category) sp.set('category', params.category)
    if (params.sortBy) sp.set('sortBy', params.sortBy)
    if (params.page) sp.set('page', String(params.page))
    if (params.pageSize) sp.set('pageSize', String(params.pageSize))
    if (params.cwd) sp.set('cwd', params.cwd)
    const qs = sp.toString()
    return this.request(qs ? `${API.marketSearch}?${qs}` : API.marketSearch)
  }

  /** Get detail for a SkillHub market skill. */
  async getMarketDetail(slug: string, cwd?: string): Promise<any> {
    const sp = new URLSearchParams({ slug })
    if (cwd) sp.set('cwd', cwd)
    return this.request(`${API.marketDetail}?${sp.toString()}`)
  }

  /** Install a skill from SkillHub market. */
  async installMarket(payload: { slug: string; version?: string; targetRoot?: string; root?: 'user' | 'project'; cwd?: string }): Promise<{ ok: true; slug: string; name: string; version: string; path: string; files: number }> {
    return this.request(API.marketInstall, { method: 'POST', body: payload })
  }

  /** Preview skills in a remote Git repository */
  async previewGitInstall(repoUrl: string): Promise<{
    ok: true
    tempDir: string
    skills: Array<{ relPath: string; name: string; description: string | null }>
  }> {
    return this.request(API.gitPreview, { method: 'POST', body: { repoUrl } })
  }

  /** Confirm and install selected skills from a previewed Git repository */
  async confirmGitInstall(payload: {
    repoUrl: string
    tempDir: string
    items: Array<{ relPath: string; name: string }>
    target?: 'user' | 'project'
    cwd?: string
  }): Promise<{
    ok: true
    installed: Array<{ name: string; installedPath: string; centralPath: string }>
  }> {
    return this.request(API.gitConfirm, { method: 'POST', body: payload })
  }

  /** Cancel a git preview session and clean up the temporary directory */
  async cancelGitPreview(tempDir: string): Promise<{ ok: true }> {
    return this.request(API.gitCancel, { method: 'POST', body: { tempDir } })
  }

  /** Check all skills for updates against upstream Git repositories */
  async checkAll(): Promise<{ ok: true; summary: any }> {
    return this.request(API.checkAll, { method: 'POST' })
  }

  /** Check updates for a single skill */
  async checkOne(idOrName: string): Promise<{ ok: true; result: any }> {
    return this.request(API.checkOne, { method: 'POST', body: { name: idOrName } })
  }

  /** Update all skills that have available updates */
  async updateAll(): Promise<{ ok: true; summary: any }> {
    return this.request(API.updateAll, { method: 'POST' })
  }

  /** Update a single skill */
  async updateOne(idOrName: string): Promise<{ ok: true; result: any }> {
    return this.request(API.updateOne, { method: 'POST', body: { name: idOrName } })
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers = options.body === undefined
      ? new Headers()
      : new Headers({ 'content-type': 'application/json' })
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    if (!response.ok) {
      const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${response.status}`
      throw new ApiError(message)
    }
    return body as T
  }
}

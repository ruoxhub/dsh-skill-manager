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
  suitesMarketplaces: 'api/dsh-skill-explorer/suites/marketplaces',
  suitesAddMarketplace: 'api/dsh-skill-explorer/suites/marketplaces/add',
  suitesRemoveMarketplace: 'api/dsh-skill-explorer/suites/marketplaces/remove',
  suitesRefreshMarketplace: 'api/dsh-skill-explorer/suites/marketplaces/refresh',
  suitesPlugins: 'api/dsh-skill-explorer/suites/plugins',
  suitesPluginDetail: 'api/dsh-skill-explorer/suites/plugin-detail',
  suitesInstall: 'api/dsh-skill-explorer/suites/install',
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

  /** Delete a skill (moves it into .trash). */
  async remove(name: string, path: string): Promise<{ ok: true; name: string; moved: string }> {
    return this.request(API.delete, { method: 'POST', body: { name, path } })
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

  /** List suite marketplaces */
  async listSuiteMarketplaces(): Promise<{ ok: true; marketplaces: any[] }> {
    return this.request(API.suitesMarketplaces, { method: 'GET' })
  }

  /** Add a suite marketplace source */
  async addSuiteMarketplace(payload: { source: string; name?: string }): Promise<{ ok: true; marketplace: any }> {
    return this.request(API.suitesAddMarketplace, { method: 'POST', body: payload })
  }

  /** Remove a suite marketplace */
  async removeSuiteMarketplace(payload: { name: string }): Promise<{ ok: true }> {
    return this.request(API.suitesRemoveMarketplace, { method: 'POST', body: payload })
  }

  /** Refresh a suite marketplace */
  async refreshSuiteMarketplace(payload: { name: string }): Promise<{ ok: true; marketplace: any }> {
    return this.request(API.suitesRefreshMarketplace, { method: 'POST', body: payload })
  }

  /** Get suite plugins from a marketplace */
  async getSuitePlugins(payload: { marketplace: string; query?: string; root?: 'user' | 'project'; cwd?: string }): Promise<{ ok: true; name: string; description?: string; description_en?: string; plugins: any[] }> {
    const sp = new URLSearchParams()
    sp.set('marketplace', payload.marketplace)
    if (payload.query) sp.set('q', payload.query)
    if (payload.root) sp.set('root', payload.root)
    if (payload.cwd) sp.set('cwd', payload.cwd)
    return this.request(`${API.suitesPlugins}?${sp.toString()}`, { method: 'GET' })
  }

  /** Get suite plugin detail */
  async getSuitePluginDetail(payload: { marketplace: string; plugin: string }): Promise<{ ok: true } & import('../suites/types.ts').SuitePluginDetail> {
    const sp = new URLSearchParams()
    sp.set('marketplace', payload.marketplace)
    sp.set('plugin', payload.plugin)
    return this.request(`${API.suitesPluginDetail}?${sp.toString()}`, { method: 'GET' })
  }

  /** Install a suite plugin */
  async installSuitePlugin(payload: { marketplace: string; plugin: string; root?: 'user' | 'project'; cwd?: string }): Promise<{ ok: true; name: string; installedSkills: string[]; targetDir: string }> {
    return this.request(API.suitesInstall, { method: 'POST', body: payload })
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

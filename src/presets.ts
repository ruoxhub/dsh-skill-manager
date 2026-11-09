/**
 * Presets: named groups of library skills that are deployed together.
 *
 * A preset is the difference between "this skill is in the library" and "the
 * model can see this skill". The central store (`~/.agents/skills-manager/skills`) is
 * a library the plugin scans, not a root DeepSeek Harness loads from, so a
 * library skill stays inert until a copy or link of it exists in one of the
 * harness's own skill roots. Activating a preset is what performs that move:
 * members are deployed into the selected roots, and copies this plugin put
 * there for a previous preset are taken back out.
 *
 * Ownership is recorded, not inferred: a deployment row names the target path
 * and the content it was written from, and only a target that still matches
 * that record is ever removed or replaced. A directory the user (or another
 * tool) created is left alone and reported as refused — deleting someone else's
 * skill because it happens to share a name is the one mistake this cannot undo.
 *
 * The tables are prefixed `dsh_` because this database is shared with the
 * skills-manager desktop app: reusing its `scenarios` tables would mean writing
 * a schema it cannot read, and its own migrations would overwrite ours.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { discardPrevious, stagedPathFor, swapSkillDir } from './atomic.ts'
import { hashSkillDir } from './content-hash.ts'

/** A harness skill root a preset can deploy into. */
export type RootKey = 'user-dsh' | 'user-agents' | 'project-dsh' | 'project-agents'

/** How a deployment is materialized in its target root. */
export type DeployMode = 'symlink' | 'copy'

/** Every root key, in display order. */
export const ROOT_KEYS: readonly RootKey[] = ['user-dsh', 'user-agents', 'project-dsh', 'project-agents']

/** One preset as stored. */
export interface PresetRecord {
  id: string
  name: string
  description: string | null
  sort_order: number
  created_at: number
  updated_at: number
}

/** A preset together with its member names, in order. */
export interface PresetWithSkills extends PresetRecord {
  skillNames: string[]
}

/** One recorded deployment of a library skill into a harness root. */
export interface DeploymentRecord {
  id: string
  preset_id: string | null
  skill_name: string
  root_key: RootKey
  target_path: string
  mode: DeployMode
  source_path: string
  source_hash: string | null
  deployed_at: number
}

/** Schema for the preset tables, kept separate from the shared upstream tables. */
export const PRESET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dsh_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dsh_preset_skills (
    preset_id TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (preset_id, skill_name)
);
CREATE TABLE IF NOT EXISTS dsh_preset_state (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS dsh_preset_deployments (
    id TEXT PRIMARY KEY,
    preset_id TEXT,
    skill_name TEXT NOT NULL,
    root_key TEXT NOT NULL,
    target_path TEXT NOT NULL,
    mode TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_hash TEXT,
    deployed_at INTEGER NOT NULL,
    UNIQUE(skill_name, root_key)
);
`

/** Longest preset name the panel accepts, so a stored name stays readable. */
const MAX_NAME_LENGTH = 60

/**
 * Persistent preset store, in the shared skills-manager database.
 *
 * Opening a database that does not exist is a no-op rather than an error: a
 * machine without the desktop app still gets the panel, it just has no presets
 * until the table is created here.
 */
export class PresetStore {
  private db: DatabaseSync | null = null
  readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.init()
  }

  private init(): void {
    if (this.dbPath === ':memory:') {
      this.db = new DatabaseSync(':memory:')
      this.db.exec(PRESET_SCHEMA_SQL)
      return
    }
    try {
      if (!existsSync(this.dbPath)) mkdirSync(dirname(this.dbPath), { recursive: true })
      this.db = new DatabaseSync(this.dbPath)
      this.db.exec(PRESET_SCHEMA_SQL)
    } catch {
      this.db = null
    }
  }

  /** Whether the store has a usable database handle. */
  isOpen(): boolean {
    return this.db !== null
  }

  /** Close the handle (a shared instance must outlive individual requests). */
  close(): void {
    try {
      this.db?.close()
    } catch {
      // ignore
    }
    this.db = null
  }

  /** Every preset, in display order, with its members. */
  listPresets(): PresetWithSkills[] {
    if (this.db === null) return []
    try {
      const presets = this.db.prepare('SELECT * FROM dsh_presets ORDER BY sort_order ASC, name ASC').all() as unknown as PresetRecord[]
      return presets.map((preset) => ({ ...preset, skillNames: this.memberNames(preset.id) }))
    } catch {
      return []
    }
  }

  /** The member names of one preset, in stored order. */
  memberNames(presetId: string): string[] {
    if (this.db === null) return []
    try {
      const rows = this.db
        .prepare('SELECT skill_name FROM dsh_preset_skills WHERE preset_id = ? ORDER BY sort_order ASC, skill_name ASC')
        .all(presetId) as unknown as Array<{ skill_name: string }>
      return rows.map((row) => row.skill_name)
    } catch {
      return []
    }
  }

  /** One preset by id, with members. */
  getPreset(presetId: string): PresetWithSkills | undefined {
    if (this.db === null) return undefined
    try {
      const row = this.db.prepare('SELECT * FROM dsh_presets WHERE id = ?').get(presetId) as unknown as PresetRecord | undefined
      if (row === undefined) return undefined
      return { ...row, skillNames: this.memberNames(presetId) }
    } catch {
      return undefined
    }
  }

  /** The id of the preset last activated, or null. */
  activePresetId(): string | null {
    if (this.db === null) return null
    try {
      const row = this.db.prepare("SELECT value FROM dsh_preset_state WHERE key = 'active'").get() as unknown as { value: string } | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }

  /** Record which preset is active (null clears it). */
  setActivePreset(presetId: string | null): void {
    if (this.db === null) return
    try {
      if (presetId === null) {
        this.db.prepare("DELETE FROM dsh_preset_state WHERE key = 'active'").run()
        return
      }
      this.db.prepare("INSERT INTO dsh_preset_state (key, value) VALUES ('active', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(presetId)
    } catch {
      // ignore
    }
  }

  /**
   * Create a preset.
   * @param name - display name, trimmed and bounded.
   * @param skillNames - initial members.
   * @returns the created preset, or undefined when the store is closed or the
   * name is taken.
   */
  createPreset(name: string, skillNames: readonly string[] = []): PresetWithSkills | undefined {
    if (this.db === null) return undefined
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
    if (trimmed === '') return undefined
    const now = Date.now()
    const id = randomUUID()
    try {
      this.db.prepare('INSERT INTO dsh_presets (id, name, description, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)')
        .run(id, trimmed, now, now, now)
      this.setMembers(id, skillNames)
      return this.getPreset(id)
    } catch {
      return undefined
    }
  }

  /** Replace a preset's members wholesale. */
  setMembers(presetId: string, skillNames: readonly string[]): void {
    if (this.db === null) return
    try {
      this.db.prepare('DELETE FROM dsh_preset_skills WHERE preset_id = ?').run(presetId)
      const seen = new Set<string>()
      let order = 0
      for (const name of skillNames) {
        if (typeof name !== 'string' || name === '' || seen.has(name)) continue
        seen.add(name)
        this.db.prepare('INSERT INTO dsh_preset_skills (preset_id, skill_name, sort_order) VALUES (?, ?, ?)').run(presetId, name, order++)
      }
      this.db.prepare('UPDATE dsh_presets SET updated_at = ? WHERE id = ?').run(Date.now(), presetId)
    } catch {
      // ignore
    }
  }

  /** Rename a preset. */
  renamePreset(presetId: string, name: string): boolean {
    if (this.db === null) return false
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
    if (trimmed === '') return false
    try {
      this.db.prepare('UPDATE dsh_presets SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, Date.now(), presetId)
      return true
    } catch {
      return false
    }
  }

  /** Delete a preset and its member list (its deployments stay recorded). */
  deletePreset(presetId: string): void {
    if (this.db === null) return
    try {
      this.db.prepare('DELETE FROM dsh_preset_skills WHERE preset_id = ?').run(presetId)
      this.db.prepare('DELETE FROM dsh_presets WHERE id = ?').run(presetId)
      if (this.activePresetId() === presetId) this.setActivePreset(null)
    } catch {
      // ignore
    }
  }

  /** Every recorded deployment. */
  listDeployments(): DeploymentRecord[] {
    if (this.db === null) return []
    try {
      return this.db.prepare('SELECT * FROM dsh_preset_deployments').all() as unknown as DeploymentRecord[]
    } catch {
      return []
    }
  }

  /** Deployments recorded for one skill. */
  deploymentsFor(skillName: string): DeploymentRecord[] {
    if (this.db === null) return []
    try {
      return this.db.prepare('SELECT * FROM dsh_preset_deployments WHERE skill_name = ?').all(skillName) as unknown as DeploymentRecord[]
    } catch {
      return []
    }
  }

  /** Record (or refresh) one deployment. */
  recordDeployment(record: Omit<DeploymentRecord, 'id' | 'deployed_at'>): void {
    if (this.db === null) return
    try {
      this.db.prepare(`
        INSERT INTO dsh_preset_deployments
          (id, preset_id, skill_name, root_key, target_path, mode, source_path, source_hash, deployed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(skill_name, root_key) DO UPDATE SET
          preset_id = excluded.preset_id,
          target_path = excluded.target_path,
          mode = excluded.mode,
          source_path = excluded.source_path,
          source_hash = excluded.source_hash,
          deployed_at = excluded.deployed_at
      `).run(
        randomUUID(),
        record.preset_id,
        record.skill_name,
        record.root_key,
        record.target_path,
        record.mode,
        record.source_path,
        record.source_hash,
        Date.now(),
      )
    } catch {
      // ignore
    }
  }

  /** Drop the record for one (skill, root) pair. */
  forgetDeployment(skillName: string, rootKey: RootKey): void {
    if (this.db === null) return
    try {
      this.db.prepare('DELETE FROM dsh_preset_deployments WHERE skill_name = ? AND root_key = ?').run(skillName, rootKey)
    } catch {
      // ignore
    }
  }
}

/** A skill the preset wants deployed, resolved to what is on disk. */
export interface DeploySource {
  name: string
  /** Directory holding the skill's files. */
  dir: string
}

/** Why one (skill, root) pair produced no deployment. */
export type DeploySkipReason =
  | 'no-library-copy'
  | 'foreign-target'
  | 'local-changes'
  | 'not-in-preset'

/** The outcome of deploying one skill into one root. */
export interface DeployOutcome {
  skillName: string
  rootKey: RootKey
  deployed: boolean
  removed: boolean
  reason?: DeploySkipReason
  targetPath: string
}

/** What activating a preset did. */
export interface ApplyPresetResult {
  presetId: string
  deployed: DeployOutcome[]
  /** Deployments taken back out because the skill is not a member. */
  removed: DeployOutcome[]
}

/** Resolve the absolute directory for one root key. */
export function rootDir(key: RootKey, roots: { dshHome: string; agentsHome: string; projectRoot: string }): string {
  switch (key) {
    case 'user-dsh': return join(roots.dshHome, 'skills')
    case 'user-agents': return join(roots.agentsHome, 'skills')
    case 'project-dsh': return join(roots.projectRoot, '.dsh', 'skills')
    case 'project-agents': return join(roots.projectRoot, '.agents', 'skills')
  }
}

/** How a target path currently looks. */
type TargetState = 'absent' | 'our-link' | 'our-copy' | 'our-copy-edited' | 'foreign'

/**
 * Classify a target path against the deployment we recorded for it.
 *
 * A recorded link counts only while it still points where we pointed it; a
 * recorded copy only while its content still matches what we wrote. Anything
 * else at that path belongs to someone else, and is never touched.
 * @param targetPath - deployed path to inspect.
 * @param record - our deployment record, if any.
 * @param sourceDir - the library directory it should mirror.
 * @returns the classification.
 */
function classifyTarget(targetPath: string, record: DeploymentRecord | undefined, sourceDir: string): TargetState {
  let stat
  try {
    stat = lstatSync(targetPath)
  } catch {
    return 'absent'
  }
  if (record === undefined) return 'foreign'
  if (stat.isSymbolicLink()) {
    try {
      if (resolve(readlinkSync(targetPath)) === resolve(sourceDir)) return 'our-link'
    } catch {
      // unreadable link: treat as foreign
    }
    return 'foreign'
  }
  if (!stat.isDirectory()) return 'foreign'
  if (record.mode !== 'copy') return 'foreign'
  const current = hashSkillDir(targetPath)
  if (current === null) return 'foreign'
  // Same mode and provenance, different bytes: ours, but the user edited it.
  return current === record.source_hash ? 'our-copy' : 'our-copy-edited'
}

/**
 * Deploy one library skill into one root.
 *
 * A link is preferred: it keeps one copy of the content, so editing the library
 * skill updates every root that shows it. A copy is the fallback for a platform
 * (or a user preference) where a link will not do, and is protected from being
 * silently overwritten once the user edits it.
 *
 * @param skillName - the library skill this deployment mirrors.
 * @param sourceDir - library directory holding the skill's files.
 * @param targetPath - absolute deployment path.
 * @param rootKey - which root this deployment belongs to.
 * @param mode - link or copy.
 * @param record - the existing deployment record for this pair, if any.
 * @param options.force - replace a copy the user edited.
 * @returns the outcome plus the content hash recorded with it.
 */
export function deploySkill(
  skillName: string,
  sourceDir: string,
  targetPath: string,
  rootKey: RootKey,
  mode: DeployMode,
  record: DeploymentRecord | undefined,
  options: { force?: boolean } = {},
): DeployOutcome & { contentHash: string | null } {
  const base = { skillName, rootKey, targetPath }
  if (!existsSync(sourceDir)) {
    return { ...base, deployed: false, removed: false, reason: 'no-library-copy', contentHash: null }
  }
  const state = classifyTarget(targetPath, record, sourceDir)
  if (state === 'our-copy-edited' && options.force !== true) {
    // Our copy, but its content no longer matches what we wrote: the user
    // edited it, and re-deploying would throw that away.
    return { ...base, deployed: false, removed: false, reason: 'local-changes', contentHash: null }
  }
  if (state === 'foreign' && options.force !== true) {
    // Something that is not our deployment sits at the target path. Report it
    // and leave it alone: deleting someone else's skill is unrecoverable.
    return { ...base, deployed: false, removed: false, reason: 'foreign-target', contentHash: null }
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  if (mode === 'symlink') {
    if (state !== 'absent') rmSync(targetPath, { recursive: true, force: true })
    try {
      symlinkSync(resolve(sourceDir), targetPath, process.platform === 'win32' ? 'junction' : 'dir')
      return { ...base, deployed: true, removed: false, contentHash: hashSkillDir(sourceDir) }
    } catch {
      // Windows without the privilege for a link: fall back to a copy so the
      // skill still reaches the harness, and record what actually happened.
    }
  }

  const staged = stagedPathFor(targetPath)
  rmSync(staged, { recursive: true, force: true })
  try {
    cpSync(sourceDir, staged, { recursive: true })
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    throw error
  }
  discardPrevious(swapSkillDir(staged, targetPath))
  return { ...base, deployed: true, removed: false, contentHash: hashSkillDir(targetPath) }
}

/**
 * Take a recorded deployment back out, but only while it is still ours.
 * @param targetPath - deployed path.
 * @param record - our record for it.
 * @param sourceDir - library directory it mirrored.
 * @returns whether anything was removed.
 */
export function undeploySkill(targetPath: string, record: DeploymentRecord, sourceDir: string): boolean {
  // A link points at the library, so "still ours" means the link target still
  // matches; for a copy it means the content still matches what we wrote.
  const state = classifyTarget(targetPath, record, sourceDir)
  // An edited copy is left in place: the user's changes outrank a preset
  // switch, and forgetting the record would hide the copy from future passes.
  if (state !== 'our-link' && state !== 'our-copy') return false
  rmSync(targetPath, { recursive: true, force: true })
  return true
}

/** Where a preset deployment maps its members onto the filesystem. */
export interface RootLayout {
  /** Absolute directory for each root key. */
  dirs: Record<RootKey, string>
  /** Root keys the activation should write into. */
  selected: readonly RootKey[]
  /** Link or copy. */
  mode: DeployMode
}

/** A library skill resolved to the directory that holds its files. */
export interface LibraryCopy {
  name: string
  dir: string
}

/**
 * Activate a preset: deploy its members into the selected roots and take back
 * the copies a previous activation left that this preset does not own.
 *
 * The removal half is what makes "activate" mean something: switching from a
 * ten-skill preset to a three-skill one has to actually take seven skills out of
 * the model's view, or the activation only ever adds. Only deployments this
 * plugin recorded are candidates for removal, and each is re-checked against
 * its record first, so a skill the user deployed another way is untouched.
 *
 * @param store - preset store holding members and deployment records.
 * @param preset - the preset being activated.
 * @param library - library copies by skill name.
 * @param layout - root directories, selected roots, and link/copy mode.
 * @param options.force - replace a copy the user edited (reported as
 * `local-changes` otherwise).
 * @returns what was deployed and what was taken back.
 */
export function applyPreset(
  store: PresetStore,
  preset: PresetWithSkills,
  library: ReadonlyMap<string, LibraryCopy>,
  layout: RootLayout,
  options: { force?: boolean } = {},
): ApplyPresetResult {
  const deployed: DeployOutcome[] = []
  const removed: DeployOutcome[] = []
  const wanted = new Set(preset.skillNames)

  // 1. Deploy every member into every selected root.
  for (const name of preset.skillNames) {
    const copy = library.get(name)
    for (const rootKey of layout.selected) {
      const targetPath = join(layout.dirs[rootKey], name)
      const existing = store.deploymentsFor(name).find((record) => record.root_key === rootKey)
      if (copy === undefined) {
        deployed.push({ skillName: name, rootKey, targetPath, deployed: false, removed: false, reason: 'no-library-copy' })
        continue
      }
      const outcome = deploySkill(name, copy.dir, targetPath, rootKey, layout.mode, existing, options)
      deployed.push(outcome)
      if (outcome.deployed) {
        store.recordDeployment({
          preset_id: preset.id,
          skill_name: name,
          root_key: rootKey,
          target_path: targetPath,
          mode: layout.mode,
          source_path: copy.dir,
          source_hash: outcome.contentHash,
        })
      }
    }
  }

  // 2. Take back what a previous activation deployed but this preset does not own.
  for (const record of store.listDeployments()) {
    if (wanted.has(record.skill_name)) continue
    if (!layout.selected.includes(record.root_key)) continue
    const copy = library.get(record.skill_name)
    const didRemove = undeploySkill(record.target_path, record, copy?.dir ?? record.source_path)
    removed.push({
      skillName: record.skill_name,
      rootKey: record.root_key,
      targetPath: record.target_path,
      deployed: false,
      removed: didRemove,
      ...(didRemove ? {} : { reason: 'foreign-target' as const }),
    })
    if (didRemove) store.forgetDeployment(record.skill_name, record.root_key)
  }

  store.setActivePreset(preset.id)
  return { presetId: preset.id, deployed, removed }
}

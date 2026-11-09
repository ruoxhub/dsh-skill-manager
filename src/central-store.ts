/**
 * Central skill store adapter for `~/.agents/skills-manager`.
 *
 * Interacts directly with the official SQLite database `skills-manager.db`
 * using Node.js 22+ native `node:sqlite` (DatabaseSync), ensuring full two-way
 * state parity with the desktop skills-manager application.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Representation of a skill row in skills-manager.db */
export interface CentralSkillRecord {
  id: string
  name: string
  description: string | null
  source_type: string
  source_ref: string | null
  source_ref_resolved: string | null
  source_subpath: string | null
  source_branch: string | null
  source_revision: string | null
  remote_revision: string | null
  central_path: string
  content_hash: string | null
  enabled: number
  created_at: number
  updated_at: number
  status: string
  update_status: 'up_to_date' | 'update_available' | 'error' | 'unknown'
  last_checked_at: number | null
  last_check_error: string | null
}

/** Representation of a deployed skill target in skill_targets table */
export interface CentralSkillTarget {
  id: string
  skill_id: string
  tool: string
  target_path: string
  mode: string
  status: string
  synced_at: number | null
  last_error: string | null
  source_hash: string | null
}

/** Resolve the root directory for skills-manager (~/.agents/skills-manager). */
export function getCentralManagerRoot(): string {
  const envOverride = process.env.SKILLS_MANAGER_ROOT?.trim()
  if (envOverride) return envOverride
  return join(homedir(), '.agents', 'skills-manager')
}

/** Resolve the path to skills-manager.db */
export function getCentralDbPath(root = getCentralManagerRoot()): string {
  return join(root, 'skills-manager.db')
}

/** Resolve the path to the central skills folder (~/.agents/skills-manager/skills) */
export function getCentralSkillsDir(root = getCentralManagerRoot()): string {
  return join(root, 'skills')
}

/** Database initialization SQL if creating a fresh database in test environments */
export const INIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    source_type TEXT NOT NULL,
    source_ref TEXT,
    source_ref_resolved TEXT,
    source_subpath TEXT,
    source_branch TEXT,
    source_revision TEXT,
    remote_revision TEXT,
    central_path TEXT NOT NULL UNIQUE,
    content_hash TEXT,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER,
    status TEXT DEFAULT 'ok',
    update_status TEXT DEFAULT 'unknown',
    last_checked_at INTEGER,
    last_check_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

CREATE TABLE IF NOT EXISTS skill_targets (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    target_path TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT DEFAULT 'ok',
    synced_at INTEGER,
    last_error TEXT,
    source_hash TEXT,
    UNIQUE(skill_id, tool)
);
`

export class CentralSkillStore {
  private db: DatabaseSync | null = null
  readonly dbPath: string

  constructor(dbPath?: string, autoInit = false) {
    this.dbPath = dbPath ?? getCentralDbPath()
    this.init(autoInit)
  }

  private init(autoInit: boolean): void {
    if (this.dbPath === ':memory:') {
      this.db = new DatabaseSync(':memory:')
      this.db.exec(INIT_SCHEMA_SQL)
      return
    }

    const exists = existsSync(this.dbPath)
    if (!exists && !autoInit) {
      // Do not create database file unnecessarily if skills-manager is not initialized
      return
    }

    try {
      if (!exists && autoInit) {
        mkdirSync(dirname(this.dbPath), { recursive: true })
      }
      this.db = new DatabaseSync(this.dbPath)
      if (autoInit) {
        this.db.exec(INIT_SCHEMA_SQL)
      }
    } catch (err) {
      this.db = null
    }
  }

  isOpen(): boolean {
    return this.db !== null
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        // ignore
      }
      this.db = null
    }
  }

  /**
   * Return all skills tracked in the central repository.
   */
  getAllSkills(): CentralSkillRecord[] {
    if (!this.db) return []
    try {
      const stmt = this.db.prepare('SELECT * FROM skills ORDER BY name ASC')
      return stmt.all() as unknown as CentralSkillRecord[]
    } catch {
      return []
    }
  }

  /**
   * Find a tracked skill by name.
   */
  getSkillByName(name: string): CentralSkillRecord | undefined {
    if (!this.db) return undefined
    try {
      const stmt = this.db.prepare('SELECT * FROM skills WHERE name = ? LIMIT 1')
      const row = stmt.get(name)
      return row ? (row as unknown as CentralSkillRecord) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Find a tracked skill by ID.
   */
  getSkillById(id: string): CentralSkillRecord | undefined {
    if (!this.db) return undefined
    try {
      const stmt = this.db.prepare('SELECT * FROM skills WHERE id = ? LIMIT 1')
      const row = stmt.get(id)
      return row ? (row as unknown as CentralSkillRecord) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Query targets (deployed agent copies) for a skill.
   */
  getSkillTargets(skillId: string): CentralSkillTarget[] {
    if (!this.db) return []
    try {
      const stmt = this.db.prepare('SELECT * FROM skill_targets WHERE skill_id = ?')
      return stmt.all(skillId) as unknown as CentralSkillTarget[]
    } catch {
      return []
    }
  }

  /**
   * Update the check state of a single skill.
   */
  updateCheckState(
    id: string,
    remoteRevision: string | null,
    updateStatus: string,
    error?: string | null,
    timestamp = Date.now(),
  ): void {
    if (!this.db) return
    try {
      const stmt = this.db.prepare(`
        UPDATE skills
        SET remote_revision = ?,
            update_status = ?,
            last_checked_at = ?,
            last_check_error = ?
        WHERE id = ?
      `)
      stmt.run(remoteRevision, updateStatus, timestamp, error ?? null, id)
    } catch (err) {
      // ignore
    }
  }

  /**
   * Mark a skill as successfully updated to a new revision.
   */
  markSkillUpdated(
    id: string,
    newRevision: string,
    contentHash?: string | null,
    timestamp = Date.now(),
  ): void {
    if (!this.db) return
    try {
      const stmt = this.db.prepare(`
        UPDATE skills
        SET source_revision = ?,
            remote_revision = ?,
            update_status = 'up_to_date',
            content_hash = COALESCE(?, content_hash),
            last_checked_at = ?,
            last_check_error = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      stmt.run(newRevision, newRevision, contentHash ?? null, timestamp, timestamp, id)
    } catch (err) {
      // ignore
    }
  }

  /**
   * Get the count of skills with update_available status.
   */
  getAvailableUpdateCount(): number {
    if (!this.db) return 0
    try {
      const stmt = this.db.prepare(
        "SELECT count(*) as cnt FROM skills WHERE update_status = 'update_available'",
      )
      const res = stmt.get() as { cnt: number } | undefined
      return res?.cnt ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Upsert a skill in the central store (insert if new, update if name matches).
   */
  upsertSkill(input: {
    name: string
    description?: string | null
    sourceType: string
    sourceRef?: string | null
    sourceRefResolved?: string | null
    sourceSubpath?: string | null
    sourceBranch?: string | null
    sourceRevision?: string | null
    remoteRevision?: string | null
    centralPath: string
    contentHash?: string | null
    updateStatus?: 'up_to_date' | 'update_available' | 'error' | 'unknown'
  }): CentralSkillRecord | undefined {
    if (!this.db) return undefined
    const now = Date.now()
    const existing = this.getSkillByName(input.name)
    try {
      if (existing) {
        const stmt = this.db.prepare(`
          UPDATE skills
          SET description = COALESCE(?, description),
              source_type = ?,
              source_ref = ?,
              source_ref_resolved = ?,
              source_subpath = ?,
              source_branch = ?,
              source_revision = ?,
              remote_revision = ?,
              central_path = ?,
              content_hash = COALESCE(?, content_hash),
              update_status = ?,
              updated_at = ?
          WHERE id = ?
        `)
        stmt.run(
          input.description ?? null,
          input.sourceType,
          input.sourceRef ?? null,
          input.sourceRefResolved ?? null,
          input.sourceSubpath ?? null,
          input.sourceBranch ?? null,
          input.sourceRevision ?? null,
          input.remoteRevision ?? null,
          input.centralPath,
          input.contentHash ?? null,
          input.updateStatus ?? 'up_to_date',
          now,
          existing.id,
        )
        return this.getSkillById(existing.id)
      } else {
        const id = randomUUID()
        const stmt = this.db.prepare(`
          INSERT INTO skills (
            id, name, description, source_type, source_ref, source_ref_resolved,
            source_subpath, source_branch, source_revision, remote_revision,
            central_path, content_hash, enabled, created_at, updated_at,
            status, update_status, last_checked_at, last_check_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?, NULL)
        `)
        stmt.run(
          id,
          input.name,
          input.description ?? null,
          input.sourceType,
          input.sourceRef ?? null,
          input.sourceRefResolved ?? null,
          input.sourceSubpath ?? null,
          input.sourceBranch ?? null,
          input.sourceRevision ?? null,
          input.remoteRevision ?? null,
          input.centralPath,
          input.contentHash ?? null,
          now,
          now,
          input.updateStatus ?? 'up_to_date',
          now,
        )
        return this.getSkillById(id)
      }
    } catch {
      return undefined
    }
  }

  /**
   * Upsert a deployed target record in skill_targets.
   */
  upsertSkillTarget(input: {
    skillId: string
    tool: string
    targetPath: string
    mode?: string
    /** Content hash of the central copy this target was deployed from. */
    sourceHash?: string | null
  }): void {
    if (!this.db) return
    const now = Date.now()
    try {
      const stmt = this.db.prepare(`
        INSERT INTO skill_targets (
          id, skill_id, tool, target_path, mode, status, synced_at, source_hash
        ) VALUES (?, ?, ?, ?, ?, 'ok', ?, ?)
        ON CONFLICT(skill_id, tool) DO UPDATE SET
          target_path = excluded.target_path,
          mode = excluded.mode,
          synced_at = excluded.synced_at,
          source_hash = COALESCE(excluded.source_hash, skill_targets.source_hash),
          status = 'ok'
      `)
      stmt.run(
        randomUUID(),
        input.skillId,
        input.tool,
        input.targetPath,
        input.mode ?? 'copy',
        now,
        input.sourceHash ?? null,
      )
    } catch {
      // ignore
    }
  }

  /**
   * Drop a tracked skill and its deployed-target rows.
   *
   * The row is what makes the central copy reappear in the panel and keeps it
   * in the update sweep; leaving it behind after the directory is gone leaves
   * the panel offering updates for a skill that no longer exists.
   * @param id - central skill id.
   */
  deleteSkill(id: string): void {
    if (!this.db) return
    try {
      this.db.prepare('DELETE FROM skill_targets WHERE skill_id = ?').run(id)
      this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
    } catch {
      // ignore
    }
  }

  /**
   * Return a Map of skill name -> update info for fast lookup during scan merging.
   */
  getNameToStatusMap(): Map<
    string,
    {
      id: string
      updateStatus: 'up_to_date' | 'update_available' | 'error' | 'unknown'
      sourceType: string
      sourceRef: string | null
      /** Normalized clone URL; identity of the imported repository. */
      sourceRefResolved: string | null
      sourceRevision: string | null
      remoteRevision: string | null
      /** Epoch ms the skill row was first created (its install time). */
      createdAt: number | null
      lastCheckedAt: number | null
      lastCheckError: string | null
    }
  > {
    const map = new Map()
    if (!this.db) return map
    for (const skill of this.getAllSkills()) {
      map.set(skill.name, {
        id: skill.id,
        updateStatus: skill.update_status,
        sourceType: skill.source_type,
        sourceRef: skill.source_ref,
        sourceRefResolved: skill.source_ref_resolved,
        sourceRevision: skill.source_revision,
        createdAt: skill.created_at,
        remoteRevision: skill.remote_revision,
        lastCheckedAt: skill.last_checked_at,
        lastCheckError: skill.last_check_error,
      })
    }
    return map
  }
}

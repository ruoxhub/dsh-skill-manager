/**
 * Append-only audit log of skill-library actions.
 *
 * The value is entirely in being complete and cheap: when a skill disappears or
 * an update replaces something unexpected, "what touched this and when" is the
 * question, and no amount of panel state answers it. Writes are best-effort and
 * never block the action they describe — a full disk must not turn a successful
 * install into a failed one — and the table is trimmed on write so it cannot
 * grow without bound.
 *
 * Like the preset and tag tables this one is `dsh_`-prefixed: the database is
 * shared with the skills-manager desktop app, whose own `audit_log` table has a
 * different shape.
 */

import { DatabaseSync } from 'node:sqlite'

/** Hard cap on stored entries; older rows are dropped on insert. */
export const MAX_AUDIT_ENTRIES = 5000

/** Table definition for the audit log. */
export const AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dsh_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    skill_name TEXT,
    success INTEGER NOT NULL,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_dsh_audit_log_ts ON dsh_audit_log(ts DESC);
`

/** Actions the panel records. */
export type AuditAction =
  | 'install-git'
  | 'install-market'
  | 'update'
  | 'delete'
  | 'restore'
  | 'create'
  | 'edit'
  | 'toggle'
  | 'import'
  | 'preset-apply'
  | 'preset-delete'
  | 'backup-commit'
  | 'backup-restore'

/** One stored entry. */
export interface AuditEntry {
  id: number
  ts: number
  action: AuditAction | string
  skill_name: string | null
  success: boolean
  detail: string | null
}

/** What a caller supplies for one entry. */
export interface AuditDraft {
  action: AuditAction
  skillName?: string | null
  success?: boolean
  detail?: string | null
}

/**
 * Audit log storage, sharing the skills-manager database.
 */
export class AuditLog {
  private db: DatabaseSync | null = null
  readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    try {
      this.db = new DatabaseSync(dbPath)
      this.db.exec(AUDIT_SCHEMA_SQL)
    } catch {
      this.db = null
    }
  }

  /** Whether the store has a usable handle. */
  isOpen(): boolean {
    return this.db !== null
  }

  /** Close the handle. */
  close(): void {
    try {
      this.db?.close()
    } catch {
      // ignore
    }
    this.db = null
  }

  /**
   * Record one action. Failures are swallowed on purpose: this is a diagnostic
   * aid, and losing a log line is always better than failing the user's action.
   * @param draft - what happened.
   */
  record(draft: AuditDraft): void {
    if (this.db === null) return
    try {
      this.db
        .prepare('INSERT INTO dsh_audit_log (ts, action, skill_name, success, detail) VALUES (?, ?, ?, ?, ?)')
        .run(
          Date.now(),
          draft.action,
          draft.skillName ?? null,
          draft.success === false ? 0 : 1,
          draft.detail === undefined ? null : String(draft.detail).slice(0, 500),
        )
      // Trim once per write: a bounded table is the only version of this that
      // can be left running for years.
      this.db.prepare('DELETE FROM dsh_audit_log WHERE id NOT IN (SELECT id FROM dsh_audit_log ORDER BY id DESC LIMIT ?)').run(MAX_AUDIT_ENTRIES)
    } catch {
      // ignore
    }
  }

  /**
   * Read the newest entries first.
   * @param limit - maximum rows to return.
   * @param skillName - restrict to one skill.
   * @returns the entries.
   */
  list(limit = 200, skillName?: string): AuditEntry[] {
    if (this.db === null) return []
    try {
      const bounded = Math.min(Math.max(1, Math.trunc(limit)), 1000)
      const rows = skillName === undefined
        ? this.db.prepare('SELECT * FROM dsh_audit_log ORDER BY id DESC LIMIT ?').all(bounded)
        : this.db.prepare('SELECT * FROM dsh_audit_log WHERE skill_name = ? ORDER BY id DESC LIMIT ?').all(skillName, bounded)
      return (rows as unknown as Array<Omit<AuditEntry, 'success'> & { success: number }>).map((row) => ({
        ...row,
        success: row.success === 1,
      }))
    } catch {
      return []
    }
  }
}

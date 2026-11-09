/**
 * Skill tags: a user-assigned label per central-library skill.
 *
 * Tags are metadata about the library, not about any one deployment, so they
 * live in the database and survive every re-deploy. They are stored by skill
 * name because that is the identity the panel and the central store agree on
 * across the whole read path — the database's own `skills.id` is not visible to
 * a scan, and a tag a user cannot attach from the list is not a feature.
 *
 * The table is prefixed `dsh_` for the same reason the preset tables are: this
 * database is shared with the skills-manager desktop app, whose migrations would
 * otherwise rewrite a same-named table it does not understand.
 */

import { DatabaseSync } from 'node:sqlite'

/** Longest tag the store accepts, so a card stays readable. */
export const MAX_TAG_LENGTH = 32

/** Most tags one skill may carry. */
export const MAX_TAGS_PER_SKILL = 12

/** Table definition for the tag store. */
export const TAG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dsh_skill_tags (
    skill_name TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (skill_name, tag)
);
CREATE INDEX IF NOT EXISTS idx_dsh_skill_tags_tag ON dsh_skill_tags(tag);
`

/** One tag with the number of skills carrying it. */
export interface TagCount {
  tag: string
  count: number
}

/** Normalize a tag for comparison and storage: trimmed, lowercased, bounded. */
export function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\s+/gu, '-').slice(0, MAX_TAG_LENGTH)
  // A tag is a label, so anything that would read as whitespace-only or as an
  // empty slug after normalization is rejected rather than stored.
  if (trimmed === '' || trimmed === '-') return null
  return trimmed
}

/**
 * Tag storage, sharing the skills-manager database.
 */
export class TagStore {
  private db: DatabaseSync | null = null
  readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    try {
      this.db = new DatabaseSync(dbPath)
      this.db.exec(TAG_SCHEMA_SQL)
    } catch {
      this.db = null
    }
  }

  /** Whether the store has a usable handle. */
  isOpen(): boolean {
    return this.db !== null
  }

  /** Close the handle (a shared instance must outlive a request). */
  close(): void {
    try {
      this.db?.close()
    } catch {
      // ignore
    }
    this.db = null
  }

  /** Every tag with its skill count, most-used first. */
  listTags(): TagCount[] {
    if (this.db === null) return []
    try {
      return this.db
        .prepare('SELECT tag, COUNT(*) AS count FROM dsh_skill_tags GROUP BY tag ORDER BY count DESC, tag ASC')
        .all() as unknown as TagCount[]
    } catch {
      return []
    }
  }

  /** Tags of one skill, alphabetically. */
  tagsOf(skillName: string): string[] {
    if (this.db === null) return []
    try {
      const rows = this.db
        .prepare('SELECT tag FROM dsh_skill_tags WHERE skill_name = ? ORDER BY tag ASC')
        .all(skillName) as unknown as Array<{ tag: string }>
      return rows.map((row) => row.tag)
    } catch {
      return []
    }
  }

  /** Every skill's tags, keyed by skill name (one query for a whole list). */
  allTags(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    if (this.db === null) return map
    try {
      const rows = this.db
        .prepare('SELECT skill_name, tag FROM dsh_skill_tags ORDER BY skill_name ASC, tag ASC')
        .all() as unknown as Array<{ skill_name: string; tag: string }>
      for (const row of rows) {
        const existing = map.get(row.skill_name)
        if (existing === undefined) map.set(row.skill_name, [row.tag])
        else existing.push(row.tag)
      }
      return map
    } catch {
      return map
    }
  }

  /**
   * Replace a skill's tags wholesale.
   * @param skillName - the skill the tags belong to.
   * @param tags - raw tag strings; normalized, de-duplicated, and capped.
   * @returns the stored tags.
   */
  setTags(skillName: string, tags: readonly string[]): string[] {
    if (this.db === null) return []
    const normalized: string[] = []
    for (const raw of tags) {
      if (typeof raw !== 'string') continue
      const tag = normalizeTag(raw)
      if (tag === null || normalized.includes(tag)) continue
      normalized.push(tag)
      if (normalized.length >= MAX_TAGS_PER_SKILL) break
    }
    try {
      this.db.prepare('DELETE FROM dsh_skill_tags WHERE skill_name = ?').run(skillName)
      const now = Date.now()
      const insert = this.db.prepare('INSERT INTO dsh_skill_tags (skill_name, tag, created_at) VALUES (?, ?, ?)')
      for (const tag of normalized) insert.run(skillName, tag, now)
      return normalized
    } catch {
      return []
    }
  }

  /** Rename a tag everywhere it appears. */
  renameTag(from: string, to: string): boolean {
    if (this.db === null) return false
    const source = normalizeTag(from)
    const target = normalizeTag(to)
    if (source === null || target === null || source === target) return false
    try {
      // A skill that already carries the target tag would collide on the
      // primary key: drop the duplicate rows first, then move the rest.
      this.db.prepare('DELETE FROM dsh_skill_tags WHERE tag = ? AND skill_name IN (SELECT skill_name FROM dsh_skill_tags WHERE tag = ?)').run(target, source)
      this.db.prepare('UPDATE dsh_skill_tags SET tag = ? WHERE tag = ?').run(target, source)
      return true
    } catch {
      return false
    }
  }

  /** Remove a tag from every skill. */
  deleteTag(tag: string): boolean {
    if (this.db === null) return false
    const normalized = normalizeTag(tag)
    if (normalized === null) return false
    try {
      this.db.prepare('DELETE FROM dsh_skill_tags WHERE tag = ?').run(normalized)
      return true
    } catch {
      return false
    }
  }

  /** Drop every row for a skill that no longer exists. */
  forgetSkill(skillName: string): void {
    if (this.db === null) return
    try {
      this.db.prepare('DELETE FROM dsh_skill_tags WHERE skill_name = ?').run(skillName)
    } catch {
      // ignore
    }
  }
}

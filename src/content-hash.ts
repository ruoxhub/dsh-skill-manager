/**
 * Content fingerprint of a skill directory.
 *
 * A skill's identity for update and deployment purposes is the set of files it
 * ships, not its git revision: a monorepo can publish a hundred skills from one
 * repository, and the repository HEAD says nothing about whether *this* skill
 * changed. Hashing the tree answers that directly, and is also what lets a copy
 * deployment know whether re-copying would only destroy local edits.
 *
 * The digest is order-independent on the directory listing (paths are sorted)
 * and covers each file's relative path plus its bytes, so a rename changes the
 * hash even when the bytes do not. The exec bit is part of the hash on POSIX
 * because shipping a script without its exec bit is a real behavioral change.
 */

import { createHash } from 'node:crypto'
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Names that are not part of what a skill *is*: VCS bookkeeping, OS cruft, and
 * regenerable Python artifacts. Kept in sync with skills-manager desktop's
 * `content_hash::is_ignored` so both tools agree on whether a skill changed.
 */
const IGNORED_NAMES = new Set(['.git', '.DS_Store', 'Thumbs.db', '.gitignore', '__pycache__'])

/** Whether a dirent should be skipped entirely when hashing. */
function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.endsWith('.pyc')
}

/** Collect `<relative path, absolute path>` for every file, sorted by relative path. */
function listFiles(root: string, prefix = '', out: Array<{ rel: string; abs: string }> = []): Array<{ rel: string; abs: string }> {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue
    const abs = join(root, entry.name)
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    // A symlink is hashed as its link target text, never followed: following it
    // would pull in content the skill does not own and could loop.
    let isLink = false
    try {
      isLink = lstatSync(abs).isSymbolicLink()
    } catch {
      continue
    }
    if (isLink) {
      out.push({ rel, abs })
      continue
    }
    if (entry.isDirectory()) listFiles(abs, rel, out)
    else if (entry.isFile()) out.push({ rel, abs })
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * SHA-256 over every owned file's relative path and bytes.
 * @param dir - skill directory.
 * @returns hex digest, or null when the directory cannot be read.
 */
export function hashSkillDir(dir: string): string | null {
  let stat
  try {
    stat = lstatSync(dir)
  } catch {
    return null
  }
  if (!stat.isDirectory()) return null
  const hash = createHash('sha256')
  for (const { rel, abs } of listFiles(dir)) {
    hash.update(rel)
    hash.update('\0')
    try {
      const entry = lstatSync(abs)
      if (entry.isSymbolicLink()) {
        hash.update('link\0')
        hash.update(readlinkSync(abs))
      } else {
        hash.update(readFileSync(abs))
        // Only POSIX exposes the exec bit meaningfully; Windows reports a
        // constant, so including it there would only add noise.
        if (process.platform !== 'win32' && (entry.mode & 0o100) !== 0) hash.update('x')
      }
    } catch {
      hash.update('unreadable')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Files present in `current` that `replacement` does not ship.
 *
 * Updating a skill replaces its directory wholesale, so anything the user (or
 * the skill itself) wrote inside it disappears without warning. At the moment of
 * the swap both trees exist, so the set about to vanish is free to compute: it
 * names no owner, just says "these will be removed", which is enough for a
 * person to recognize their own work and stop.
 * @param current - directory as it is now.
 * @param replacement - staged directory about to take its place.
 * @returns relative paths only present in `current`, sorted.
 */
export function removedPaths(current: string, replacement: string): string[] {
  const before = listFiles(current).map((file) => file.rel)
  const after = new Set(listFiles(replacement).map((file) => file.rel))
  return before.filter((rel) => !after.has(rel))
}

/** Names that reappear on the next run, so warning about them would be noise. */
function isRegenerable(name: string): boolean {
  return name === '__pycache__' || name === '.DS_Store' || name === 'Thumbs.db' || name.endsWith('.pyc')
}

/**
 * Collapse the removed files to the shallowest path that explains them.
 *
 * A subdirectory that disappears entirely is reported once, by the directory,
 * rather than once per file it held: listing its children would bury the
 * signal in noise. A directory that still exists but lost a file keeps the
 * per-file entry, because the directory itself is legitimate.
 * @param removed - output of {@link removedPaths}.
 * @param replacement - the staged tree the removals are measured against.
 * @returns the shallowest removed paths, sorted.
 */
export function summarizeRemovals(removed: readonly string[], replacement: string): string[] {
  const kept: string[] = []
  for (const path of [...removed].sort()) {
    if (isRegenerable(path.split('/').pop() ?? '')) continue
    // Already covered by a shallower ancestor entry.
    if (kept.some((parent) => path.startsWith(`${parent}/`))) continue
    // Walk up to the shallowest ancestor that is gone from the replacement.
    const segments = path.split('/')
    let missing: string | null = null
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = segments.slice(0, depth).join('/')
      if (!existsSync(join(replacement, ancestor))) {
        missing = ancestor
        break
      }
    }
    kept.push(missing ?? path)
  }
  return kept
}

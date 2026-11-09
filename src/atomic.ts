/**
 * Replace a directory in one step.
 *
 * Copying straight over a live skill directory has two failure modes that both
 * end in a half-written skill: a copy interrupted part-way leaves a tree that is
 * neither the old version nor the new one, and deleting first means a failed
 * copy has already destroyed the only copy. Staging the new tree beside the
 * target and renaming it into place keeps the swap to a single atomic step, so
 * a failure leaves the previous version untouched.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * A staging path beside `target`, so the final rename stays on one filesystem
 * (a cross-device rename fails with EXDEV).
 */
export function stagedPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.staged-${process.pid}-${Date.now()}`)
}

/**
 * Remove a path if it exists, reporting whether it did.
 * @param path - path to remove.
 * @returns whether anything was removed.
 */
function removeIfPresent(path: string): boolean {
  if (!existsSync(path)) return false
  rmSync(path, { recursive: true, force: true })
  return true
}

/**
 * Swap a staged directory into the target's place.
 *
 * The previous tree is moved aside rather than deleted first, so the window in
 * which neither version exists is the one rename, not the copy.
 * @param staged - fully written replacement directory.
 * @param target - current directory to replace.
 * @returns the directory the previous version was moved to, or null when target
 * was absent (nothing to keep).
 */
export function swapSkillDir(staged: string, target: string): string | null {
  mkdirSync(dirname(target), { recursive: true })
  let previous: string | null = null
  if (existsSync(target)) {
    previous = `${target}.old-${process.pid}-${Date.now()}`
    renameSync(target, previous)
  }
  try {
    renameSync(staged, target)
  } catch (error) {
    // Put the old version back: a failed swap must not leave a hole where the
    // skill used to be.
    if (previous !== null) {
      try {
        renameSync(previous, target)
      } catch {
        // Nothing further to do; the caller reports the error and the tree
        // stays at `previous` instead of vanishing.
      }
    }
    throw error
  }
  return previous
}

/**
 * Delete a swap's leftover previous tree. Best-effort: it holds no live data,
 * and failing to remove it must not fail the update that already succeeded.
 * @param previous - return value of {@link swapSkillDir}.
 */
export function discardPrevious(previous: string | null): void {
  if (previous === null) return
  try {
    removeIfPresent(previous)
  } catch {
    // A stale `.old-*` directory is harmless; it is ignored by the scanner
    // because it does not contain a SKILL.md at a skill root.
  }
}

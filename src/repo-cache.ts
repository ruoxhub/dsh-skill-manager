/**
 * Persistent per-repository Git checkout cache.
 *
 * Previewing, installing, and updating a skill all need a temporary checkout of
 * its upstream repository. Cloning straight into a temp directory works, but it
 * re-downloads the whole repository every single time: install a skill, update
 * it a week later, install a second skill from the same monorepo, and each of
 * those is a fresh full transfer of objects the machine already had.
 *
 * So one checkout per repository is kept under `<central root>/cache/repos` and
 * every operation clones *from* it into its own temp directory. The cache slot
 * is never handed to a caller directly: callers delete their temp checkout when
 * done, which must not touch the shared one.
 *
 * The slot is a plain `--depth 1` clone and is refreshed with `fetch --depth 1`
 * + `reset --hard`, so a repeat operation pays a delta instead of a full clone.
 * A refresh that fails (credentials moved to ssh, remote rewritten, slot
 * corrupt) discards the slot and falls back to a clean clone rather than
 * failing the request.
 *
 * Slots are keyed by the normalized repository identity (see repo-identity.ts),
 * so `https://host/x/y`, `https://host/x/y.git` and `git@host:x/y` share one —
 * the same rule the panel uses to group imported repositories.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { getCentralManagerRoot } from './central-store.ts'
import { normalizeRepoUrl } from './repo-identity.ts'

const execFileAsync = promisify(execFile)

/**
 * Upper bound on the whole repository cache.
 *
 * A backstop, not a quota: a library built from many repositories would
 * otherwise accumulate one checkout per repository forever. Upstream
 * skills-manager measured 569 MB across 48 repositories before it added the
 * same cap, which is what this number is sized against.
 */
const CACHE_LIMIT_BYTES = 1024 * 1024 * 1024

/** How long to wait for another operation's clone of the same repository. */
const LOCK_TIMEOUT_MS = 120_000

/**
 * Resolve the repository cache root (`<central root>/cache/repos`).
 * @returns absolute path of the cache directory.
 */
export function getRepoCacheRoot(): string {
  return join(getCentralManagerRoot(), 'cache', 'repos')
}

/**
 * Cache slot path for one repository.
 *
 * Keyed by the normalized identity so URL spellings that name the same
 * repository share a slot; falls back to the raw URL for input the normalizer
 * cannot parse, which only costs a separate slot, never a wrong one.
 * @param url - repository URL as given by the caller.
 * @returns absolute path of the slot directory.
 */
export function repoCacheSlot(url: string): string {
  const identity = normalizeRepoUrl(url) ?? url.trim()
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return join(getRepoCacheRoot(), hash)
}

/** Block the current thread, so the lock retry loop does not spin. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Take the slot's lock file, so two operations cannot clone the same slot at
 * once. Returns null when another operation held it past the timeout, which
 * callers answer with an uncached clone instead of an error.
 * @param slot - cache slot directory.
 * @returns a release function, or null when the lock could not be taken.
 */
function acquireSlotLock(slot: string): (() => void) | null {
  const lockPath = `${slot}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  mkdirSync(dirname(lockPath), { recursive: true })
  while (Date.now() < deadline) {
    try {
      closeSync(openSync(lockPath, 'wx'))
      return () => {
        try {
          unlinkSync(lockPath)
        } catch {
          // Already gone; the lock did its job.
        }
      }
    } catch {
      sleepSync(100)
    }
  }
  return null
}

/** Recursively total a directory's size, for the LRU cap. */
function directorySize(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      const info = statSync(full)
      total += info.isDirectory() ? directorySize(full) : info.size
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total
}

/**
 * Delete least-recently-used slots until the cache is back under the cap.
 * `keep` is the slot about to be written; a slot another operation holds is
 * skipped rather than waited for, since deleting a checkout from under a
 * running clone would break it.
 *
 * ponytail: recency is the slot directory's mtime, not a recorded access time.
 * That is coarse — a fetch updates files inside the slot without touching the
 * directory — but it is one `stat` per slot instead of tracking accesses, and
 * being wrong only means evicting a slightly warmer slot.
 * @param keep - slot to preserve.
 */
function pruneRepoCache(keep: string): void {
  const root = getRepoCacheRoot()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  const slots: Array<{ path: string; size: number; used: number }> = []
  let total = 0
  for (const entry of entries) {
    const path = join(root, entry)
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    const size = directorySize(path)
    total += size
    slots.push({ path, size, used: statSync(path).mtimeMs })
  }
  if (total <= CACHE_LIMIT_BYTES) return
  slots.sort((a, b) => a.used - b.used)
  for (const slot of slots) {
    if (total <= CACHE_LIMIT_BYTES) break
    if (slot.path === keep) continue
    if (existsSync(`${slot.path}.lock`)) continue
    try {
      rmSync(slot.path, { recursive: true, force: true })
      total -= slot.size
    } catch {
      // Locked or in use; the next prune sees it again.
    }
  }
}

/**
 * Refresh the slot to the requested branch, cloning it when absent or unusable.
 * @param url - repository URL as given by the caller.
 * @param slot - cache slot directory.
 * @param branch - branch to check out, or undefined for the remote default.
 */
async function refreshSlot(url: string, slot: string, branch?: string): Promise<void> {
  if (existsSync(join(slot, '.git'))) {
    // A fetch adds a delta where a clone re-downloads everything, which is the
    // whole point of the slot. A fetch that fails leaves the slot alone: the
    // clean clone below replaces it only if that clone succeeds, so a transient
    // network failure costs the request without also costing the cache.
    const fetchArgs = ['-C', slot, 'fetch', '--depth', '1', 'origin']
    if (branch) fetchArgs.push(branch)
    try {
      await execFileAsync('git', fetchArgs, { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      await execFileAsync('git', ['-C', slot, 'reset', '--hard', 'FETCH_HEAD'], { timeout: 30_000 })
      return
    } catch {
      // Fall through to a clean clone; the slot is kept until that succeeds.
    }
  }

  // Clone beside the slot and rename in, so a clone cut short by a dropped
  // connection never looks like a usable slot to the next operation.
  const staging = `${slot}.staged-${process.pid}-${Date.now()}`
  rmSync(staging, { recursive: true, force: true })
  const cloneArgs = ['clone', '--depth', '1']
  if (branch) cloneArgs.push('--branch', branch)
  cloneArgs.push(url, staging)
  try {
    await execFileAsync('git', cloneArgs, { timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    rmSync(slot, { recursive: true, force: true })
    renameSync(staging, slot)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/**
 * Populate `destination` with a checkout of `url`, reusing the repository cache.
 *
 * `destination` must be absent or empty, exactly like `git clone`. The caller
 * owns it and deletes it when done; the cache slot is never the destination.
 * @param options - repository URL, destination, and optional branch/timeout.
 */
export async function materializeRepoCheckout(options: {
  url: string
  destination: string
  branch?: string
  timeoutMs?: number
}): Promise<void> {
  const { url, destination, branch } = options
  const timeoutMs = options.timeoutMs ?? 120_000
  const slot = repoCacheSlot(url)
  const release = acquireSlotLock(slot)

  if (release === null) {
    // Another operation has held this slot too long. An uncached clone is
    // slower but correct, and it keeps a stuck lock from failing the request.
    await execFileAsync('git', cloneArgsFor(url, branch, destination), {
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return
  }

  try {
    await refreshSlot(url, slot, branch)
    pruneRepoCache(slot)
    // `--no-hardlinks` because hardlinks are git's default for a local clone
    // and fail across volumes on Windows; a copied object store is the only
    // form that works everywhere.
    await execFileAsync('git', ['clone', '--local', '--no-hardlinks', slot, destination], {
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } finally {
    release()
  }
}

/** Shallow clone arguments, shared by the uncached fallback path. */
function cloneArgsFor(url: string, branch: string | undefined, destination: string): string[] {
  const args = ['clone', '--depth', '1']
  if (branch) args.push('--branch', branch)
  args.push(url, destination)
  return args
}

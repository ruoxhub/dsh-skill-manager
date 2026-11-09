/**
 * Remote Revision Resolver.
 *
 * Checks upstream Git repositories via `git ls-remote` with repository-level
 * deduplication, concurrency bounding, and timeout protection. Updates
 * CentralSkillStore with observed remote revisions and update_status.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CentralSkillRecord, CentralSkillStore } from './central-store.ts'

const execFileAsync = promisify(execFile)

export interface SkillCheckResult {
  id: string
  name: string
  sourceType: string
  sourceRef: string | null
  sourceRevision: string | null
  remoteRevision: string | null
  updateStatus: 'up_to_date' | 'update_available' | 'error' | 'unknown'
  error?: string | null
}

export interface CheckAllSummary {
  total: number
  checked: number
  updateAvailable: number
  errors: number
  lastCheckedAt: number
  results: SkillCheckResult[]
}

/**
 * Fetch the latest commit SHA for a remote Git repository ref via `git ls-remote`.
 */
export async function queryRemoteGitRevision(
  repoUrl: string,
  ref = 'HEAD',
  timeoutMs = 15000,
): Promise<string> {
  const cleanUrl = repoUrl.trim()
  const cleanRef = ref.trim() || 'HEAD'

  const { stdout } = await execFileAsync(
    'git',
    ['ls-remote', cleanUrl, cleanRef],
    {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // never hang on interactive auth
      },
    },
  )

  const line = stdout.trim().split(/\r?\n/)[0]
  if (!line) {
    throw new Error(`Empty response from git ls-remote for ${repoUrl} ${ref}`)
  }

  const parts = line.split(/\s+/)
  const sha = parts[0]?.trim()
  if (!sha || !/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    throw new Error(`Failed to parse commit SHA from git ls-remote output: ${line}`)
  }

  return sha
}

/**
 * Which `(installed revision, subpath)` pairs still hold exactly the directory
 * the remote HEAD holds.
 *
 * A skill installed from a subdirectory of a monorepo is otherwise "out of
 * date" after every commit anywhere in that repository. The repository HEAD
 * says nothing about one subdirectory, so the answer has to come from the tree
 * itself: a blobless, depth-1 fetch of the two commits into a throwaway bare
 * repository costs trees only, and comparing the subtree object ids tells us
 * whether an update would write exactly what is already installed.
 *
 * A pair whose path is missing, is not a directory, or cannot be resolved
 * simply stays out of the result, so the caller keeps reporting an update —
 * the safe direction (a spurious update is recoverable, a missed one is not).
 *
 * ponytail: a changed `.gitattributes` above the subpath can alter the checked
 * out bytes without changing the subtree id. The upstream tool compares those
 * entries too; here the tree id is the whole signal, so that (rare) case still
 * reports an update. Upgrade path: compare `rev:<dir>/.gitattributes` ids for
 * each ancestor, as `git_fetcher.rs` does.
 *
 * @param repoUrl - git remote.
 * @param pairs - installed revision plus subpath pairs.
 * @param head - remote HEAD revision.
 * @returns keys of the pairs whose installed subtree still equals HEAD's.
 */
async function unchangedSubtrees(
  repoUrl: string,
  pairs: ReadonlyArray<{ rev: string; subpath: string }>,
  head: string,
): Promise<Set<string>> {
  const unchanged = new Set<string>()
  const usable = pairs.filter((pair) => pair.subpath !== '' && /^[0-9a-f]{40}$/iu.test(pair.rev))
  if (usable.length === 0 || !/^[0-9a-f]{40}$/iu.test(head)) return unchanged

  const temp = mkdtempSync(join(tmpdir(), 'dsh-skill-subtree-'))
  const revs = [...new Set([...usable.map((pair) => pair.rev), head])]
  try {
    await execFileAsync('git', ['init', '--bare', '--quiet', temp], { timeout: 15000 })
    const fetchArgs = ['fetch', '--no-tags', '--depth=1', '--filter=blob:none', repoUrl, ...revs]
    try {
      await execFileAsync('git', ['-C', temp, ...fetchArgs], {
        timeout: 60000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch {
      // Servers without partial-clone support reject the filter; the same fetch
      // without it still brings trees, just also the blobs.
      const plain = fetchArgs.filter((arg) => arg !== '--filter=blob:none')
      await execFileAsync('git', ['-C', temp, ...plain], {
        timeout: 90000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    }
    const treeOf = async (rev: string, subpath: string): Promise<string | null> => {
      try {
        const { stdout } = await execFileAsync('git', ['-C', temp, 'rev-parse', `${rev}:${subpath}`], { timeout: 15000 })
        return stdout.trim() || null
      } catch {
        return null
      }
    }
    const headTrees = new Map<string, string | null>()
    for (const pair of usable) {
      const key = `${pair.rev}\0${pair.subpath}`
      const installedTree = await treeOf(pair.rev, pair.subpath)
      if (installedTree === null) continue
      if (!headTrees.has(pair.subpath)) headTrees.set(pair.subpath, await treeOf(head, pair.subpath))
      if (headTrees.get(pair.subpath) === installedTree) unchanged.add(key)
    }
    return unchanged
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/**
 * Run a pool of async worker tasks with bounded concurrency.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let nextIdx = 0

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++
      const task = tasks[idx]
      if (task) {
        results[idx] = await task()
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

/**
 * Check updates for a single skill.
 */
export async function checkOneSkill(
  skill: CentralSkillRecord,
  store?: CentralSkillStore,
): Promise<SkillCheckResult> {
  const now = Date.now()

  // Non-git or local skills do not have a remote tracking repository
  if (skill.source_type !== 'git' || !skill.source_ref) {
    const result: SkillCheckResult = {
      id: skill.id,
      name: skill.name,
      sourceType: skill.source_type,
      sourceRef: skill.source_ref,
      sourceRevision: skill.source_revision,
      remoteRevision: skill.source_revision,
      updateStatus: 'up_to_date',
    }
    store?.updateCheckState(skill.id, skill.source_revision, 'up_to_date', null, now)
    return result
  }

  const targetRef = skill.source_branch || 'HEAD'

  try {
    const remoteSha = await queryRemoteGitRevision(skill.source_ref, targetRef)
    const currentSha = skill.source_revision

    let updateStatus: 'up_to_date' | 'update_available' = 'up_to_date'
    if (!currentSha || !remoteSha.toLowerCase().startsWith(currentSha.toLowerCase())) {
      updateStatus = 'update_available'
      // A subdirectory install is only out of date when *its* subtree moved, not
      // when the repository as a whole did.
      // A comparison that cannot run — an unreachable revision, a server
      // without partial clone — leaves the update reported: hiding a real
      // change is worse than offering a no-op.
      if (typeof skill.source_subpath === 'string' && skill.source_subpath !== '' && currentSha) {
        try {
          const unchanged = await unchangedSubtrees(
            skill.source_ref,
            [{ rev: currentSha, subpath: skill.source_subpath }],
            remoteSha,
          )
          if (unchanged.size > 0) updateStatus = 'up_to_date'
        } catch {
          updateStatus = 'update_available'
        }
      }
    }

    store?.updateCheckState(skill.id, remoteSha, updateStatus, null, now)

    return {
      id: skill.id,
      name: skill.name,
      sourceType: skill.source_type,
      sourceRef: skill.source_ref,
      sourceRevision: skill.source_revision,
      remoteRevision: remoteSha,
      updateStatus,
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    store?.updateCheckState(skill.id, null, 'error', errMsg, now)
    return {
      id: skill.id,
      name: skill.name,
      sourceType: skill.source_type,
      sourceRef: skill.source_ref,
      sourceRevision: skill.source_revision,
      remoteRevision: null,
      updateStatus: 'error',
      error: errMsg,
    }
  }
}

/**
 * Check updates for all skills tracked in the central store.
 * Groups skills by (source_ref + branch) so that monorepos are queried only once.
 */
export async function checkAllSkills(
  store: CentralSkillStore,
  concurrency = 6,
): Promise<CheckAllSummary> {
  const allSkills = store.getAllSkills()
  const now = Date.now()

  if (allSkills.length === 0) {
    return {
      total: 0,
      checked: 0,
      updateAvailable: 0,
      errors: 0,
      lastCheckedAt: now,
      results: [],
    }
  }

  // Group Git skills by upstream target (repo + branch) to avoid duplicate network queries
  const repoGroups = new Map<string, CentralSkillRecord[]>()
  const nonGitSkills: CentralSkillRecord[] = []

  for (const skill of allSkills) {
    if (skill.source_type === 'git' && skill.source_ref) {
      const key = `${skill.source_ref.trim()}#${skill.source_branch?.trim() || 'HEAD'}`
      const group = repoGroups.get(key)
      if (group) {
        group.push(skill)
      } else {
        repoGroups.set(key, [skill])
      }
    } else {
      nonGitSkills.push(skill)
    }
  }

  const results: SkillCheckResult[] = []

  // Handle non-git skills immediately
  for (const skill of nonGitSkills) {
    store.updateCheckState(skill.id, skill.source_revision, 'up_to_date', null, now)
    results.push({
      id: skill.id,
      name: skill.name,
      sourceType: skill.source_type,
      sourceRef: skill.source_ref,
      sourceRevision: skill.source_revision,
      remoteRevision: skill.source_revision,
      updateStatus: 'up_to_date',
    })
  }

  // Prepare tasks for unique Git repository queries
  const tasks = Array.from(repoGroups.entries()).map(([key, group]) => async () => {
    const [repoUrl, branch] = key.split('#')
    try {
      const remoteSha = await queryRemoteGitRevision(repoUrl!, branch || 'HEAD')
      // Resolve every subdirectory install in this repository at once: one
      // blobless fetch serves all of them, however many skills it publishes.
      const stalePairs = group
        .filter((skill) => {
          const currentSha = skill.source_revision
          return currentSha !== null
            && (typeof skill.source_subpath === 'string' && skill.source_subpath !== '')
            && !remoteSha.toLowerCase().startsWith(currentSha.toLowerCase())
        })
        .map((skill) => ({ rev: skill.source_revision as string, subpath: skill.source_subpath as string }))
      let unchanged = new Set<string>()
      if (stalePairs.length > 0) {
        try {
          unchanged = await unchangedSubtrees(repoUrl!, stalePairs, remoteSha)
        } catch {
          // Comparison unavailable: report the update rather than miss one.
          unchanged = new Set()
        }
      }
      for (const skill of group) {
        const currentSha = skill.source_revision
        let updateStatus: 'up_to_date' | 'update_available' = 'up_to_date'
        if (!currentSha || !remoteSha.toLowerCase().startsWith(currentSha.toLowerCase())) {
          updateStatus = 'update_available'
          const subpath = skill.source_subpath
          if (typeof subpath === 'string' && subpath !== '' && currentSha
            && unchanged.has(`${currentSha}\0${subpath}`)) {
            updateStatus = 'up_to_date'
          }
        }
        store.updateCheckState(skill.id, remoteSha, updateStatus, null, now)
        results.push({
          id: skill.id,
          name: skill.name,
          sourceType: skill.source_type,
          sourceRef: skill.source_ref,
          sourceRevision: skill.source_revision,
          remoteRevision: remoteSha,
          updateStatus,
        })
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      for (const skill of group) {
        store.updateCheckState(skill.id, null, 'error', errMsg, now)
        results.push({
          id: skill.id,
          name: skill.name,
          sourceType: skill.source_type,
          sourceRef: skill.source_ref,
          sourceRevision: skill.source_revision,
          remoteRevision: null,
          updateStatus: 'error',
          error: errMsg,
        })
      }
    }
  })

  await runWithConcurrency(tasks, concurrency)

  const updateAvailable = results.filter((r) => r.updateStatus === 'update_available').length
  const errors = results.filter((r) => r.updateStatus === 'error').length

  return {
    total: allSkills.length,
    checked: results.length,
    updateAvailable,
    errors,
    lastCheckedAt: now,
    results,
  }
}

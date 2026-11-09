/**
 * Skill Updater.
 *
 * Performs single and batch updates of skills from their upstream Git repositories.
 * Uses temporary checkouts materialized from the shared repository cache, atomic
 * replacement into the central store directory (~/.agents/skills-manager/skills/<name>),
 * synchronization of deployed Agent targets, and database transaction/state updates.
 */

import { execFile } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { discardPrevious, stagedPathFor, swapSkillDir } from './atomic.ts'
import type { CentralSkillRecord, CentralSkillStore } from './central-store.ts'
import { hashSkillDir, removedPaths, summarizeRemovals } from './content-hash.ts'
import { materializeRepoCheckout } from './repo-cache.ts'

const execFileAsync = promisify(execFile)

export interface UpdateSkillResult {
  id: string
  name: string
  previousRevision: string | null
  newRevision: string | null
  updatedTargetsCount: number
  success: boolean
  error?: string | null
  /** Relative paths the swap removed from the skill (user files or upstream deletions). */
  removedPaths?: string[]
}

/** What applying one skill's new version changed. */
interface ApplyOutcome {
  updatedTargets: number
  removedPaths: string[]
  contentHash: string | null
}

export interface UpdateAllSummary {
  total: number
  updated: number
  failed: number
  results: UpdateSkillResult[]
}

/**
 * Check a repository out into a temporary directory and return HEAD revision.
 *
 * The checkout comes from the shared repository cache (repo-cache.ts), so an
 * update pays for a fetch delta instead of re-downloading the whole repository.
 */
async function shallowCloneRepo(
  repoUrl: string,
  branch: string | null,
  targetDir: string,
  timeoutMs = 60000,
): Promise<string> {
  await materializeRepoCheckout({
    url: repoUrl,
    destination: targetDir,
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    timeoutMs,
  })

  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: targetDir,
    timeout: 10000,
  })

  const sha = stdout.trim()
  if (!sha || !/^[0-9a-fA-F]{7,40}$/.test(sha)) {
    throw new Error(`Failed to parse commit SHA from cloned repo: ${sha}`)
  }
  return sha
}

/**
 * Apply the updated files from a cloned repo to a specific skill's central folder
 * and its deployed targets.
 *
 * The new tree is staged beside the target and renamed into place, so a failed
 * copy leaves the previous version intact instead of a half-written skill. The
 * paths the swap removes are reported before the swap, while both trees still
 * exist.
 */
function applySkillFiles(
  skill: CentralSkillRecord,
  clonedRepoDir: string,
  store: CentralSkillStore,
): ApplyOutcome {
  const subpath = (skill.source_subpath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const skillSrcDir = subpath ? join(clonedRepoDir, subpath) : clonedRepoDir

  if (!existsSync(skillSrcDir)) {
    throw new Error(`Skill source folder not found at subpath "${subpath}" in repository`)
  }

  // 1. Stage the new version, then swap it into the central store in one rename.
  const staged = stagedPathFor(skill.central_path)
  rmSync(staged, { recursive: true, force: true })
  try {
    cpSync(skillSrcDir, staged, { recursive: true })
  } catch (error) {
    rmSync(staged, { recursive: true, force: true })
    throw error
  }
  const removed = existsSync(skill.central_path)
    ? summarizeRemovals(removedPaths(skill.central_path, staged), staged)
    : []
  discardPrevious(swapSkillDir(staged, skill.central_path))
  const contentHash = hashSkillDir(skill.central_path)

  // 2. Synchronize deployed Agent copies / targets recorded in DB
  let updatedTargets = 0
  const targets = store.getSkillTargets(skill.id)
  for (const target of targets) {
    if (!target.target_path || !existsSync(target.target_path)) continue

    // A link into the central tree already shows the new files: the central
    // swap replaced what it points at, so copying would replace the link.
    try {
      const stat = lstatSync(target.target_path)
      if (stat.isSymbolicLink()) {
        if (resolve(readlinkSync(target.target_path)) === resolve(skill.central_path)) updatedTargets++
        continue
      }
    } catch {
      // ignore
    }

    // A copy target takes the same staged swap, so an interrupted update never
    // leaves the deployed copy half-written either.
    const targetStage = stagedPathFor(target.target_path)
    rmSync(targetStage, { recursive: true, force: true })
    try {
      cpSync(skill.central_path, targetStage, { recursive: true })
      discardPrevious(swapSkillDir(targetStage, target.target_path))
      updatedTargets++
    } catch {
      // ignore individual target sync error
      rmSync(targetStage, { recursive: true, force: true })
    }
  }

  return { updatedTargets, removedPaths: removed, contentHash }
}

/**
 * Update a single skill by ID or CentralSkillRecord.
 */
export async function updateOneSkill(
  skillOrId: string | CentralSkillRecord,
  store: CentralSkillStore,
): Promise<UpdateSkillResult> {
  const skill =
    typeof skillOrId === 'string' ? store.getSkillById(skillOrId) : skillOrId

  if (!skill) {
    return {
      id: typeof skillOrId === 'string' ? skillOrId : '',
      name: '',
      previousRevision: null,
      newRevision: null,
      updatedTargetsCount: 0,
      success: false,
      error: 'Skill not found in central store',
    }
  }

  if (skill.source_type !== 'git' || !skill.source_ref) {
    return {
      id: skill.id,
      name: skill.name,
      previousRevision: skill.source_revision,
      newRevision: skill.source_revision,
      updatedTargetsCount: 0,
      success: false,
      error: 'Skill does not have a Git remote source repository',
    }
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-skill-up-'))

  try {
    const newRevision = await shallowCloneRepo(
      skill.source_ref,
      skill.source_branch,
      tempRoot,
    )

    const outcome = applySkillFiles(skill, tempRoot, store)

    store.markSkillUpdated(skill.id, newRevision, outcome.contentHash)

    return {
      id: skill.id,
      name: skill.name,
      previousRevision: skill.source_revision,
      newRevision,
      updatedTargetsCount: outcome.updatedTargets,
      removedPaths: outcome.removedPaths,
      success: true,
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      id: skill.id,
      name: skill.name,
      previousRevision: skill.source_revision,
      newRevision: null,
      updatedTargetsCount: 0,
      success: false,
      error: errorMsg,
    }
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * Update all skills that currently have `update_status === 'update_available'`.
 * Optimizes network requests by cloning each upstream repository once for all its skills.
 */
export async function updateAllSkills(store: CentralSkillStore): Promise<UpdateAllSummary> {
  const allSkills = store.getAllSkills()
  const pendingSkills = allSkills.filter(
    (s) => s.update_status === 'update_available' && s.source_type === 'git' && s.source_ref,
  )

  if (pendingSkills.length === 0) {
    return {
      total: 0,
      updated: 0,
      failed: 0,
      results: [],
    }
  }

  // Group skills by repo URL and branch to clone each repository only once
  const repoGroups = new Map<string, CentralSkillRecord[]>()
  for (const skill of pendingSkills) {
    const key = `${skill.source_ref!.trim()}#${skill.source_branch?.trim() || 'HEAD'}`
    const group = repoGroups.get(key)
    if (group) {
      group.push(skill)
    } else {
      repoGroups.set(key, [skill])
    }
  }

  const results: UpdateSkillResult[] = []

  for (const [key, group] of repoGroups.entries()) {
    const [repoUrl, branch] = key.split('#')
    const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-skill-batch-up-'))

    try {
      const newRevision = await shallowCloneRepo(repoUrl!, branch || 'HEAD', tempRoot)

      for (const skill of group) {
        try {
          const outcome = applySkillFiles(skill, tempRoot, store)
          store.markSkillUpdated(skill.id, newRevision, outcome.contentHash)

          results.push({
            id: skill.id,
            name: skill.name,
            previousRevision: skill.source_revision,
            newRevision,
            updatedTargetsCount: outcome.updatedTargets,
            removedPaths: outcome.removedPaths,
            success: true,
          })
        } catch (innerErr: unknown) {
          const errMsg = innerErr instanceof Error ? innerErr.message : String(innerErr)
          results.push({
            id: skill.id,
            name: skill.name,
            previousRevision: skill.source_revision,
            newRevision: null,
            updatedTargetsCount: 0,
            success: false,
            error: errMsg,
          })
        }
      }
    } catch (cloneErr: unknown) {
      const cloneErrMsg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr)
      for (const skill of group) {
        results.push({
          id: skill.id,
          name: skill.name,
          previousRevision: skill.source_revision,
          newRevision: null,
          updatedTargetsCount: 0,
          success: false,
          error: `Failed to clone repository: ${cloneErrMsg}`,
        })
      }
    } finally {
      try {
        rmSync(tempRoot, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  const updated = results.filter((r) => r.success).length
  const failed = results.filter((r) => !r.success).length

  return {
    total: pendingSkills.length,
    updated,
    failed,
    results,
  }
}

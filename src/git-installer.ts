/**
 * Git skill installer for dsh-skill-manager.
 *
 * Implements previewing and installing skills from Git repositories
 * directly into the central store (~/.agents/skills-manager) and the user/project
 * deploy targets, with full parity with skills-manager desktop.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { discardPrevious, stagedPathFor, swapSkillDir } from './atomic.ts'
import {
  CentralSkillStore,
  getCentralDbPath,
  getCentralSkillsDir,
} from './central-store.ts'
import { findProjectRoot } from './collect.ts'
import { hashSkillDir } from './content-hash.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { materializeRepoCheckout } from './repo-cache.ts'
import { normalizeRepoUrl } from './repo-identity.ts'

export interface GitSkillPreviewItem {
  relPath: string
  name: string
  description: string | null
}

export interface GitPreviewResult {
  tempDir: string
  skills: GitSkillPreviewItem[]
}

export interface SkillInstallItem {
  relPath: string
  name: string
}

/**
 * Raised when a Git install request is malformed or its preview sandbox is gone.
 * Routes map this to 400 (client's fault) instead of 500 (server fault).
 */
export class GitInstallInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitInstallInputError'
  }
}

export interface GitConfirmInstallOptions {
  repoUrl: string
  tempDir: string
  items: SkillInstallItem[]
  target?: 'user' | 'project'
  cwd?: string
  agentsHome?: string
  dshHome?: string
  centralDbPath?: string
  centralSkillsDir?: string
}

export interface InstalledGitSkill {
  name: string
  installedPath: string
  centralPath: string
}

export interface GitConfirmInstallResult {
  ok: true
  installed: InstalledGitSkill[]
}

/** Validate whether a temp dir is safe to operate on or clean up. */
export function isSafeTempCloneDir(dirPath: string): boolean {
  if (!dirPath || typeof dirPath !== 'string') return false
  const resolved = resolve(dirPath)
  const tempBase = resolve(tmpdir())
  if (!resolved.startsWith(tempBase)) return false
  return basename(resolved).includes('dsh-git-skill-')
}

/** Recursively scan for directories containing SKILL.md up to maxDepth. */
export function collectSkillDirs(dir: string, maxDepth = 4, currentDepth = 0): string[] {
  if (currentDepth > maxDepth) return []
  const skillDirs: string[] = []

  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return skillDirs
  }

  // If this directory contains SKILL.md, register it
  const hasSkillMd = entries.some(
    (e) => e.toLowerCase() === 'skill.md' && !statSync(join(dir, e)).isDirectory(),
  )
  if (hasSkillMd) {
    skillDirs.push(dir)
  }

  // Scan subdirectories (skip hidden dirs, .git, node_modules)
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) {
        const sub = collectSkillDirs(full, maxDepth, currentDepth + 1)
        skillDirs.push(...sub)
      }
    } catch {
      // ignore unreadable entries
    }
  }

  return skillDirs
}

/**
 * Best-effort sweep of abandoned preview sandboxes (older than maxAgeMs).
 * A preview that the user walks away from is never confirmed or cancelled, so
 * without this the temp dir would linger until the OS cleans the temp root.
 */
export function sweepStalePreviewDirs(maxAgeMs = 60 * 60 * 1000): void {
  const tempBase = tmpdir()
  let entries: string[] = []
  try {
    entries = readdirSync(tempBase)
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.includes('dsh-git-skill-')) continue
    const full = join(tempBase, entry)
    if (!isSafeTempCloneDir(full)) continue
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue
      rmSync(full, { recursive: true, force: true })
    } catch {
      // ignore: best effort only
    }
  }
}

/**
 * Preview skills in a Git repository by shallow cloning into an isolated temp dir.
 */
export async function previewGitInstall(
  repoUrl: string,
  options?: { timeoutMs?: number; branch?: string },
): Promise<GitPreviewResult> {
  const url = repoUrl.trim()
  if (!url) {
    throw new Error('Repository URL cannot be empty')
  }

  sweepStalePreviewDirs()

  const tempDir = join(tmpdir(), `dsh-git-skill-${randomBytes(6).toString('hex')}`)
  mkdirSync(tempDir, { recursive: true })

  try {
    const timeout = options?.timeoutMs ?? 60000
    try {
      await materializeRepoCheckout({
        url,
        destination: tempDir,
        branch: options?.branch,
        timeoutMs: timeout,
      })
    } catch (gitErr: unknown) {
      const err = gitErr as { killed?: boolean; signal?: string; code?: string; stderr?: string; message?: string }
      if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') {
        throw new Error(
          `Git clone timed out after ${Math.round(timeout / 1000)}s. Please check network connectivity and git proxy configuration.`,
        )
      }
      const stderr = (err?.stderr || '').trim()
      if (stderr) {
        throw new Error(`Git clone failed: ${stderr}`)
      }
      throw gitErr
    }

    const foundDirs = collectSkillDirs(tempDir)
    if (foundDirs.length === 0) {
      throw new Error('Repository contains no valid skills (no SKILL.md found)')
    }

    const skills: GitSkillPreviewItem[] = []
    for (const dir of foundDirs) {
      const skillMdPath = join(dir, 'SKILL.md')
      let frontmatterDesc: string | null = null
      let frontmatterName: string | null = null

      try {
        const content = readFileSync(skillMdPath, 'utf8')
        const fm = parseFrontmatter(content)
        if (fm.name?.trim()) frontmatterName = fm.name.trim()
        if (fm.description?.trim()) frontmatterDesc = fm.description.trim()
      } catch {
        // fallback to dirname
      }

      const rel = relative(tempDir, dir).replace(/\\/g, '/')
      const relPath = rel === '' ? '.' : rel
      const baseName =
        relPath === '.'
          ? basename(url.replace(/\.git$/i, '')).replace(/[^a-zA-Z0-9_-]/g, '-')
          : basename(dir)
      const name = frontmatterName || baseName

      skills.push({
        relPath,
        name,
        description: frontmatterDesc,
      })
    }

    return {
      tempDir,
      skills,
    }
  } catch (error) {
    // Clean up temporary clone on failure
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw error
  }
}

/**
 * Cancel a git preview session and clean up the temporary clone directory.
 */
export async function cancelGitPreview(tempDir: string): Promise<void> {
  if (!isSafeTempCloneDir(tempDir)) return
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

/**
 * Confirm and install selected skills from a previewed temporary clone.
 */
export async function confirmGitInstall(
  options: GitConfirmInstallOptions,
): Promise<GitConfirmInstallResult> {
  const { repoUrl, tempDir, items, target = 'user', cwd } = options

  if (!isSafeTempCloneDir(tempDir) || !existsSync(tempDir)) {
    throw new GitInstallInputError('Invalid or expired temporary clone directory')
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new GitInstallInputError('No skills selected for installation')
  }

  // Get repository HEAD commit revision
  let revision: string | null = null
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim()
  } catch {
    revision = null
  }

  // Central store setup
  const centralSkillsDir = options.centralSkillsDir ?? getCentralSkillsDir()
  const centralDbPath = options.centralDbPath ?? getCentralDbPath()
  mkdirSync(centralSkillsDir, { recursive: true })
  const store = new CentralSkillStore(centralDbPath, true)

  // Target deploy directory setup
  let baseDeployRoot: string
  if (target === 'project') {
    const projectRoot = findProjectRoot(cwd ?? process.cwd())
    baseDeployRoot = join(projectRoot, '.agents', 'skills')
  } else {
    const agentsHome = options.agentsHome ?? join(process.env.DSH_AGENTS_HOME ?? join(process.env.USERPROFILE || process.env.HOME || '', '.agents'))
    baseDeployRoot = join(agentsHome, 'skills')
  }
  mkdirSync(baseDeployRoot, { recursive: true })

  const installed: InstalledGitSkill[] = []

  try {
    for (const item of items) {
      const sourceDir = resolve(tempDir, item.relPath)
      // Path traversal security check
      if (!sourceDir.startsWith(resolve(tempDir))) {
        continue
      }
      if (!existsSync(join(sourceDir, 'SKILL.md'))) {
        continue
      }

      const installName = item.name.trim() || basename(sourceDir)
      if (!installName || installName === '.' || installName === '..') {
        continue
      }

      // Read description
      let description: string | null = null
      try {
        const content = readFileSync(join(sourceDir, 'SKILL.md'), 'utf8')
        const fm = parseFrontmatter(content)
        if (fm.description?.trim()) description = fm.description.trim()
      } catch {
        // ignore
      }

      // 1. Stage the skill, then swap it into the central store in one rename:
      // an interrupted copy never leaves a half-written skill behind.
      const centralPath = join(centralSkillsDir, installName)
      const centralStage = stagedPathFor(centralPath)
      rmSync(centralStage, { recursive: true, force: true })
      try {
        cpSync(sourceDir, centralStage, { recursive: true })
      } catch (error) {
        rmSync(centralStage, { recursive: true, force: true })
        throw error
      }
      discardPrevious(swapSkillDir(centralStage, centralPath))
      const contentHash = hashSkillDir(centralPath)

      // Upsert into central database
      const centralRecord = store.upsertSkill({
        name: installName,
        description,
        sourceType: 'git',
        sourceRef: repoUrl,
        sourceRefResolved: normalizeRepoUrl(repoUrl),
        sourceSubpath: item.relPath === '.' ? null : item.relPath,
        sourceRevision: revision,
        remoteRevision: revision,
        centralPath,
        contentHash,
        updateStatus: 'up_to_date',
      })

      // 2. Deploy to target directory (user global ~/.agents/skills or project .agents/skills)
      const installedPath = join(baseDeployRoot, installName)
      const deployStage = stagedPathFor(installedPath)
      rmSync(deployStage, { recursive: true, force: true })
      try {
        cpSync(sourceDir, deployStage, { recursive: true })
        discardPrevious(swapSkillDir(deployStage, installedPath))
      } catch (error) {
        rmSync(deployStage, { recursive: true, force: true })
        throw error
      }

      // Record target in skill_targets if record exists
      if (centralRecord?.id) {
        store.upsertSkillTarget({
          skillId: centralRecord.id,
          tool: target === 'project' ? 'project' : 'agents',
          targetPath: installedPath,
          sourceHash: contentHash,
        })
      }

      installed.push({
        name: installName,
        installedPath,
        centralPath,
      })
    }
  } finally {
    // Always clean up temp clone directory
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    store.close()
  }

  return {
    ok: true,
    installed,
  }
}

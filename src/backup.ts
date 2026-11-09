/**
 * Backups of the skill library as a plain git repository.
 *
 * The central library (`~/.agents/skills-manager/skills`) is just a directory of skill
 * folders, so a git repository over it is the cheapest durable backup there is:
 * every snapshot is a commit, history is inspectable with ordinary git, and a
 * remote makes it a copy on another machine. There is deliberately no custom
 * merge engine here — when a push is rejected because the remote moved, this
 * reports that state and stops. Guessing at a three-way merge across skill
 * trees is the one thing that can silently lose both sides' work, and an
 * operator-visible "diverged" is recoverable where a bad auto-merge is not.
 *
 * Everything runs through the `git` binary rather than a library binding: the
 * user's credentials, proxy, and SSH setup already apply to it, which is the
 * whole point of backing up to a remote they configured themselves.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** How the library's git repository relates to its remote. */
export interface BackupStatus {
  /** Whether the library directory is a git repository yet. */
  isRepo: boolean
  /** Configured remote URL, if any. */
  remoteUrl: string | null
  /** Whether there are uncommitted changes in the library. */
  hasChanges: boolean
  /** Number of skill directories with uncommitted changes. */
  changedSkillCount: number
  /** Commits ahead of the remote. */
  ahead: number
  /** Commits behind the remote. */
  behind: number
  /** Last commit subject, if any. */
  lastCommit: string | null
  /** ISO timestamp of the last commit. */
  lastCommitTime: string | null
  /**
   * Relationship health: `healthy`, `no_repo`, `no_remote`, `no_upstream`,
   * `diverged`, or `error`. `diverged` means both sides moved and this plugin
   * will not merge them.
   */
  health: 'healthy' | 'no_repo' | 'no_remote' | 'no_upstream' | 'diverged' | 'error'
  /** Last error text, when `health` is `error`. */
  error?: string
}

/** One restorable snapshot. */
export interface BackupSnapshot {
  /** Tag name, e.g. `dsh-skills-20261104-201500`. */
  tag: string
  /** Commit the tag points at (short). */
  commit: string
  /** Commit subject. */
  message: string
  /** Commit timestamp in milliseconds. */
  timestamp: number
}

/** Identity used for commits made by this plugin. */
const COMMIT_NAME = 'dsh-skill-manager'
const COMMIT_EMAIL = 'dsh-skill-manager@localhost'

/** Environment every git invocation runs with: never prompt, never hang. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: COMMIT_NAME,
    GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
    GIT_COMMITTER_NAME: COMMIT_NAME,
    GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
  }
}

/**
 * Run one git command in the library directory.
 * @param cwd - repository directory.
 * @param args - git arguments (without the leading `git`).
 * @param timeoutMs - hard timeout.
 * @returns stdout and stderr.
 */
async function git(cwd: string, args: string[], timeoutMs = 60000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, timeout: timeoutMs, env: gitEnv(), maxBuffer: 8 * 1024 * 1024 })
}

/** Whether a directory is the root of a git work tree. */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/**
 * Skill directories with uncommitted changes.
 *
 * Reported by skill rather than by file because that is the unit a person
 * reasons about: "three skills have unbacked changes" says something, "eleven
 * modified files" does not.
 * @param dir - repository directory.
 * @returns the distinct top-level directory names touched.
 */
async function changedSkillDirs(dir: string): Promise<string[]> {
  try {
    const { stdout } = await git(dir, ['status', '--porcelain', '--untracked-files=normal'])
    const names = new Set<string>()
    for (const line of stdout.split('\n')) {
      const path = line.slice(3).trim()
      if (path === '') continue
      // Rename lines carry `old -> new`; the destination is what exists now.
      const target = path.includes(' -> ') ? path.split(' -> ')[1]! : path
      const top = target.split('/')[0]
      if (top !== undefined && top !== '' && top !== '.git') names.add(top)
    }
    return [...names].sort()
  } catch {
    return []
  }
}

/**
 * Bring a skill directory into the repository's ignore list, so an oversized
 * skill stays on disk without failing every later backup.
 *
 * The block is rewritten as a whole (delimited comments) rather than appended,
 * so repeating a backup cannot grow the file.
 * @param dir - repository directory.
 * @param names - skill directory names to exclude.
 */
async function writeManagedIgnores(dir: string, names: readonly string[]): Promise<void> {
  const begin = '# dsh-skill-manager: oversized skills (not backed up)'
  const end = '# dsh-skill-manager: end'
  // Read whatever is there, drop a previous managed block, keep the rest.
  let existing = ''
  try {
    existing = readFileSync(join(dir, '.gitignore'), 'utf8')
  } catch {
    existing = ''
  }
  const kept = existing
    .replace(new RegExp(`${begin}[\\s\\S]*?${end}\\n?`, 'gu'), '')
    .trimEnd()
  const block = names.length === 0
    ? ''
    : `${begin}\n${names.map((name) => `/${name}/`).join('\n')}\n${end}\n`
  const next = [kept, block].filter((part) => part !== '').join('\n')
  writeFileSync(join(dir, '.gitignore'), next === '' ? '' : `${next}\n`, 'utf8')
}

/** Skills larger than this are not backed up (matching the desktop app's cap). */
export const MAX_SKILL_BYTES = 100 * 1024 * 1024

/**
 * Skill directories that exceed the backup size cap.
 * @param dir - library directory.
 * @returns names of oversized skills.
 */
export function oversizedSkills(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const oversized: string[] = []
  for (const name of entries) {
    if (name === '.git' || name.startsWith('.')) continue
    const path = join(dir, name)
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    let total = 0
    const walk = (current: string): void => {
      let children: string[]
      try {
        children = readdirSync(current)
      } catch {
        return
      }
      for (const child of children) {
        const childPath = join(current, child)
        let stat
        try {
          stat = statSync(childPath)
        } catch {
          continue
        }
        if (stat.isDirectory()) walk(childPath)
        else total += stat.size
      }
    }
    walk(path)
    if (total > MAX_SKILL_BYTES) oversized.push(name)
  }
  return oversized.sort()
}

/**
 * Read the repository's backup state.
 * @param dir - library directory.
 * @returns the status the panel shows.
 */
export async function backupStatus(dir: string): Promise<BackupStatus> {
  const empty: BackupStatus = {
    isRepo: false,
    remoteUrl: null,
    hasChanges: false,
    changedSkillCount: 0,
    ahead: 0,
    behind: 0,
    lastCommit: null,
    lastCommitTime: null,
    health: 'no_repo',
  }
  if (!isGitRepo(dir)) return empty

  try {
    let remoteUrl: string | null = null
    try {
      const { stdout } = await git(dir, ['remote', 'get-url', 'origin'])
      remoteUrl = stdout.trim() || null
    } catch {
      remoteUrl = null
    }

    const changed = await changedSkillDirs(dir)
    // A repository that exists but has no commit yet is a normal first-run
    // state, not an error: report it with an empty history.
    let subject: string | null = null
    let timestamp: string | null = null
    try {
      const last = await git(dir, ['log', '-1', '--format=%s%x00%cI'])
      const [parsedSubject, parsedTime] = last.stdout.trim().split('\0')
      subject = parsedSubject ?? null
      timestamp = parsedTime ?? null
    } catch {
      subject = null
      timestamp = null
    }
    let ahead = 0
    let behind = 0
    let health: BackupStatus['health'] = remoteUrl === null ? 'no_remote' : 'healthy'
    if (remoteUrl !== null) {
      try {
        // `--left-right --count` prints "<ahead>\t<behind>" for the upstream.
        const { stdout } = await git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
        const [behindCount, aheadCount] = stdout.trim().split(/\s+/).map(Number)
        ahead = Number.isFinite(aheadCount) ? aheadCount! : 0
        behind = Number.isFinite(behindCount) ? behindCount! : 0
        if (ahead > 0 && behind > 0) health = 'diverged'
      } catch {
        // No upstream configured yet: a repository that has never been pushed.
        health = 'no_upstream'
      }
    }

    return {
      isRepo: true,
      remoteUrl,
      hasChanges: changed.length > 0,
      changedSkillCount: changed.length,
      ahead,
      behind,
      lastCommit: subject,
      lastCommitTime: timestamp,
      health,
    }
  } catch (error) {
    return { ...empty, isRepo: true, health: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Create the repository if it does not exist yet.
 *
 * `.gitignore` starts with the plugin's own transient files, so a stray staging
 * directory or a trashed copy never enters history.
 * @param dir - library directory.
 */
export async function initBackupRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  if (isGitRepo(dir)) return
  await git(dir, ['init', '--initial-branch=main', '--quiet'])
  writeFileSync(
    join(dir, '.gitignore'),
    [
      '# Never backed up: transient staging trees and trashed copies.',
      '.*.staged-*',
      '*.old-*',
      '.trash/',
      '',
    ].join('\n'),
    'utf8',
  )
}

/** Tag prefix for user-visible snapshots (an auto commit gets none). */
const TAG_PREFIX = 'dsh-skills-'

/**
 * Commit everything and, when asked, tag it as a snapshot.
 * @param dir - library directory.
 * @param message - commit subject.
 * @param options.snapshot - also create a restorable tag (a manual backup).
 * @param options.remote - push after committing.
 * @returns the commit sha, the tag when one was made, and whether a push ran.
 */
export async function backupCommit(
  dir: string,
  message: string,
  options: { snapshot?: boolean; remote?: boolean } = {},
): Promise<{ committed: boolean; commit: string | null; tag: string | null; pushed: boolean; error?: string }> {
  if (!isGitRepo(dir)) throw new Error('the library is not a git repository yet')
  const oversized = oversizedSkills(dir)
  await writeManagedIgnores(dir, oversized)
  await git(dir, ['add', '-A'])

  let committed = false
  // Ask whether anything is staged rather than parsing git's message: with
  // `--quiet` the message is suppressed, and "nothing to commit" is a normal
  // no-op the caller must not see as a failure.
  const staged = await git(dir, ['diff', '--cached', '--quiet']).then(() => false).catch(() => true)
  if (staged) {
    await git(dir, ['commit', '--quiet', '-m', message])
    committed = true
  }

  const { stdout: sha } = await git(dir, ['rev-parse', 'HEAD'])
  const commit = sha.trim()

  let tag: string | null = null
  if (options.snapshot === true) {
    const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '').replace('T', '-')
    tag = `${TAG_PREFIX}${stamp}`
    // A repeated backup in the same second would collide; disambiguate rather
    // than fail the backup the user asked for.
    let candidate = tag
    for (let attempt = 2; ; attempt++) {
      try {
        await git(dir, ['tag', candidate, commit])
        tag = candidate
        break
      } catch {
        if (attempt > 5) throw new Error(`could not tag snapshot ${candidate}`)
        candidate = `${tag}-${attempt}`
      }
    }
  }

  let pushed = false
  if (options.remote === true) {
    try {
      await git(dir, ['push', '--quiet', 'origin', 'HEAD'], 120000)
      await git(dir, ['push', '--quiet', 'origin', '--tags'], 120000)
      pushed = true
    } catch (error) {
      return {
        committed,
        commit,
        tag,
        pushed: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { committed, commit, tag, pushed }
}

/**
 * Every snapshot tag, newest first.
 * @param dir - library directory.
 * @returns the snapshots.
 */
export async function listSnapshots(dir: string): Promise<BackupSnapshot[]> {
  if (!isGitRepo(dir)) return []
  try {
    const { stdout } = await git(dir, [
      'for-each-ref',
      `refs/tags/${TAG_PREFIX}*`,
      '--format=%(refname:short)%00%(objectname:short)%00%(subject)%00%(creatordate:unix)',
      '--sort=-creatordate',
    ])
    return stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [tag, commit, message, seconds] = line.split('\0')
        return {
          tag: tag ?? '',
          commit: commit ?? '',
          message: message ?? '',
          timestamp: Number(seconds ?? 0) * 1000,
        }
      })
  } catch {
    return []
  }
}

/**
 * Restore a snapshot into the library.
 *
 * The current state is committed first, so a restore can itself be undone: the
 * alternative — checking out over uncommitted work — is the one way this
 * operation could destroy something.
 * @param dir - library directory.
 * @param tag - snapshot tag to restore.
 * @returns the safety commit created before the restore.
 */
export async function restoreSnapshot(dir: string, tag: string): Promise<{ safetyCommit: string }> {
  if (!isGitRepo(dir)) throw new Error('the library is not a git repository yet')
  const snapshots = await listSnapshots(dir)
  if (!snapshots.some((snapshot) => snapshot.tag === tag)) {
    throw new Error(`unknown snapshot ${tag}`)
  }
  const safety = await backupCommit(dir, `pre-restore safety snapshot (before ${tag})`)
  // Restore the tree wholesale, not just the files the snapshot still has:
  // `checkout <tag> -- .` leaves skills added after the snapshot on disk, which
  // is the opposite of restoring. Reading the tag's tree into the index and
  // checking it out makes the working directory match the snapshot exactly.
  await git(dir, ['read-tree', tag])
  await git(dir, ['checkout-index', '--all', '--force'])
  // Skills the snapshot does not contain are not in the index any more, but
  // their files are still on disk; prune exactly those.
  const { stdout: tracked } = await git(dir, ['ls-files'])
  const keep = new Set(tracked.split('\n').map((line) => line.split('/')[0]).filter((name) => name !== ''))
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === '.gitignore' || keep.has(name)) continue
    rmSync(join(dir, name), { recursive: true, force: true })
  }
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--quiet', '-m', `restore snapshot ${tag}`])
  return { safetyCommit: safety.commit ?? '' }
}

/** Set the remote URL (`git remote set-url`, or add it the first time). */
export async function setBackupRemote(dir: string, url: string): Promise<void> {
  if (!isGitRepo(dir)) throw new Error('the library is not a git repository yet')
  const trimmed = url.trim()
  if (trimmed === '') throw new Error('remote url is required')
  // A URL is user-configured, so a local path or a network share is a
  // legitimate backup target. What is never legitimate is a transport that runs
  // a command (`ext::`), or an argument that git would read as an option.
  if (/^ext::/iu.test(trimmed) || trimmed.startsWith('-')) {
    throw new Error('remote url must not use a command transport or start with "-"')
  }
  if (!/^(?:https?:\/\/|git@|ssh:\/\/|file:\/\/|\/|[A-Za-z]:[\\/])/u.test(trimmed)) {
    throw new Error('remote url must be an https, ssh, git@, file URL or an absolute path')
  }
  try {
    await git(dir, ['remote', 'set-url', 'origin', trimmed])
  } catch {
    await git(dir, ['remote', 'add', 'origin', trimmed])
  }
}

/** Fetch the remote and fast-forward when that is all that is needed. */
export async function pullBackup(dir: string): Promise<{ pulled: boolean; diverged: boolean }> {
  if (!isGitRepo(dir)) throw new Error('the library is not a git repository yet')
  await git(dir, ['fetch', '--quiet', 'origin'], 120000)
  try {
    await git(dir, ['merge', '--ff-only', '--quiet', 'origin/HEAD'], 60000)
    return { pulled: true, diverged: false }
  } catch {
    // A non-fast-forward is reported, never forced: this plugin has no merge
    // strategy for divergent skill trees and must not invent one.
    return { pulled: false, diverged: true }
  }
}

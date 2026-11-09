import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backupCommit,
  backupStatus,
  initBackupRepo,
  isGitRepo,
  listSnapshots,
  restoreSnapshot,
  setBackupRemote,
  oversizedSkills,
} from '../src/backup.ts'

describe('backup repository', () => {
  let dir: string

  function writeSkill(name: string, content: string): void {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'SKILL.md'), content)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-backup-'))
    writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports no_repo before the repository exists', async () => {
    const status = await backupStatus(dir)
    expect(status.isRepo).toBe(false)
    expect(status.health).toBe('no_repo')
  })

  it('creates a repository with an ignore file for transient trees', async () => {
    await initBackupRepo(dir)
    expect(isGitRepo(dir)).toBe(true)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.trash/')
  })

  it('does not reinitialize an existing repository', async () => {
    await initBackupRepo(dir)
    await backupCommit(dir, 'first')
    await initBackupRepo(dir)
    const status = await backupStatus(dir)
    expect(status.lastCommit).toBe('first')
  })

  it('commits, then reports no pending changes', async () => {
    await initBackupRepo(dir)
    const first = await backupCommit(dir, 'first')
    expect(first.committed).toBe(true)
    expect(first.commit).toMatch(/^[0-9a-f]{40}$/u)

    const status = await backupStatus(dir)
    expect(status.hasChanges).toBe(false)
    expect(status.health).toBe('no_remote')
  })

  it('counts changed skill directories, not changed files', async () => {
    await initBackupRepo(dir)
    await backupCommit(dir, 'first')
    writeSkill('alpha', '---\nname: alpha\ndescription: changed\n---\n')
    writeSkill('beta', '---\nname: beta\ndescription: b\n---\n')
    const status = await backupStatus(dir)
    expect(status.changedSkillCount).toBe(2)
    expect(status.hasChanges).toBe(true)
  })

  it('treats an unchanged commit as a no-op rather than an error', async () => {
    await initBackupRepo(dir)
    await backupCommit(dir, 'first')
    const second = await backupCommit(dir, 'second')
    expect(second.committed).toBe(false)
  })

  it('tags a manual snapshot and lists it', async () => {
    await initBackupRepo(dir)
    const result = await backupCommit(dir, 'snapshot', { snapshot: true })
    expect(result.tag).toMatch(/^dsh-skills-\d{8}-\d{6}/u)
    const snapshots = await listSnapshots(dir)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.tag).toBe(result.tag)
    expect(snapshots[0]!.message).toBe('snapshot')
  })

  it('restores a snapshot after committing the current state first', async () => {
    await initBackupRepo(dir)
    await backupCommit(dir, 'original', { snapshot: true })
    const tag = (await listSnapshots(dir))[0]!.tag

    writeSkill('alpha', '---\nname: alpha\ndescription: edited\n---\n')
    writeSkill('gamma', '---\nname: gamma\ndescription: g\n---\n')
    await backupCommit(dir, 'edit')

    const { safetyCommit } = await restoreSnapshot(dir, tag)
    expect(safetyCommit).toMatch(/^[0-9a-f]{40}$/u)
    // The restore put the snapshot's content back and removed the added skill.
    expect(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8')).toContain('description: a')
    expect(existsSync(join(dir, 'gamma'))).toBe(false)
    // And the pre-restore state is reachable, so the restore itself is undoable.
    const log = execFileSync('git', ['show', '--name-only', '--format=', safetyCommit], { cwd: dir, encoding: 'utf8' })
    expect(log).toContain('gamma/SKILL.md')
  })

  it('refuses an unknown snapshot tag', async () => {
    await initBackupRepo(dir)
    await backupCommit(dir, 'first')
    await expect(restoreSnapshot(dir, 'dsh-skills-nope')).rejects.toThrow(/unknown snapshot/u)
  })

  it('rejects a remote URL git would execute as a command', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'dsh-remote-url-'))
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', remote])
    await initBackupRepo(dir)
    await expect(setBackupRemote(dir, 'ext::sh -c touch% /tmp/pwn')).rejects.toThrow(/command transport/u)
    await expect(setBackupRemote(dir, '--upload-pack=touch /tmp/pwn')).rejects.toThrow(/command transport/u)
    // A local path is a legitimate backup target (an external drive).
    await setBackupRemote(dir, remote)
    expect((await backupStatus(dir)).remoteUrl).toBe(remote)
    rmSync(remote, { recursive: true, force: true })
  })

  it('accepts and records a supported remote URL', async () => {
    await initBackupRepo(dir)
    await setBackupRemote(dir, 'https://example.com/me/skills.git')
    const status = await backupStatus(dir)
    expect(status.remoteUrl).toBe('https://example.com/me/skills.git')
    expect(status.health).toBe('no_upstream')
  })

  it('reports a diverged repository instead of merging it', async () => {
    // A bare remote and two clones: each side gets a commit the other lacks.
    const remote = mkdtempSync(join(tmpdir(), 'dsh-remote-'))
    execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet', remote])
    const other = mkdtempSync(join(tmpdir(), 'dsh-other-'))

    await initBackupRepo(dir)
    await setBackupRemote(dir, remote)
    await backupCommit(dir, 'base', { remote: true })
    execFileSync('git', ['push', '--quiet', '--set-upstream', 'origin', 'HEAD'], { cwd: dir })

    execFileSync('git', ['clone', '--quiet', remote, other])
    execFileSync('git', ['config', 'user.email', 'x@y.z'], { cwd: other })
    execFileSync('git', ['config', 'user.name', 'x'], { cwd: other })
    writeFileSync(join(other, 'beta.md'), 'remote side')
    execFileSync('git', ['add', '-A'], { cwd: other })
    execFileSync('git', ['commit', '--quiet', '-m', 'remote change'], { cwd: other })
    execFileSync('git', ['push', '--quiet'], { cwd: other })

    writeSkill('gamma', '---\nname: gamma\ndescription: g\n---\n')
    await backupCommit(dir, 'local change')
    execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: dir })

    const status = await backupStatus(dir)
    expect(status.health).toBe('diverged')
    expect(status.ahead).toBeGreaterThan(0)
    expect(status.behind).toBeGreaterThan(0)

    rmSync(remote, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  })

  it('excludes a skill that exceeds the backup size cap', async () => {
    await initBackupRepo(dir)
    // A sparse 101 MB file: over the cap without writing 101 MB of data.
    mkdirSync(join(dir, 'huge'), { recursive: true })
    writeFileSync(join(dir, 'huge', 'SKILL.md'), '---\nname: huge\ndescription: h\n---\n')
    const big = join(dir, 'huge', 'blob.bin')
    execFileSync('truncate', ['-s', String(101 * 1024 * 1024), big])

    expect(oversizedSkills(dir)).toEqual(['huge'])
    await backupCommit(dir, 'with oversized skill')
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8')
    expect(ignore).toContain('# dsh-skill-manager: oversized skills')
    expect(ignore).toContain('/huge/')
    const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' })
    expect(tracked).not.toContain('huge/blob.bin')
    expect(tracked).toContain('alpha/SKILL.md')
  })
})

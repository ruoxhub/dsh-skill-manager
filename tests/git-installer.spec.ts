import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cancelGitPreview,
  collectSkillDirs,
  confirmGitInstall,
  GitInstallInputError,
  isSafeTempCloneDir,
  previewGitInstall,
  sweepStalePreviewDirs,
} from '../src/git-installer.ts'
import { CentralSkillStore } from '../src/central-store.ts'

describe('git-installer', () => {
  let tempBase: string
  let sampleRepoDir: string
  let centralRoot: string
  let agentsHome: string

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'dsh-git-installer-test-'))
    sampleRepoDir = join(tempBase, 'sample-repo')
    centralRoot = join(tempBase, 'central')
    agentsHome = join(tempBase, 'agents')

    mkdirSync(sampleRepoDir, { recursive: true })
    mkdirSync(centralRoot, { recursive: true })
    mkdirSync(agentsHome, { recursive: true })

    // Initialize sample Git repository
    execFileSync('git', ['init'], { cwd: sampleRepoDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sampleRepoDir })
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: sampleRepoDir })

    // Add root skill
    const skillADir = join(sampleRepoDir, 'skill-alpha')
    mkdirSync(skillADir, { recursive: true })
    writeFileSync(
      join(skillADir, 'SKILL.md'),
      '---\nname: skill-alpha\ndescription: Alpha skill description\n---\n# Alpha Skill\n',
      'utf8',
    )

    // Add nested skill
    const skillBDir = join(sampleRepoDir, 'skills', 'skill-beta')
    mkdirSync(skillBDir, { recursive: true })
    writeFileSync(
      join(skillBDir, 'SKILL.md'),
      '---\nname: skill-beta\ndescription: Beta skill description\n---\n# Beta Skill\n',
      'utf8',
    )

    // Commit files
    execFileSync('git', ['add', '.'], { cwd: sampleRepoDir })
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: sampleRepoDir })
  })

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('validates safe temporary clone directories', () => {
    const valid = join(tmpdir(), 'dsh-git-skill-123456')
    expect(isSafeTempCloneDir(valid)).toBe(true)

    expect(isSafeTempCloneDir('')).toBe(false)
    expect(isSafeTempCloneDir('/etc/passwd')).toBe(false)
    expect(isSafeTempCloneDir(join(tmpdir(), 'arbitrary-dir'))).toBe(false)
  })

  it('collectSkillDirs recursively finds folders with SKILL.md', () => {
    const found = collectSkillDirs(sampleRepoDir)
    expect(found.length).toBe(2)
    expect(found.some((p) => p.includes('skill-alpha'))).toBe(true)
    expect(found.some((p) => p.includes('skill-beta'))).toBe(true)
  })

  it('previewGitInstall clones and extracts skill metadata', async () => {
    const preview = await previewGitInstall(sampleRepoDir)
    try {
      expect(preview.tempDir).toBeDefined()
      expect(preview.skills.length).toBe(2)

      const alpha = preview.skills.find((s) => s.name === 'skill-alpha')
      expect(alpha).toBeDefined()
      expect(alpha?.description).toBe('Alpha skill description')
      expect(alpha?.relPath).toBe('skill-alpha')

      const beta = preview.skills.find((s) => s.name === 'skill-beta')
      expect(beta).toBeDefined()
      expect(beta?.description).toBe('Beta skill description')
      expect(beta?.relPath).toBe('skills/skill-beta')
    } finally {
      await cancelGitPreview(preview.tempDir)
    }
  })

  it('cancelGitPreview cleans up temp dir safely', async () => {
    const preview = await previewGitInstall(sampleRepoDir)
    expect(existsSync(preview.tempDir)).toBe(true)

    await cancelGitPreview(preview.tempDir)
    expect(existsSync(preview.tempDir)).toBe(false)
  })

  it('confirmGitInstall installs to central store and user agentsHome', async () => {
    const preview = await previewGitInstall(sampleRepoDir)
    const centralDbPath = join(centralRoot, 'skills-manager.db')
    const centralSkillsDir = join(centralRoot, 'skills')

    const res = await confirmGitInstall({
      repoUrl: sampleRepoDir,
      tempDir: preview.tempDir,
      items: [
        { relPath: 'skill-alpha', name: 'skill-alpha' },
        { relPath: 'skills/skill-beta', name: 'my-custom-beta' },
      ],
      target: 'user',
      agentsHome,
      centralDbPath,
      centralSkillsDir,
    })

    expect(res.ok).toBe(true)
    expect(res.installed.length).toBe(2)

    // Temp dir must be cleaned up
    expect(existsSync(preview.tempDir)).toBe(false)

    // Check central store files
    const centralAlpha = join(centralSkillsDir, 'skill-alpha', 'SKILL.md')
    expect(existsSync(centralAlpha)).toBe(true)
    expect(readFileSync(centralAlpha, 'utf8')).toContain('Alpha skill description')

    const centralBeta = join(centralSkillsDir, 'my-custom-beta', 'SKILL.md')
    expect(existsSync(centralBeta)).toBe(true)

    // Check deployed files in agentsHome
    const deployedAlpha = join(agentsHome, 'skills', 'skill-alpha', 'SKILL.md')
    expect(existsSync(deployedAlpha)).toBe(true)

    const deployedBeta = join(agentsHome, 'skills', 'my-custom-beta', 'SKILL.md')
    expect(existsSync(deployedBeta)).toBe(true)

    // Check database records in central store
    const store = new CentralSkillStore(centralDbPath)
    try {
      const skills = store.getAllSkills()
      expect(skills.length).toBe(2)

      const dbAlpha = store.getSkillByName('skill-alpha')
      expect(dbAlpha).toBeDefined()
      expect(dbAlpha?.source_type).toBe('git')
      expect(dbAlpha?.source_ref).toBe(sampleRepoDir)
      expect(dbAlpha?.source_subpath).toBe('skill-alpha')
      expect(dbAlpha?.source_revision).toBeDefined()
      expect(dbAlpha?.update_status).toBe('up_to_date')

      const dbBeta = store.getSkillByName('my-custom-beta')
      expect(dbBeta).toBeDefined()
      expect(dbBeta?.source_subpath).toBe('skills/skill-beta')

      // Check targets
      const targetsAlpha = store.getSkillTargets(dbAlpha!.id)
      expect(targetsAlpha.length).toBe(1)
      expect(targetsAlpha[0].tool).toBe('agents')
      expect(targetsAlpha[0].target_path).toBe(join(agentsHome, 'skills', 'skill-alpha'))
    } finally {
      store.close()
    }
  })

  it('rejects repositories without valid SKILL.md', async () => {
    const emptyRepoDir = join(tempBase, 'empty-repo')
    mkdirSync(emptyRepoDir, { recursive: true })
    execFileSync('git', ['init'], { cwd: emptyRepoDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: emptyRepoDir })
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: emptyRepoDir })
    writeFileSync(join(emptyRepoDir, 'README.md'), '# Empty Repo\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: emptyRepoDir })
    execFileSync('git', ['commit', '-m', 'Init'], { cwd: emptyRepoDir })

    await expect(previewGitInstall(emptyRepoDir)).rejects.toThrow(
      /Repository contains no valid skills/,
    )
  })

  it('throws a descriptive error when git clone fails', async () => {
    await expect(
      previewGitInstall('file:///non-existent-repo-path-123456789'),
    ).rejects.toThrow(/Git clone failed:/)
  })

  it('reports a client-side input error for an unsafe or missing preview dir', async () => {
    await expect(
      confirmGitInstall({
        repoUrl: 'https://github.com/example/repo',
        tempDir: join(tempBase, 'not-a-preview-dir'),
        items: [{ relPath: 'skill-alpha', name: 'skill-alpha' }],
      }),
    ).rejects.toBeInstanceOf(GitInstallInputError)
  })

  it('sweeps only stale, sandbox-shaped preview dirs', () => {
    const stale = join(tmpdir(), `dsh-git-skill-${Date.now()}-sweep-stale`)
    const fresh = join(tmpdir(), `dsh-git-skill-${Date.now()}-sweep-fresh`)
    const unrelated = join(tmpdir(), `not-a-preview-${Date.now()}`)
    for (const dir of [stale, fresh, unrelated]) mkdirSync(dir, { recursive: true })

    try {
      // Rewind the stale one past the default one-hour age gate.
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      utimesSync(stale, old, old)

      sweepStalePreviewDirs()

      expect(existsSync(stale)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      expect(existsSync(unrelated)).toBe(true)
    } finally {
      for (const dir of [stale, fresh, unrelated]) rmSync(dir, { recursive: true, force: true })
    }
  })
})

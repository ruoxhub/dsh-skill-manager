import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CentralSkillStore } from '../src/central-store.ts'
import { checkAllSkills, checkOneSkill } from '../src/remote-resolver.ts'

/**
 * A monorepo publishing two skills, with one more commit that touches only the
 * other skill — the case that used to mark every skill in the repository as
 * having an update.
 */
function makeMonorepo(): { repo: string; firstRev: string } {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-monorepo-'))
  const git = (args: string[]): string => execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  git(['init', '--initial-branch=main', '--quiet'])
  mkdirSync(join(repo, 'skills', 'alpha'), { recursive: true })
  mkdirSync(join(repo, 'skills', 'beta'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: A\n---\n')
  writeFileSync(join(repo, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: B\n---\n')
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'initial'])
  const firstRev = git(['rev-parse', 'HEAD']).trim()

  // Only beta changes: alpha's subtree is byte-identical at the new HEAD.
  writeFileSync(join(repo, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: B changed\n---\n')
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'touch beta'])
  return { repo, firstRev }
}

describe('monorepo update checks', () => {
  let store: CentralSkillStore
  let fixture: { repo: string; firstRev: string }
  const skillsDir = mkdtempSync(join(tmpdir(), 'dsh-monorepo-central-'))

  beforeEach(() => {
    fixture = makeMonorepo()
    store = new CentralSkillStore(':memory:', true)
    for (const [id, name, subpath] of [['s-alpha', 'alpha', 'skills/alpha'], ['s-beta', 'beta', 'skills/beta']] as const) {
      store.upsertSkill({
        name,
        sourceType: 'git',
        sourceRef: fixture.repo,
        sourceSubpath: subpath,
        sourceBranch: 'main',
        sourceRevision: fixture.firstRev,
        remoteRevision: fixture.firstRev,
        centralPath: join(skillsDir, name),
      })
    }
  })

  afterEach(() => {
    store.close()
    rmSync(fixture.repo, { recursive: true, force: true })
  })

  it('reports only the skill whose subdirectory actually changed', async () => {
    const summary = await checkAllSkills(store, 2)
    const byName = new Map(summary.results.map((result) => [result.name, result.updateStatus]))
    expect(byName.get('beta')).toBe('update_available')
    expect(byName.get('alpha')).toBe('up_to_date')
  })

  it('keeps reporting an update when the installed subtree is not comparable', async () => {
    // A revision that does not exist cannot be compared, and the safe direction
    // is to offer the update rather than hide it.
    const skill = { ...store.getSkillByName('alpha')!, source_revision: 'f'.repeat(40) }
    const result = await checkOneSkill(skill, store)
    expect(result.updateStatus).toBe('update_available')
  })

  it('marks a repository-root install by its HEAD, not by a subtree', async () => {
    const rootSkill = store.upsertSkill({
      name: 'root-install',
      sourceType: 'git',
      sourceRef: fixture.repo,
      sourceRevision: fixture.firstRev,
      sourceBranch: 'main',
      centralPath: join(skillsDir, 'root-install'),
    })!
    const result = await checkOneSkill(rootSkill, store)
    expect(result.updateStatus).toBe('update_available')
  })
})

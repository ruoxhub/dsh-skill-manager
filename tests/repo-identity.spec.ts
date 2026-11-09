import { describe, expect, it } from 'vitest'
import {
  groupSkillsByRepo,
  installedRepoByName,
  normalizeRepoUrl,
  repoLabel,
} from '../src/repo-identity.ts'

describe('normalizeRepoUrl', () => {
  it('collapses the same repository typed four ways to one identity', () => {
    const expected = 'github.com/acme/skills'
    expect(normalizeRepoUrl('https://github.com/acme/skills')).toBe(expected)
    expect(normalizeRepoUrl('https://github.com/acme/skills.git')).toBe(expected)
    expect(normalizeRepoUrl('https://github.com/acme/skills/')).toBe(expected)
    expect(normalizeRepoUrl('git@github.com:acme/skills.git')).toBe(expected)
    expect(normalizeRepoUrl('https://GitHub.com/Acme/Skills.git')).toBe(expected)
  })

  it('drops a branch or ref suffix: a revision is not a repository', () => {
    expect(normalizeRepoUrl('https://github.com/acme/skills.git#main')).toBe('github.com/acme/skills')
    expect(normalizeRepoUrl('https://github.com/acme/skills?ref=v1.2.0')).toBe('github.com/acme/skills')
  })

  it('keeps a deeper path, so two repos of one owner stay distinct', () => {
    expect(normalizeRepoUrl('https://gitlab.com/group/sub/repo.git')).toBe('gitlab.com/group/sub/repo')
  })

  it('returns null when there is no repository path to identify', () => {
    expect(normalizeRepoUrl('')).toBeNull()
    expect(normalizeRepoUrl('   ')).toBeNull()
    expect(normalizeRepoUrl(null)).toBeNull()
    expect(normalizeRepoUrl(undefined)).toBeNull()
    expect(normalizeRepoUrl('https://github.com')).toBeNull()
  })

  it('labels a repo by its last two path segments', () => {
    expect(repoLabel('github.com/acme/skills')).toBe('acme/skills')
    expect(repoLabel('gitlab.com/group/sub/repo')).toBe('sub/repo')
    expect(repoLabel('github.com/skills')).toBe('skills')
  })
})

describe('groupSkillsByRepo', () => {
  it('groups the skills of one repo into one row, ignoring the resolved-vs-raw column', () => {
    const rows = groupSkillsByRepo([
      {
        name: 'alpha',
        sourceType: 'git',
        sourceRef: 'git@github.com:acme/skills.git',
        sourceRefResolved: 'github.com/acme/skills',
        installedAt: 1_000,
      },
      {
        name: 'beta',
        sourceType: 'git',
        // An older row recorded before the resolved column was ever written.
        sourceRef: 'https://github.com/acme/skills',
        installedAt: 3_000,
      },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('github.com/acme/skills')
    expect(rows[0]?.label).toBe('acme/skills')
    expect(rows[0]?.members.map((m) => m.name)).toEqual(['alpha', 'beta'])
    expect(rows[0]?.lastInstalledAt).toBe(3_000)
  })

  it('lists one entry per skill even when the same skill is scanned twice', () => {
    const rows = groupSkillsByRepo([
      { name: 'alpha', sourceType: 'git', sourceRef: 'https://github.com/acme/skills' },
      { name: 'alpha', sourceType: 'git', sourceRef: 'https://github.com/acme/skills' },
    ])

    expect(rows[0]?.members).toHaveLength(1)
  })

  it('ignores non-git sources rather than inventing an unknown-repository row', () => {
    const rows = groupSkillsByRepo([
      { name: 'market-skill', sourceType: 'skillhub', sourceRef: 'skillhub:some-slug' },
      { name: 'local-skill' },
    ])

    expect(rows).toEqual([])
  })

  it('carries the update and check-failure flags of its members', () => {
    const rows = groupSkillsByRepo([
      { name: 'alpha', sourceType: 'git', sourceRef: 'https://github.com/acme/skills', updateStatus: 'update_available' },
      { name: 'beta', sourceType: 'git', sourceRef: 'https://github.com/acme/skills', updateStatus: 'error' },
    ])

    expect(rows[0]?.hasUpdate).toBe(true)
    expect(rows[0]?.hasError).toBe(true)
  })

  it('orders rows by most recent install', () => {
    const rows = groupSkillsByRepo([
      { name: 'old', sourceType: 'git', sourceRef: 'https://github.com/acme/old', installedAt: 1_000 },
      { name: 'new', sourceType: 'git', sourceRef: 'https://github.com/acme/new', installedAt: 5_000 },
    ])

    expect(rows.map((r) => r.label)).toEqual(['acme/new', 'acme/old'])
  })
})

describe('installedRepoByName', () => {
  it('reports the repository a same-named skill currently belongs to', () => {
    const map = installedRepoByName([
      { name: 'Alpha', sourceType: 'git', sourceRef: 'https://github.com/acme/skills' },
    ])

    expect(map.get('alpha')).toEqual({ key: 'github.com/acme/skills', label: 'acme/skills' })
  })
})

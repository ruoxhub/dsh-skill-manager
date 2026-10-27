/**
 * List filtering rules (#1423): the search box and the workspace picker are
 * pure functions over the host payload, so they are tested without a DOM.
 */
import { describe, expect, it } from 'vitest'
import { matchRank, selectGroups } from '../src/client/skill-filter.ts'
import type { GroupPayload, SkillEntry } from '../src/client/api.ts'

function skill(name: string, description: string, extra: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name,
    description,
    provider: 'filesystem',
    level: 'user-dsh',
    path: '/work/' + name + '/SKILL.md',
    fileState: 'editable',
    modelInvocable: true,
    userInvocable: true,
    ...extra,
  }
}

function group(key: string, skills: SkillEntry[]): GroupPayload {
  return { key, title: key, hint: '', skills }
}

describe('matchRank', () => {
  it('ranks a name hit above a description hit', () => {
    expect(matchRank(skill('alpha-skill', 'plain'), 'alpha')).toBe(0)
    expect(matchRank(skill('plain', 'alpha helper'), 'alpha')).toBe(1)
  })

  it('matches case-insensitively and reports no hit as undefined', () => {
    expect(matchRank(skill('Alpha-Skill', 'x'), 'alpha')).toBe(0)
    expect(matchRank(skill('plain', 'X'), 'x')).toBe(1)
    expect(matchRank(skill('plain', 'plain'), 'nope')).toBeUndefined()
  })

  it('treats an empty needle as a match', () => {
    expect(matchRank(skill('plain', 'plain'), '')).toBe(0)
  })
})

describe('selectGroups', () => {
  const groups = [
    group('user-dsh', [
      skill('gamma-skill', 'unrelated'),
      skill('beta-skill', 'alpha related'),
      skill('alpha-skill', 'first helper'),
    ]),
    group('runtime', [skill('runtime-only', 'plugin embedded')]),
  ]

  it('returns every group in host order when neither axis is set', () => {
    const visible = selectGroups(groups, { workspace: 'all', query: '' })
    expect(visible.map(item => item.key)).toEqual(['user-dsh', 'runtime'])
    expect(visible[0].skills.map(item => item.name)).toEqual(['gamma-skill', 'beta-skill', 'alpha-skill'])
  })

  it('keeps name hits before description hits and drops non-matches', () => {
    const visible = selectGroups(groups, { workspace: 'all', query: 'alpha' })
    expect(visible.map(item => item.key)).toEqual(['user-dsh'])
    expect(visible[0].skills.map(item => item.name)).toEqual(['alpha-skill', 'beta-skill'])
  })

  it('reports no group when nothing matches', () => {
    expect(selectGroups(groups, { workspace: 'all', query: 'zzz' })).toEqual([])
  })

  it('combines the workspace axis with the query for specific workspace skills', () => {
    const mixed = [
      group('project-dsh', [
        skill('project-alpha', 'alpha project', { workspaceRoot: '/repo/one', workspaceName: 'one' }),
        skill('project-beta', 'alpha other', { workspaceRoot: '/repo/two', workspaceName: 'two' }),
        skill('global-alpha', 'alpha global'),
      ]),
    ]
    const visible = selectGroups(mixed, { workspace: '/repo/one', query: 'alpha' })
    expect(visible[0].skills.map(item => item.name)).toEqual(['project-alpha'])
  })

  it('filters skills by default user and system workspaces', () => {
    const mixed = [
      group('project-dsh', [
        skill('project-alpha', 'alpha project', { workspaceRoot: '/repo/one', workspaceName: 'one' }),
      ]),
      group('user-dsh', [
        skill('user-alpha', 'user skill', { level: 'user-dsh' }),
      ]),
      group('bundled', [
        skill('bundled-alpha', 'system skill', { level: 'bundled' }),
      ]),
    ]
    const userVisible = selectGroups(mixed, { workspace: 'user', query: '' })
    expect(userVisible.flatMap(g => g.skills.map(s => s.name))).toEqual(['user-alpha'])

    const sysVisible = selectGroups(mixed, { workspace: 'system', query: '' })
    expect(sysVisible.flatMap(g => g.skills.map(s => s.name))).toEqual(['bundled-alpha'])
  })

  it('drops empty groups without mutating the payload', () => {
    const before = JSON.stringify(groups)
    const visible = selectGroups(groups, { workspace: 'all', query: 'runtime' })
    expect(visible.map(item => item.key)).toEqual(['runtime'])
    expect(JSON.stringify(groups)).toBe(before)
  })
})

describe('selectGroups: source facet', () => {
  const groups = [
    group('project-dsh', [skill('project-skill', 'project scoped')]),
    group('user-dsh', [skill('user-skill', 'user scoped')]),
    group('bundled', [skill('bundled-skill', 'shipped')]),
  ]

  it('user ticking one source sees only that source', () => {
    // Given a payload with three source groups
    // When the user narrows to the user root only
    const visible = selectGroups(groups, { workspace: 'all', query: '', levels: ['user-dsh'] })
    // Then just that group survives
    expect(visible.map(item => item.key)).toEqual(['user-dsh'])
  })

  it('user ticking two sources sees both of them', () => {
    // Given the same three groups
    // When the user ticks two of them
    const visible = selectGroups(groups, { workspace: 'all', query: '', levels: ['user-dsh', 'bundled'] })
    // Then both are listed in host order
    expect(visible.map(item => item.key)).toEqual(['user-dsh', 'bundled'])
  })

  it('user ticking a source with no matching rows sees no group at all', () => {
    // Given the same three groups
    // When the source facet and the query cannot both be satisfied
    const visible = selectGroups(groups, { workspace: 'all', query: 'bundled', levels: ['user-dsh'] })
    // Then the empty group is dropped rather than rendered blank
    expect(visible).toEqual([])
  })
})

describe('selectGroups: status facet', () => {
  const groups = [
    group('user-dsh', [
      skill('enabled-skill', 'on'),
      skill('disabled-skill', 'off', { modelInvocable: false }),
    ]),
  ]

  it('user filtering to enabled skills sees only those', () => {
    // Given one enabled and one disabled skill
    // When the user picks the enabled facet
    const visible = selectGroups(groups, { workspace: 'all', query: '', status: 'enabled' })
    // Then only the enabled row remains
    expect(visible[0].skills.map(item => item.name)).toEqual(['enabled-skill'])
  })

  it('user filtering to disabled skills sees only those', () => {
    // Given the same pair
    // When the user picks the disabled facet
    const visible = selectGroups(groups, { workspace: 'all', query: '', status: 'disabled' })
    // Then only the disabled row remains
    expect(visible[0].skills.map(item => item.name)).toEqual(['disabled-skill'])
  })

  it('user leaving the status facet on all sees both', () => {
    // Given the same pair
    // When the facet is all
    const visible = selectGroups(groups, { workspace: 'all', query: '', status: 'all' })
    // Then both rows are listed
    expect(visible[0].skills.map(item => item.name)).toEqual(['enabled-skill', 'disabled-skill'])
  })
})

describe('selectGroups: mark facet', () => {
  const groups = [
    group('user-dsh', [
      skill('editable-skill', 'plain'),
      skill('linked-skill', 'linked out', { linked: true }),
      skill('provider-skill', 'plugin file', { fileState: 'provider-file', path: undefined }),
      skill('virtual-skill', 'no file', { fileState: 'virtual', path: undefined }),
    ]),
  ]

  it('user ticking one mark sees only rows carrying it', () => {
    // Given rows with different backing kinds
    // When the user asks for symlinked rows only
    const visible = selectGroups(groups, { workspace: 'all', query: '', marks: ['linked'] })
    // Then only the linked row remains
    expect(visible[0].skills.map(item => item.name)).toEqual(['linked-skill'])
  })

  it('user ticking two marks sees rows carrying either', () => {
    // Given the same rows
    // When the user asks for plugin-provided and fileless rows
    const visible = selectGroups(groups, { workspace: 'all', query: '', marks: ['provider-file', 'no-file'] })
    // Then both pathless kinds are listed, union rather than intersection
    expect(visible[0].skills.map(item => item.name)).toEqual(['provider-skill', 'virtual-skill'])
  })

  it('user leaving the mark facet empty sees every row', () => {
    // Given the same rows
    // When no mark is selected
    const visible = selectGroups(groups, { workspace: 'all', query: '', marks: [] })
    // Then nothing is hidden
    expect(visible[0].skills.map(item => item.name)).toEqual([
      'editable-skill',
      'linked-skill',
      'provider-skill',
      'virtual-skill',
    ])
  })
})

describe('selectGroups: facets combined', () => {
  const groups = [
    group('user-dsh', [
      skill('alpha-on', 'alpha related'),
      skill('alpha-off', 'alpha related', { modelInvocable: false }),
    ]),
    group('bundled', [skill('bundled-alpha', 'alpha related')]),
  ]

  it('user combining source, status and query sees only rows matching all three', () => {
    // Given two user rows and one bundled row sharing a term
    // When the user narrows to the user root, enabled only, searching the term
    const visible = selectGroups(groups, { workspace: 'all', query: 'alpha', levels: ['user-dsh'], status: 'enabled' })
    // Then exactly the one row satisfying every axis is left
    expect(visible.map(item => item.key)).toEqual(['user-dsh'])
    expect(visible[0].skills.map(item => item.name)).toEqual(['alpha-on'])
  })

  it('user narrowing with everything wide open still gets name hits first', () => {
    // Given a row whose name matches and one where only the description does
    const ranked = [group('user-dsh', [skill('plain', 'beta helper'), skill('beta-skill', 'unrelated')])]
    // When the query is applied with no facet narrowing
    const visible = selectGroups(ranked, { workspace: 'all', query: 'beta', levels: [], marks: [], status: 'all' })
    // Then the name hit still sorts first
    expect(visible[0].skills.map(item => item.name)).toEqual(['beta-skill', 'plain'])
  })

  it('preserves workspace partitioned groups when matching source level', () => {
    const partitionedGroups = [
      group('project-agents:/path/ws-1', [
        skill('ws1-skill', 'desc 1', { workspaceRoot: '/path/ws-1', workspaceName: 'ws-1' }),
      ]),
      group('project-agents:/path/ws-2', [
        skill('ws2-skill', 'desc 2', { workspaceRoot: '/path/ws-2', workspaceName: 'ws-2' }),
      ]),
      group('bundled', [skill('sys-skill', 'desc 3')]),
    ]
    const visible = selectGroups(partitionedGroups, {
      workspace: 'all',
      query: '',
      levels: ['project-agents'],
    })
    expect(visible.map(g => g.key)).toEqual([
      'project-agents:/path/ws-1',
      'project-agents:/path/ws-2',
    ])
  })

  it('filters out other workspace project groups when filtering by specific workspace', () => {
    const partitionedGroups = [
      group('project-agents:/path/ws-1', [
        skill('ws1-skill', 'desc 1', { workspaceRoot: '/path/ws-1', workspaceName: 'ws-1' }),
      ]),
      group('project-agents:/path/ws-2', [
        skill('ws2-skill', 'desc 2', { workspaceRoot: '/path/ws-2', workspaceName: 'ws-2' }),
      ]),
      group('bundled', [skill('sys-skill', 'desc 3')]),
    ]
    const visible = selectGroups(partitionedGroups, {
      workspace: '/path/ws-1',
      query: '',
    })
    expect(visible.map(g => g.key)).toEqual([
      'project-agents:/path/ws-1',
    ])
    expect(visible[0].skills.map(s => s.name)).toEqual(['ws1-skill'])
  })
})

/**
 * Skill center list filtering (pure, browser half): the search box, the
 * workspace picker and the source / status / mark facets are axes over the
 * same grouped payload, so the matching rules live here and stay
 * unit-testable without a DOM.
 */

import type { GroupPayload, SkillEntry } from './api.ts'

/** A row characteristic the list can narrow to. */
export type SkillMark = 'linked' | 'provider-file' | 'no-file'

/** Enabled/disabled facet; 'all' keeps both. */
export type SkillStatus = 'all' | 'enabled' | 'disabled'

/** The list tab's filter state. */
export interface SkillListFilter {
  /** Selected workspace root, or 'all' for no workspace restriction. */
  workspace: string
  /** Raw search text; trimmed and lowercased before matching. */
  query: string
  /** Source group keys to include; empty or absent includes every group. */
  levels?: readonly string[]
  /** Enabled/disabled facet; absent means both. */
  status?: SkillStatus
  /** Marks to include (any of); empty or absent includes every row. */
  marks?: readonly SkillMark[]
}

/**
 * Match rank of one skill against a lowercased needle: 0 when the name hits,
 * 1 when only the description hits, undefined when neither does. An empty
 * needle matches everything at rank 0.
 */
export function matchRank(skill: SkillEntry, needle: string): 0 | 1 | undefined {
  if (needle === '') return 0
  if (skill.name.toLowerCase().includes(needle)) return 0
  if (skill.description.toLowerCase().includes(needle)) return 1
  return undefined
}

/**
 * The marks a row carries. "Provided by plugin" and "No local file" are the
 * two halves of one classification (a file the panel cannot write versus no
 * file at all), so at most one of them ever applies; a symlinked skill is a
 * separate fact and can carry either.
 * @param skill - the row's entry.
 * @returns every mark that applies to the row.
 */
export function marksOf(skill: SkillEntry): SkillMark[] {
  const marks: SkillMark[] = []
  if (skill.fileState === 'provider-file') marks.push('provider-file')
  else if (skill.fileState === 'virtual') marks.push('no-file')
  if (skill.linked === true) marks.push('linked')
  return marks
}

/**
 * Whether a skill survives the mark facet. An empty selection keeps every row;
 * a non-empty one keeps a row carrying ANY selected mark, the same union
 * semantics the source facet uses, so ticking two boxes widens the result
 * instead of emptying it.
 */
function inMarks(skill: SkillEntry, marks: readonly SkillMark[] | undefined): boolean {
  if (marks === undefined || marks.length === 0) return true
  const carried = marksOf(skill)
  return marks.some(mark => carried.includes(mark))
}

/**
 * Whether a skill survives the enabled/disabled facet. This reads the model's
 * automatic-invocation state (the same value the row's switch shows), not the
 * user-invocable policy, so "disabled" means exactly what the switch reads.
 */
function inStatus(skill: SkillEntry, status: SkillStatus | undefined): boolean {
  if (status === undefined || status === 'all') return true
  return status === 'enabled' ? skill.modelInvocable : !skill.modelInvocable
}

/**
 * Whether a skill is a user-level global skill.
 */
export function isUserSkill(skill: SkillEntry): boolean {
  return !skill.workspaceRoot && (skill.level === 'user-agents' || skill.level === 'user-dsh' || skill.level === 'custom')
}

/**
 * Whether a skill is system bundled or runtime registered.
 */
export function isSystemSkill(skill: SkillEntry): boolean {
  return !skill.workspaceRoot && (skill.level === 'bundled' || skill.level === 'runtime')
}

/**
 * Whether a skill survives the workspace axis.
 * - 'all': matches every skill.
 * - 'user': matches only user-level global skills.
 * - 'system': matches only system bundled / runtime skills.
 * - project root: matches only skills belonging to that workspace.
 */
export function inWorkspace(skill: SkillEntry, workspace: string): boolean {
  if (workspace === 'all') return true
  if (workspace === 'user') return isUserSkill(skill)
  if (workspace === 'system') return isSystemSkill(skill)
  return skill.workspaceRoot === workspace
}

/**
 * Apply every axis to a payload's groups: the source facet drops whole groups,
 * then the workspace, status, mark and query axes narrow each one (name hits
 * ranked before description hits, stable within a rank). Empty groups are
 * dropped so the caller renders only what has content.
 * @param groups - host payload groups in host order.
 * @param filter - workspace + query + optional source / status / mark facets.
 * @returns the visible groups; the input is never mutated.
 */
export function selectGroups(groups: readonly GroupPayload[], filter: SkillListFilter): GroupPayload[] {
  const needle = filter.query.trim().toLowerCase()
  const levels = filter.levels ?? []
  return groups
    .filter((group) => {
      if (levels.length === 0) return true
      if (levels.includes(group.key)) return true
      const colonIdx = group.key.indexOf(':')
      const baseKey = colonIdx === -1 ? group.key : group.key.slice(0, colonIdx)
      return levels.includes(baseKey)
    })
    .map((group) => {
      const ranked = group.skills
        .filter(skill => inWorkspace(skill, filter.workspace)
          && inStatus(skill, filter.status)
          && inMarks(skill, filter.marks))
        .map(skill => ({ skill, rank: matchRank(skill, needle) }))
        .filter((row): row is { skill: SkillEntry; rank: 0 | 1 } => row.rank !== undefined)
      // Array.prototype.sort is stable, so equal ranks keep the host's order.
      if (needle !== '') ranked.sort((left, right) => left.rank - right.rank)
      return { ...group, skills: ranked.map(row => row.skill) }
    })
    .filter(group => group.skills.length > 0)
}

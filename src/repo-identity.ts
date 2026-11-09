/**
 * Repository identity for Git-imported skills.
 *
 * An "imported repository" is not a stored entity: it is the upstream repo that
 * one or more central-store skill rows point back at, identified by a
 * normalized clone URL. This module owns that normalization (shared by the
 * install path, which records it, and the panel, which groups by it) so the
 * same repo never shows up twice because one install used `.git` and another
 * an ssh URL.
 *
 * The rules follow upstream skills-manager's `parseGitRef`: drop the
 * `#branch` / `?ref=` suffix (one repo, one group), drop a trailing `.git` and
 * `/`, and case-fold host and path. Branch and subpath are deliberately not
 * part of the identity, so a monorepo's skills share one row.
 */

/** One central-store skill row as far as repository identity cares. */
export interface RepoSkillLike {
  name: string
  sourceType?: string
  /** Repo URL exactly as the user typed it at install time. */
  sourceRef?: string | null
  /** Normalized clone URL recorded by the installer (preferred when present). */
  sourceRefResolved?: string | null
}

/** A skill inside an imported repository row. */
export interface RepoMember {
  name: string
}

/** One imported repository, as the panel renders it. */
export interface ImportedRepo {
  /** Normalized `host/path` identity used for grouping. */
  key: string
  /** Short display form (`owner/repo`); the full key is the tooltip. */
  label: string
  members: RepoMember[]
  /** Newest member install time, or null when no row carried one. */
  lastInstalledAt: number | null
  hasUpdate: boolean
  hasError: boolean
}

/**
 * Normalize a Git repository URL to a stable `host/path` identity.
 *
 * @param raw - URL as typed by the user (https, ssh, git://, scp-like or host/path).
 * @returns The normalized identity, or null when no repository path is present.
 */
export function normalizeRepoUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  // One repo, one group: a branch or ref suffix names a revision, not a repo.
  const stripped = raw.trim().split('#')[0]?.split('?')[0] ?? ''
  if (stripped === '') return null

  let host: string
  let repoPath: string
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(stripped)
  if (schemeMatch) {
    const rest = stripped.slice(schemeMatch[0].length)
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    host = rest.slice(0, slash)
    repoPath = rest.slice(slash + 1)
  } else {
    // scp-like `git@host:owner/repo` and bare `host/owner/repo`.
    const colon = stripped.indexOf(':')
    const at = stripped.lastIndexOf('@', colon === -1 ? undefined : colon)
    const head = colon === -1 ? stripped.split('/')[0] ?? '' : stripped.slice(at + 1, colon)
    const tail = colon === -1 ? stripped.slice(head.length + 1) : stripped.slice(colon + 1)
    host = head
    repoPath = tail
  }

  host = host.replace(/^[^@]*@/u, '')
  if (host.startsWith('[')) {
    // IPv6 literal authority: keep the brackets, drop any port after `]`.
    const close = host.indexOf(']')
    host = close === -1 ? host : host.slice(0, close + 1)
  } else {
    const colonPort = host.indexOf(':')
    if (colonPort !== -1) host = host.slice(0, colonPort)
  }

  const cleanPath = repoPath
    .replace(/\/+$/u, '')
    .replace(/\.git$/iu, '')
    .replace(/\/+$/u, '')
  if (host === '' || cleanPath === '') return null
  return `${host.toLowerCase()}/${cleanPath.toLowerCase()}`
}

/**
 * Short display label for a normalized identity: the last two path segments.
 *
 * @param key - Normalized `host/path` identity.
 * @returns `owner/repo`, or the path alone when it has a single segment.
 */
export function repoLabel(key: string): string {
  const segments = key.split('/')
  const path = segments.slice(1)
  if (path.length === 0) return key
  return path.slice(-2).join('/')
}

/** The repo identity stored on one skill row, preferring the resolved column. */
function identityOf(skill: RepoSkillLike): string | null {
  return normalizeRepoUrl(skill.sourceRefResolved) ?? normalizeRepoUrl(skill.sourceRef)
}

/**
 * Group Git-sourced skills by the repository they came from.
 *
 * Only `sourceType === 'git'` rows take part: market and local installs have no
 * upstream repository to name. Non-Git rows are ignored rather than bucketed,
 * because an "unknown repository" row would be a lie about a local skill.
 *
 * @param skills - Skill entries from the panel list payload.
 * @returns Rows ordered by most recent install, then by label.
 */
export function groupSkillsByRepo(skills: readonly (RepoSkillLike & {
  updateStatus?: 'up_to_date' | 'update_available' | 'error' | 'unknown'
  installedAt?: number
})[]): ImportedRepo[] {
  const byKey = new Map<string, ImportedRepo & { memberNames: Set<string> }>()
  for (const skill of skills) {
    if (skill.sourceType !== 'git') continue
    const key = identityOf(skill)
    if (key === null) continue
    let row = byKey.get(key)
    if (row === undefined) {
      row = {
        key,
        label: repoLabel(key),
        members: [],
        lastInstalledAt: null,
        hasUpdate: false,
        hasError: false,
        memberNames: new Set<string>(),
      }
      byKey.set(key, row)
    }
    // The same skill can be listed twice (central copy plus a deployed copy);
    // it is still one skill of this repository.
    if (row.memberNames.has(skill.name)) continue
    row.memberNames.add(skill.name)
    row.members.push({ name: skill.name })
    if (skill.updateStatus === 'update_available') row.hasUpdate = true
    if (skill.updateStatus === 'error') row.hasError = true
    if (typeof skill.installedAt === 'number') {
      row.lastInstalledAt = Math.max(row.lastInstalledAt ?? 0, skill.installedAt)
    }
  }

  return [...byKey.values()]
    .map(({ memberNames: _memberNames, ...row }) => ({
      ...row,
      members: row.members.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => (b.lastInstalledAt ?? 0) - (a.lastInstalledAt ?? 0) || a.label.localeCompare(b.label))
}

/**
 * Map skill name to the repository it is currently installed from.
 *
 * The install preview uses this to warn that installing a same-named skill from
 * another repository overwrites the existing one: the central store keys rows
 * by name, so the previous repository's record would be replaced.
 *
 * @param skills - Skill entries from the panel list payload.
 * @returns Lowercased skill name to `{ key, label }`.
 */
export function installedRepoByName(
  skills: readonly RepoSkillLike[],
): Map<string, { key: string; label: string }> {
  const map = new Map<string, { key: string; label: string }>()
  for (const skill of skills) {
    if (skill.sourceType !== 'git') continue
    const key = identityOf(skill)
    if (key === null) continue
    map.set(skill.name.toLowerCase(), { key, label: repoLabel(key) })
  }
  return map
}

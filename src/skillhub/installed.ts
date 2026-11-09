/**
 * Which market slugs are already installed.
 *
 * A market install lands in `<root>/<slug>/`, but its `SKILL.md` declares a
 * human-facing `name:` that is usually a different string. Matching a card
 * against installed *names* alone therefore left every installed market skill
 * showing an install button, so both identities count: the directory it was
 * written into (the slug) and the name it declares.
 */

import { basename, dirname } from 'node:path'

/** The subset of a scanned skill this module reads. */
export interface InstalledSkillLike {
  name: string
  path?: string
}

/**
 * Derive every lowercase identity an installed skill answers to.
 * @param skills - scanned skills.
 * @returns lowercase identities, safe to compare against a slug.
 */
export function marketIdentities(skills: readonly InstalledSkillLike[]): Set<string> {
  const identities = new Set<string>()
  for (const skill of skills) {
    identities.add(skill.name.toLowerCase())
    if (typeof skill.path !== 'string' || skill.path === '') continue
    // `<root>/<dir>/SKILL.md` names the install directory; a single-file skill
    // (`<root>/<name>.md`) names the slug in the file stem instead.
    identities.add(basename(dirname(skill.path)).toLowerCase())
    const stem = basename(skill.path).replace(/\.md$/iu, '').toLowerCase()
    if (stem !== 'skill') identities.add(stem)
  }
  return identities
}

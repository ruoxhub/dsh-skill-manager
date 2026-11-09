/**
 * Presentational facts about a skill entry shared by the list rows and the
 * detail modal: avatar letter/palette, provider and file badges, the copy-path
 * target and whether the row carries an enable switch. Behaviour lives in the
 * components; this module only turns a SkillEntry into display values.
 */
import type { SkillEntry } from '../api.ts'
import { zh } from '../locales.ts'
import { tt } from '../panel-helpers.ts'

/** Localized provider label with fallback to the raw provider id. */
export function providerLabel(provider: string): string {
  const key = `provider.${provider}` as keyof typeof zh
  return key in zh ? tt(key) : provider
}

/**
 * The folder a skill's path lives in, for the copy-path action.
 *
 * A `<name>/SKILL.md` skill owns its parent directory; a single-file
 * `<name>.md` skill owns no folder, so it is handed over as it is.
 * @param path - the row's resolved SKILL.md path.
 * @returns the path to put on the clipboard.
 */
export function skillDirPath(path: string): string {
  return /[\\/]skill\.md$/iu.test(path) ? path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) : path
}

/** The name a duplicate starts from; the user can change it before creating. */
export function duplicateSkillName(name: string): string {
  return `${name}-copy`
}

/**
 * Whether this entry carries an enable switch.
 *
 * A row with a writable path switches by rewriting its own SKILL.md
 * frontmatter. A plugin-provided file (issue #1854) has no such path, so its
 * switch is recorded in the panel's own store; a truly fileless registration
 * has nothing to switch and still shows none.
 * @param skill - the entry.
 * @returns whether it offers the switch.
 */
export function canToggle(skill: SkillEntry): boolean {
  return skill.path !== undefined || skill.fileState === 'provider-file'
}

/**
 * The local-file badge for an entry that the write routes cannot serve.
 *
 * A skill with a plugin-supplied file and a skill with no file at all are
 * different facts (issue #1842): the first is "Provided by plugin", only the
 * second is "No local file". Both are pathless, so neither offers file
 * controls.
 * @param skill - the entry.
 * @returns the badge copy and its tooltip.
 */
export function localFileBadge(skill: SkillEntry): { label: string; tooltip: string } {
  return skill.fileState === 'provider-file'
    ? { label: tt('list.providerFile'), tooltip: tt('list.providerFileTooltip') }
    : { label: tt('list.noFile'), tooltip: tt('list.noFileTooltip') }
}

/** The explanation shown under an entry the write routes cannot serve. */
export function localFileHint(skill: SkillEntry): string {
  return skill.fileState === 'provider-file' ? tt('list.providerFileHint') : tt('list.noFileHint')
}

/** Marks shown next to a skill (model/user invocable). */
export function invokableMarks(skill: SkillEntry): string {
  const marks: string[] = []
  if (skill.modelInvocable) marks.push(tt('list.mark.model'))
  if (skill.userInvocable) marks.push(tt('list.mark.user'))
  return marks.join(' / ')
}

/** Theme-certified pastel avatar palettes matching the visual design and dark mode. */
const AVATAR_PALETTES = [
  { bg: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-state-business-primary)' },
  { bg: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-state-warn-primary)' },
  { bg: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-state-error-primary)' },
  { bg: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-state-success-primary)' },
  { bg: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-interactive-primary)' },
  { bg: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-state-business-primary)' },
] as const

/** Deterministic avatar palette for a skill name. */
export function getAvatarPalette(name: string): { bg: string; color: string } {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i)
    hash |= 0
  }
  return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length]!
}

/** The avatar letter for a skill name. */
export function getAvatarLetter(name: string): string {
  const match = name.match(/[a-zA-Z0-9]/)
  return match ? match[0].toUpperCase() : 'S'
}

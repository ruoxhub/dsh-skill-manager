/**
 * Persisted list-view preferences (pure, browser half).
 *
 * The skills tab's facets and its per-group collapse state must outlive a
 * panel remount and a page refresh, so they live in localStorage rather than
 * in component state — the layout unmounts a keyed page as soon as another
 * panel takes the center column. Storage is treated as untrusted input (it can
 * be corrupt, written by an older version, or hold something else entirely):
 * anything unrecognized degrades to the defaults instead of breaking the tab,
 * and a browser that refuses storage keeps working without persistence.
 *
 * The collapse state stores only what the user decided per group. A group with
 * no recorded decision falls back to `defaultExpanded`, so a source group this
 * build did not know about still opens or closes by its own kind instead of
 * inheriting a stale decision.
 */

import type { SkillMark, SkillStatus } from './skill-filter.ts'

/** The localStorage key holding the whole preference document. */
export const LIST_VIEW_STORAGE_KEY = 'dsh-skill-explorer:list-view:v1'

/**
 * Source groups opened on first use. These are the roots the user is actively
 * working with (project and user skills); the global and machine-level
 * sources — system bundled, custom directories, runtime registrations — start
 * collapsed so a wide catalog does not paint every row at once.
 */
export const DEFAULT_EXPANDED_LEVELS: readonly string[] = [
  'project-dsh',
  'project-agents',
  'user-dsh',
  'user-agents',
]

/** Per-group collapse decisions: true while a group is collapsed. */
export type CollapseState = Readonly<Record<string, boolean>>

/** A named snapshot of enabled skills for one-click switching. */
export interface SkillPreset {
  id: string
  name: string
  enabledSkills: string[]
}

/** The persisted list-view preferences. */
export interface ListViewPrefs {
  /** Source group keys the user narrowed to; empty means every group. */
  levels: string[]
  /** Enabled/disabled facet. */
  status: SkillStatus
  /** Marks the user narrowed to; empty means every row. */
  marks: SkillMark[]
  /** Per-group collapse decisions, keyed by source group key. */
  collapsed: CollapseState
  /** Named skill activation presets. */
  presets?: SkillPreset[]
}

/** The storage surface this module needs (localStorage satisfies it). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Bounds on the persisted document, so a hostile or buggy write stays small. */
const MAX_LIST_ENTRIES = 64
const MAX_STORAGE_BYTES = 8 * 1024

const STATUSES: readonly SkillStatus[] = ['all', 'enabled', 'disabled']
const MARKS: readonly SkillMark[] = ['linked', 'provider-file', 'no-file']

/** The preferences a browser with no stored document uses. */
export function defaultListPrefs(): ListViewPrefs {
  return { levels: [], status: 'all', marks: [], collapsed: {} }
}

/** Read a bounded string array, dropping anything that is not a string. */
function stringList(value: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') continue
    if (allowed !== undefined && !allowed.includes(entry)) continue
    if (out.includes(entry)) continue
    out.push(entry)
    if (out.length >= MAX_LIST_ENTRIES) break
  }
  return out
}

/** Read the collapse map, keeping boolean decisions only. */
function collapseMap(value: unknown): CollapseState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, boolean> = {}
  let kept = 0
  for (const [key, decision] of Object.entries(value)) {
    if (typeof decision !== 'boolean' || key === '') continue
    out[key] = decision
    kept += 1
    if (kept >= MAX_LIST_ENTRIES) break
  }
  return out
}

const MAX_PRESETS = 16

/** Read the presets list, keeping valid objects only. */
function parsePresets(value: unknown): SkillPreset[] {
  if (!Array.isArray(value)) return []
  const out: SkillPreset[] = []
  const seenIds = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || e.id === '' || seenIds.has(e.id)) continue
    if (typeof e.name !== 'string' || e.name === '') continue
    seenIds.add(e.id)
    const enabledSkills = stringList(e.enabledSkills)
    out.push({ id: e.id, name: e.name, enabledSkills })
    if (out.length >= MAX_PRESETS) break
  }
  return out
}

/**
 * Read the stored preferences, falling back to the defaults for a missing,
 * unreadable, oversized or malformed document. Every field is validated on its
 * own, so one bad field never discards the rest of the user's view.
 * @param storage - storage to read, or undefined when none is available.
 * @returns the preferences the tab should start from.
 */
export function loadListPrefs(storage: StorageLike | undefined): ListViewPrefs {
  const defaults = defaultListPrefs()
  if (storage === undefined) return defaults
  let raw: string | null
  try {
    raw = storage.getItem(LIST_VIEW_STORAGE_KEY)
  } catch {
    return defaults
  }
  if (raw === null || raw === '' || raw.length > MAX_STORAGE_BYTES) return defaults
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaults
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaults
  const document = parsed as Record<string, unknown>
  const status = document.status
  const result: ListViewPrefs = {
    levels: stringList(document.levels),
    status: typeof status === 'string' && (STATUSES as readonly string[]).includes(status)
      ? status as SkillStatus
      : defaults.status,
    marks: stringList(document.marks, MARKS) as SkillMark[],
    collapsed: collapseMap(document.collapsed),
  }
  if (document.presets !== undefined) {
    result.presets = parsePresets(document.presets)
  }
  return result
}

/** Add a new preset snapshot to preferences. */
export function savePreset(current: ListViewPrefs, name: string, enabledSkills: string[]): ListViewPrefs {
  const existing = current.presets ?? []
  if (existing.length >= MAX_PRESETS) {
    return current
  }
  const id = `preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const boundedSkills = stringList(enabledSkills)
  const newPreset: SkillPreset = { id, name: name.trim().slice(0, 40), enabledSkills: boundedSkills }
  return {
    ...current,
    presets: [...existing, newPreset],
  }
}

/** Delete a preset by id. */
export function deletePreset(current: ListViewPrefs, presetId: string): ListViewPrefs {
  const existing = current.presets ?? []
  return {
    ...current,
    presets: existing.filter(p => p.id !== presetId),
  }
}

/**
 * Persist the preferences. A browser that refuses storage (private mode, a
 * sandboxed frame, a full quota) is not an error: the view still works for
 * this page load, it just does not survive a refresh.
 * @param storage - storage to write, or undefined when none is available.
 * @param prefs - the preferences to store.
 * @returns whether the document was persisted.
 */
export function saveListPrefs(storage: StorageLike | undefined, prefs: ListViewPrefs): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(LIST_VIEW_STORAGE_KEY, JSON.stringify(prefs))
    return true
  } catch {
    return false
  }
}

/**
 * Whether a source group is open, given the user's recorded decisions.
 * @param key - the group's source key.
 * @param collapsed - recorded per-group decisions.
 * @returns whether the group's rows are visible.
 */
export function isGroupExpanded(key: string, collapsed: CollapseState): boolean {
  const recorded = collapsed[key]
  if (recorded !== undefined) return !recorded
  const colonIdx = key.indexOf(':')
  const baseKey = colonIdx === -1 ? key : key.slice(0, colonIdx)
  const baseRecorded = collapsed[baseKey]
  return baseRecorded === undefined ? DEFAULT_EXPANDED_LEVELS.includes(baseKey) : !baseRecorded
}

/**
 * Flip one group's collapse decision, recording it explicitly so the choice
 * survives a remount and later default changes cannot silently reopen it.
 * @param key - the group's source key.
 * @param collapsed - current recorded decisions.
 * @returns a new decision map with this group flipped.
 */
export function toggleGroupCollapsed(key: string, collapsed: CollapseState): CollapseState {
  return { ...collapsed, [key]: isGroupExpanded(key, collapsed) }
}

/**
 * Skills tab: the grouped skill list with the search / facet / workspace
 * toolbar, collapsible source groups, and the per-row enable switch, edit,
 * duplicate and delete actions.
 *
 * The host route family is the only data source; a failed refresh keeps the
 * previous payload visible with an inline error. Which facets are applied and
 * which source groups are open are view preferences, not payload state: they
 * are persisted in localStorage (panel-prefs.ts), because the layout unmounts
 * this page whenever another panel takes the center column.
 */
import { useEffect, useRef, useState } from 'react'
import { SkillApi, type GroupPayload, type ListPayload, type SkillEntry } from '../api.ts'
import { zh } from '../locales.ts'
import { tt } from '../panel-helpers.ts'
import {
  loadListPrefs,
  saveListPrefs,
  savePreset,
  deletePreset,
  type SkillPreset,
  type ListViewPrefs,
  type StorageLike,
} from '../panel-prefs.ts'
import { selectGroups, type SkillListFilter, type SkillMark, type SkillStatus } from '../skill-filter.ts'
import type { SkillDraft } from './controller.ts'
import { DetailDrawer } from './DetailDrawer.tsx'
import css from './panel.module.css'

/** The mark facets, in the order the filter bar lists them. */
const MARK_FACETS: readonly SkillMark[] = ['provider-file', 'no-file', 'linked']

/** The enabled/disabled facets, in the order the filter bar lists them. */
const STATUS_FACETS: readonly SkillStatus[] = ['all', 'enabled', 'disabled']

/** Localized provider label with fallback to the raw provider id. */
function providerLabel(provider: string): string {
  const key = `provider.${provider}` as keyof typeof zh
  return key in zh ? tt(key) : provider
}

/** Localized source-group title, falling back to the host's own copy. */
function groupTitle(group: GroupPayload): string {
  if (group.workspaceName) {
    const isAgents = group.key.startsWith('project-agents')
    const suffix = isAgents ? ' (.agents/skills)' : ' (.dsh/skills)'
    return tt('group.projectWithWorkspace', { workspace: group.workspaceName }) + suffix
  }
  const key = `group.${group.key}` as keyof typeof zh
  return key in zh ? tt(key) : group.title
}

/** The browser's localStorage, or undefined when this context refuses it. */
function listStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // A sandboxed frame throws on the accessor itself; the tab still works,
    // it just does not remember the view between visits.
    return undefined
  }
}

/** Whether any facet narrows the list (the source/status/mark facets only). */
function hasActiveFacets(prefs: ListViewPrefs): boolean {
  return prefs.levels.length > 0 || prefs.status !== 'all' || prefs.marks.length > 0
}

/** How many facet selections are active, for the toolbar badge. */
function activeFacetCount(prefs: ListViewPrefs): number {
  return prefs.levels.length + (prefs.status === 'all' ? 0 : 1) + prefs.marks.length
}

/** The name a duplicate starts from; the user can change it before creating. */
function duplicateSkillName(name: string): string {
  return `${name}-copy`
}

/**
 * Whether this row carries an enable switch.
 *
 * A row with a writable path switches by rewriting its own SKILL.md
 * frontmatter. A plugin-provided file (issue #1854) has no such path, so its
 * switch is recorded in the panel's own store; a truly fileless registration
 * has nothing to switch and still shows none.
 * @param skill - the row's entry.
 * @returns whether the row offers the switch.
 */
function canToggle(skill: SkillEntry): boolean {
  return skill.path !== undefined || skill.fileState === 'provider-file'
}

/**
 * The local-file badge for a row that the write routes cannot serve.
 *
 * A skill with a plugin-supplied file and a skill with no file at all are
 * different facts (issue #1842): the first is "Provided by plugin", only the
 * second is "No local file". Both are pathless, so neither offers file
 * controls.
 * @param skill - the row's entry.
 * @returns the badge copy and its tooltip.
 */
function localFileBadge(skill: SkillEntry): { label: string; tooltip: string } {
  return skill.fileState === 'provider-file'
    ? { label: tt('list.providerFile'), tooltip: tt('list.providerFileTooltip') }
    : { label: tt('list.noFile'), tooltip: tt('list.noFileTooltip') }
}

/** The explanation shown under a row the write routes cannot serve. */
function localFileHint(skill: SkillEntry): string {
  return skill.fileState === 'provider-file' ? tt('list.providerFileHint') : tt('list.noFileHint')
}

/** Marks shown next to a skill (model/user invocable). */
function invokableMarks(skill: SkillEntry): string {
  const marks: string[] = []
  if (skill.modelInvocable) marks.push(tt('list.mark.model'))
  if (skill.userInvocable) marks.push(tt('list.mark.user'))
  return marks.join(' / ')
}

/** Deterministic pastel avatar palettes matching the visual design. */
const AVATAR_PALETTES = [
  { bg: '#FEF3C7', color: '#D97706' }, // amber/yellow
  { bg: '#DBEAFE', color: '#2563EB' }, // blue
  { bg: '#FCE7F3', color: '#E11D48' }, // pink/rose
  { bg: '#DCFCE7', color: '#16A34A' }, // green/emerald
  { bg: '#ECFCCB', color: '#65A30D' }, // lime
  { bg: '#F3E8FF', color: '#9333EA' }, // purple/violet
  { bg: '#FFEDD5', color: '#EA580C' }, // orange
  { bg: '#FEE2E2', color: '#DC2626' }, // red/coral
  { bg: '#E0E7FF', color: '#4F46E5' }, // indigo
  { bg: '#CCFBF1', color: '#0D9488' }, // teal
  { bg: '#E0F2FE', color: '#0284C7' }, // sky
] as const

function getAvatarPalette(name: string): { bg: string; color: string } {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i)
    hash |= 0
  }
  return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length]!
}

function getAvatarLetter(name: string): string {
  const match = name.match(/[a-zA-Z0-9]/)
  return match ? match[0].toUpperCase() : 'S'
}

/** One skill card: avatar, name, badges, enable switch, pin, edit, duplicate and delete actions. */
function SkillRow({ skill, api, onChanged, onEdit, onDuplicate, isPinned, onTogglePin, batchMode, isSelected, onToggleSelect, onSelectDetail }: {
  skill: SkillEntry
  api: SkillApi
  onChanged: () => void
  onEdit: (skill: SkillEntry) => void
  onDuplicate: (draft: SkillDraft) => void
  isPinned?: boolean
  onTogglePin?: (name: string) => void
  batchMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (name: string) => void
  onSelectDetail?: (skill: SkillEntry) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // Sync ref guard: React state updates are async, so a double click before
  // the re-render would fire the same request twice with the stale target.
  const busyRef = useRef(false)

  useEffect(() => {
    if (!menuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => { document.removeEventListener('mousedown', handleClickOutside) }
  }, [menuOpen])

  const toggle = async (): Promise<void> => {
    if (busyRef.current || !canToggle(skill)) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    try {
      // Two identities, one switch: a row with a file certifies the path the
      // write routes re-scan, a plugin-provided row certifies the
      // (provider, name) pair the host records in the panel's own store.
      if (skill.path !== undefined) await api.setEnabled(skill.name, skill.path, !skill.modelInvocable)
      else await api.setProviderEnabled(skill.name, skill.provider, !skill.modelInvocable)
      onChanged()
    } catch (err) {
      setError(tt('list.toggleFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    const path = skill.path
    if (path === undefined) return
    if (!window.confirm(tt('list.deleteConfirm', { name: skill.name }))) return
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    try {
      await api.remove(skill.name, path)
      onChanged()
    } catch (err) {
      setError(tt('list.deleteFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /**
   * Copy this skill's fields into the create form as a starting point. The
   * read route resolves the row's own path through a fresh scan, so the draft
   * can only ever come from a skill the panel is showing.
   */
  const duplicate = async (): Promise<void> => {
    const path = skill.path
    if (path === undefined || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    try {
      const source = await api.read(skill.name, path)
      onDuplicate({
        from: skill.name,
        name: duplicateSkillName(skill.name),
        description: source.description,
        ...(source.whenToUse === undefined ? {} : { whenToUse: source.whenToUse }),
        content: source.content,
      })
    } catch (err) {
      setError(tt('list.duplicateFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const isIsolated = skill.isActiveWorkspace === false
  // Computed once per render: a row with a writable path needs neither.
  const fileBadge = skill.path === undefined ? localFileBadge(skill) : undefined
  // Linked skills are read-only here (their file belongs to whatever they
  // point at), so they offer neither edit nor delete; duplication only reads,
  // so it stays available wherever a path exists.
  const canCopy = skill.path !== undefined
  const palette = getAvatarPalette(skill.name)
  const letter = getAvatarLetter(skill.name)
  const tooltip = [
    skill.name,
    skill.description,
    skill.workspaceName ? `工作区: ${skill.workspaceName}` : undefined,
    isIsolated ? '工作区隔离' : undefined,
    skill.provider ? `来源: ${providerLabel(skill.provider)}` : undefined,
    fileBadge ? fileBadge.label : undefined,
  ].filter(Boolean).join('\n')

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('input') || target.closest(`.${css.moreMenuWrapper}`)) {
      return
    }
    if (batchMode) {
      onToggleSelect?.(skill.name)
    } else {
      onSelectDetail?.(skill)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const target = e.target as HTMLElement
      if (target.closest('button') || target.closest('input') || target.closest(`.${css.moreMenuWrapper}`)) {
        return
      }
      e.preventDefault()
      if (batchMode) {
        onToggleSelect?.(skill.name)
      } else {
        onSelectDetail?.(skill)
      }
    }
  }

  return (
    <article
      className={`${css.skillRow}${isIsolated ? ` ${css.skillIsolated}` : ''}`}
      title={tooltip}
      data-dsh-part="skill-row"
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleKeyDown}
    >
      {batchMode && (
        <input
          type="checkbox"
          className={css.batchCheckbox}
          checked={isSelected}
          onChange={() => onToggleSelect?.(skill.name)}
          aria-label={skill.name}
        />
      )}
      <div
        className={css.avatar}
        style={{ backgroundColor: palette.bg, color: palette.color }}
        aria-hidden="true"
      >
        {letter}
      </div>
      <div className={css.cardBody}>
        <div className={css.cardHeader}>
          <span className={css.skillName} title={skill.name}>{skill.name}</span>
          <div className={css.badgeContainer}>
            {skill.workspaceName !== undefined && (
              <span className={`${css.badge} ${css.badgeWorkspace}`}>{skill.workspaceName}</span>
            )}
            {isIsolated && (
              <span className={`${css.badge} ${css.badgeIsolated}`} title={tt('workspace.isolatedHint', { workspace: skill.workspaceName ?? '' })}>
                {tt('workspace.isolated')}
              </span>
            )}
            {skill.provider !== undefined && (
              <span className={css.badge} title={tt('provider.tooltip', { provider: providerLabel(skill.provider) })}>
                {providerLabel(skill.provider)}
              </span>
            )}
            {skill.linked === true && <span className={css.badge}>{tt('list.linked')}</span>}
            {fileBadge !== undefined && (
              <span className={css.badge} title={fileBadge.tooltip}>{fileBadge.label}</span>
            )}
            {(skill.modelInvocable || skill.userInvocable) && (
              <span className={`${css.badge} ${css.badgeInvokable}`} title={tt('list.invokableTooltip')}>
                {tt('list.invokable', { marks: invokableMarks(skill) })}
              </span>
            )}
          </div>
          <div className={css.cardActions}>
            <div className={css.moreMenuWrapper} ref={menuRef}>
              <button
                type="button"
                className={css.iconActionBtn}
                aria-label={tt('list.more')}
                title={tt('list.more')}
                onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o) }}
              >
                ···
              </button>
              <div className={`${css.actionDropdown}${menuOpen ? ` ${css.dropdownOpen}` : ''}`}>
                {canCopy && (
                  <button
                    type="button"
                    className={css.menuItem}
                    disabled={busy}
                    onClick={() => { setMenuOpen(false); void duplicate() }}
                  >
                    {tt('list.duplicate')}
                  </button>
                )}
                {skill.path !== undefined && skill.linked !== true && (
                  <button
                    type="button"
                    className={css.menuItem}
                    disabled={busy}
                    onClick={() => { setMenuOpen(false); onEdit(skill) }}
                  >
                    {tt('list.edit')}
                  </button>
                )}
                {skill.path !== undefined && skill.linked !== true && (
                  <button
                    type="button"
                    className={`${css.menuItem} ${css.deleteItem}`}
                    data-danger=""
                    disabled={busy}
                    onClick={() => { setMenuOpen(false); void remove() }}
                  >
                    {tt('list.delete')}
                  </button>
                )}
              </div>
            </div>
            <button
              type="button"
              className={`${css.iconActionBtn}${isPinned ? ` ${css.pinned}` : ''}`}
              aria-label={isPinned ? tt('list.unpin') : tt('list.pin')}
              title={isPinned ? tt('list.unpin') : tt('list.pin')}
              onClick={(e) => { e.stopPropagation(); onTogglePin?.(skill.name) }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="17" x2="12" y2="22"></line>
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
              </svg>
            </button>
          </div>
          {canToggle(skill) && (
            <button
              type="button"
              className={css.switch}
              role="switch"
              aria-checked={skill.modelInvocable}
              aria-label={skill.modelInvocable ? tt('list.enabled') : tt('list.disabled')}
              title={skill.modelInvocable ? tt('list.enabled') : tt('list.disabled')}
              disabled={busy}
              onClick={() => { void toggle() }}
            >
              <span className={css.switchTrack}><span className={css.switchThumb} /></span>
            </button>
          )}
        </div>
        <p className={css.skillDesc} title={skill.description}>{skill.description}</p>
        <div className={css.srOnly}>
          {skill.whenToUse !== undefined && skill.whenToUse !== '' && (
            <p className={css.skillWhen}>{tt('list.when', { when: skill.whenToUse })}</p>
          )}
          {skill.path !== undefined && <div className={css.skillPath}>{skill.path}</div>}
          {skill.path === undefined && <p className={css.skillWhen}>{localFileHint(skill)}</p>}
        </div>
        {error !== undefined && <p className={css.banner} data-kind="error">{error}</p>}
      </div>
    </article>
  )
}

/** The skills tab body. */
export function SkillsTab({ api, onEdit, onImport, onDuplicate }: {
  api: SkillApi
  onEdit: (skill: SkillEntry) => void
  onImport: () => void
  onDuplicate: (draft: SkillDraft) => void
}): React.JSX.Element {
  const [payload, setPayload] = useState<ListPayload | undefined>(undefined)
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('all')
  const [query, setQuery] = useState('')
  // The persisted view preferences load once; a storage that refuses them
  // simply yields the defaults, and the effect below is a no-op write.
  const [prefs, setPrefs] = useState<ListViewPrefs>(() => loadListPrefs(listStorage()))
  // Restored facets must be visible, or the list looks inexplicably short.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => hasActiveFacets(loadListPrefs(listStorage())))
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [pinnedSkills, setPinnedSkills] = useState<Set<string>>(() => new Set())
  const [detailSkill, setDetailSkill] = useState<SkillEntry | null>(null)
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')
  const [batchMode, setBatchMode] = useState(false)
  const [batchMenuOpen, setBatchMenuOpen] = useState(false)
  const batchMenuRef = useRef<HTMLDivElement>(null)
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(() => new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  // Sequence guard: a slow earlier load must not overwrite a newer one.
  const loadSeq = useRef(0)

  useEffect(() => {
    if (!batchMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (batchMenuRef.current && !batchMenuRef.current.contains(e.target as Node)) {
        setBatchMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => { document.removeEventListener('mousedown', handleClickOutside) }
  }, [batchMenuOpen])

  const load = async (): Promise<void> => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const next = await api.list()
      if (seq !== loadSeq.current) return
      setPayload(next)
      setError(undefined)
    } catch (err) {
      if (seq !== loadSeq.current) return
      setError(tt('list.loadFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      // A newer load owns the flag while it runs.
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  useEffect(() => { void load() }, [api])

  // One write per change: the whole document is tiny, and rewriting it keeps
  // the stored shape identical to the in-memory shape (no merge step to drift).
  useEffect(() => { saveListPrefs(listStorage(), prefs) }, [prefs])

  // Self-heal a stored source facet whose group is gone (a custom root removed,
  // a plugin uninstalled): keeping it would empty the list with a facet the
  // filter bar cannot even show, because it only offers the groups that exist.
  useEffect(() => {
    if (payload === undefined) return
    const present = new Set(payload.groups.map(group => group.key))
    if (prefs.levels.every(level => present.has(level))) return
    setPrefs(current => ({ ...current, levels: current.levels.filter(level => present.has(level)) }))
  }, [payload, prefs.levels])

  const toggleLevel = (key: string): void => {
    setPrefs(current => ({
      ...current,
      levels: current.levels.includes(key)
        ? current.levels.filter(level => level !== key)
        : [...current.levels, key],
    }))
  }

  const toggleMark = (mark: SkillMark): void => {
    setPrefs(current => ({
      ...current,
      marks: current.marks.includes(mark)
        ? current.marks.filter(entry => entry !== mark)
        : [...current.marks, mark],
    }))
  }

  const clearFacets = (): void => {
    setPrefs(current => ({ ...current, levels: [], status: 'all', marks: [] }))
  }

  const togglePin = (name: string): void => {
    setPinnedSkills(current => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const toggleSelect = (name: string): void => {
    setSelectedSkills(current => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleSelectAll = (allSkillNames: string[]): void => {
    if (selectedSkills.size === allSkillNames.length) {
      setSelectedSkills(new Set())
    } else {
      setSelectedSkills(new Set(allSkillNames))
    }
  }

  const handleBatchToggle = async (enabled: boolean): Promise<void> => {
    if (batchBusy || selectedSkills.size === 0 || payload === undefined) return
    setBatchBusy(true)
    try {
      const allSkills = payload.groups.flatMap(g => g.skills).filter(s => selectedSkills.has(s.name) && canToggle(s))
      for (const s of allSkills) {
        if (s.path !== undefined) await api.setEnabled(s.name, s.path, enabled)
        else await api.setProviderEnabled(s.name, s.provider, enabled)
      }
      await load()
    } catch (err) {
      setError(tt('list.toggleFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBatchBusy(false)
    }
  }

  const handleBatchDelete = async (): Promise<void> => {
    if (batchBusy || selectedSkills.size === 0 || payload === undefined) return
    const deletableSkills = payload.groups
      .flatMap(g => g.skills)
      .filter(s => selectedSkills.has(s.name) && s.path !== undefined && s.linked !== true)
    if (deletableSkills.length === 0) return
    if (!window.confirm(tt('list.batchDeleteConfirm', { count: String(deletableSkills.length) }))) return
    setBatchBusy(true)
    setError(undefined)
    try {
      for (const s of deletableSkills) {
        if (s.path !== undefined) {
          await api.remove(s.name, s.path)
        }
      }
      setSelectedSkills(new Set())
    } catch (err) {
      setError(tt('list.deleteFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      try { await load() } catch {}
      setBatchBusy(false)
    }
  }

  const handleSavePreset = (): void => {
    if (payload === undefined) return
    const name = window.prompt(tt('preset.namePrompt'))
    if (!name || !name.trim()) return
    const enabledSkills = payload.groups
      .flatMap(g => g.skills)
      .filter(s => s.modelInvocable)
      .map(s => s.name)
    setPrefs(cur => savePreset(cur, name.trim(), enabledSkills))
  }

  const handleDeletePreset = (presetId: string): void => {
    setPrefs(cur => deletePreset(cur, presetId))
    if (selectedPresetId === presetId) {
      setSelectedPresetId('')
    }
  }

  const handleApplyPreset = async (preset: SkillPreset): Promise<void> => {
    if (batchBusy || payload === undefined) return
    setBatchBusy(true)
    setError(undefined)
    try {
      const allSkills = payload.groups.flatMap(g => g.skills).filter(canToggle)
      const targetEnabled = new Set(preset.enabledSkills)
      for (const s of allSkills) {
        const shouldBeEnabled = targetEnabled.has(s.name)
        if (s.modelInvocable !== shouldBeEnabled) {
          if (s.path !== undefined) await api.setEnabled(s.name, s.path, shouldBeEnabled)
          else await api.setProviderEnabled(s.name, s.provider, shouldBeEnabled)
        }
      }
    } catch (err) {
      setError(tt('list.toggleFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      try { await load() } catch {}
      setBatchBusy(false)
    }
  }

  // The refresh control is hidden while a load runs: a second request cannot
  // shorten the first, and the loading state already covers the wait.
  const refreshButton = loading
    ? undefined
    : (
      <button type="button" className={css.menuItem} onClick={() => { setBatchMenuOpen(false); void load() }}>
        {tt('refresh')}
      </button>
    )

  // Last-good policy: a failed refresh keeps the previous payload visible and
  // reports the error inline; the error state replaces the list only when
  // there is nothing to fall back to.
  if (payload === undefined) {
    return (
      <div className={css.fillBody}>
        {loading
          ? <p className={css.empty}>{tt('list.loading')}</p>
          : (
            <>
              <p className={css.empty}>{error}</p>
              <div className={css.toolbar}>{refreshButton}</div>
            </>
          )}
      </div>
    )
  }

  const filter: SkillListFilter = {
    workspace: selectedWorkspace,
    query,
    levels: prefs.levels,
    status: prefs.status,
    marks: prefs.marks,
  }
  const visibleGroups = selectGroups(payload.groups, filter)
  const allVisibleSkills = visibleGroups.flatMap(group => group.skills)
  const sortedSkills = [...allVisibleSkills].sort((a, b) => {
    const aPin = pinnedSkills.has(a.name) ? 1 : 0
    const bPin = pinnedSkills.has(b.name) ? 1 : 0
    if (aPin !== bPin) return bPin - aPin
    return a.name.localeCompare(b.name)
  })
  const visibleCount = allVisibleSkills.length
  const totalCount = payload.groups.reduce((total, group) => total + group.skills.length, 0)
  const allVisibleNames = allVisibleSkills.map(s => s.name)
  const facetsActive = hasActiveFacets(prefs)
  const narrowed = query.trim() !== '' || selectedWorkspace !== 'all' || facetsActive
  const emptyText = query.trim() !== ''
    ? tt('filter.empty', { query: query.trim() })
    : narrowed ? tt('filter.emptyWorkspace') : tt('list.empty')

  return (
    <div className={css.fillBody}>
      <div className={css.toolbar} data-dsh-part="filter-bar">
        <div className={css.headerTitleGroup}>
          <span className={css.backArrow} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </span>
          <h1 className={css.headerTitle}>{tt('list.installedSkills')} ({totalCount})</h1>
        </div>
        <div className={css.headerActions}>
          <div className={css.searchWrapper}>
            <svg className={css.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              className={css.search}
              type="search"
              value={query}
              spellCheck={false}
              aria-label={tt('filter.searchLabel')}
              placeholder={tt('filter.searchPlaceholder')}
              onChange={(event) => { setQuery(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Escape' && query !== '') setQuery('') }}
            />
          </div>
          <select
            className={css.select}
            value={selectedWorkspace}
            aria-label={tt('filter.workspaceLabel')}
            onChange={(event) => { setSelectedWorkspace(event.target.value) }}
          >
            <option value="all">{tt('filter.workspaceAll')}</option>
            <option value="user">{tt('filter.workspaceUser')}</option>
            <option value="system">{tt('filter.workspaceSystem')}</option>
            {payload.workspaces?.map(ws => (
              <option key={ws.root} value={ws.root}>
                {ws.active ? tt('filter.workspaceCurrent', { name: ws.name }) : ws.name}
              </option>
            ))}
          </select>
          <div className={css.batchMenuWrapper} ref={batchMenuRef}>
            <button
              type="button"
              className={`${css.batchButton}${batchMode ? ` ${css.batchButtonActive}` : ''}`}
              onClick={() => { setBatchMode(m => !m) }}
              onMouseEnter={() => { setBatchMenuOpen(true) }}
            >
              <svg className={css.batchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6"></line>
                <line x1="8" y1="12" x2="21" y2="12"></line>
                <line x1="8" y1="18" x2="21" y2="18"></line>
                <line x1="3" y1="6" x2="3.01" y2="6"></line>
                <line x1="3" y1="12" x2="3.01" y2="12"></line>
                <line x1="3" y1="18" x2="3.01" y2="18"></line>
              </svg>
              <span>{tt('list.batch')}</span>
            </button>
            <div className={`${css.batchDropdown}${batchMenuOpen ? ` ${css.dropdownOpen}` : ''}`}>
              <button
                type="button"
                className={css.menuItem}
                onClick={() => { setBatchMenuOpen(false); onImport() }}
              >
                {tt('import.open')}
              </button>
              <button
                type="button"
                className={css.menuItem}
                aria-expanded={filtersOpen}
                data-active={facetsActive ? '' : undefined}
                onClick={() => { setBatchMenuOpen(false); setFiltersOpen(open => !open) }}
              >
                {tt('filter.toggle')}{facetsActive ? ` (${activeFacetCount(prefs)})` : ''}
              </button>
              {refreshButton}
            </div>
          </div>
        </div>
      </div>
      {batchMode && (
        <div className={css.batchBar}>
          <span className={css.batchCount}>已选择 {selectedSkills.size} 项</span>
          <button type="button" className={css.batchActionBtn} onClick={() => { handleSelectAll(allVisibleNames) }}>
            {selectedSkills.size === allVisibleNames.length ? '取消全选' : '全选'}
          </button>
          <button type="button" className={css.batchActionBtn} disabled={batchBusy || selectedSkills.size === 0} onClick={() => { void handleBatchToggle(true) }}>
            批量启用
          </button>
          <button type="button" className={css.batchActionBtn} disabled={batchBusy || selectedSkills.size === 0} onClick={() => { void handleBatchToggle(false) }}>
            批量禁用
          </button>
          <button type="button" className={`${css.batchActionBtn} ${css.deleteItem}`} disabled={batchBusy || selectedSkills.size === 0} onClick={() => { void handleBatchDelete() }}>
            批量删除
          </button>
          <button type="button" className={css.batchActionBtn} disabled={batchBusy} onClick={handleSavePreset}>
            {tt('preset.save')}
          </button>
          {prefs.presets && prefs.presets.length > 0 && (
            <>
              <select
                className={css.select}
                disabled={batchBusy}
                aria-label={tt('preset.selectPlaceholder', { count: String(prefs.presets.length) })}
                value={selectedPresetId}
                onChange={(e) => { setSelectedPresetId(e.target.value) }}
              >
                <option value="">{tt('preset.selectPlaceholder', { count: String(prefs.presets.length) })}</option>
                {prefs.presets.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.enabledSkills.length})</option>
                ))}
              </select>
              {selectedPresetId !== '' && (
                <>
                  <button
                    type="button"
                    className={css.batchActionBtn}
                    disabled={batchBusy}
                    onClick={() => {
                      const p = prefs.presets?.find(item => item.id === selectedPresetId)
                      if (p) void handleApplyPreset(p)
                    }}
                  >
                    {tt('preset.apply')}
                  </button>
                  <button
                    type="button"
                    className={`${css.batchActionBtn} ${css.deleteItem}`}
                    disabled={batchBusy}
                    onClick={() => {
                      if (window.confirm(tt('preset.deleteConfirm'))) {
                        handleDeletePreset(selectedPresetId)
                      }
                    }}
                  >
                    {tt('preset.delete')}
                  </button>
                </>
              )}
            </>
          )}
          <button type="button" className={`${css.batchActionBtn} ${css.batchExitBtn}`} onClick={() => { setBatchMode(false); setSelectedSkills(new Set()) }}>
            完成
          </button>
        </div>
      )}
      {filtersOpen && (
        <div className={css.facetBar} data-dsh-part="facet-bar">
          <div className={css.facetRow}>
            <span className={css.facetLabel}>{tt('filter.sourceLabel')}</span>
            {payload.groups.map(group => (
              <button
                key={group.key}
                type="button"
                className={css.facetChip}
                aria-pressed={prefs.levels.includes(group.key)}
                data-active={prefs.levels.includes(group.key) ? '' : undefined}
                onClick={() => { toggleLevel(group.key) }}
              >
                {groupTitle(group)}
                <span className={css.facetCount}>{group.skills.length}</span>
              </button>
            ))}
          </div>
          <div className={css.facetRow}>
            <span className={css.facetLabel}>{tt('filter.statusLabel')}</span>
            {STATUS_FACETS.map(status => (
              <button
                key={status}
                type="button"
                className={css.facetChip}
                aria-pressed={prefs.status === status}
                data-active={prefs.status === status ? '' : undefined}
                onClick={() => { setPrefs(current => ({ ...current, status })) }}
              >
                {tt(`filter.status.${status}`)}
              </button>
            ))}
          </div>
          <div className={css.facetRow}>
            <span className={css.facetLabel}>{tt('filter.markLabel')}</span>
            {MARK_FACETS.map(mark => (
              <button
                key={mark}
                type="button"
                className={css.facetChip}
                aria-pressed={prefs.marks.includes(mark)}
                data-active={prefs.marks.includes(mark) ? '' : undefined}
                onClick={() => { toggleMark(mark) }}
              >
                {tt(`filter.mark.${mark}`)}
              </button>
            ))}
            {facetsActive && (
              <button type="button" className={css.linkButton} onClick={clearFacets}>{tt('filter.clear')}</button>
            )}
          </div>
        </div>
      )}
      {error !== undefined && <p className={css.banner} data-kind="error">{error}</p>}
      {visibleCount === 0
        ? <p className={css.empty}>{emptyText}</p>
        : (
          <div className={css.list}>
            <div className={css.skillGrid}>
              {sortedSkills.map(skill => (
                <SkillRow
                  key={`${skill.name}:${skill.path ?? skill.provider ?? ''}`}
                  skill={skill}
                  api={api}
                  onChanged={() => { void load() }}
                  onEdit={onEdit}
                  onDuplicate={onDuplicate}
                  isPinned={pinnedSkills.has(skill.name)}
                  onTogglePin={togglePin}
                  batchMode={batchMode}
                  isSelected={selectedSkills.has(skill.name)}
                  onToggleSelect={toggleSelect}
                  onSelectDetail={setDetailSkill}
                />
              ))}
            </div>
          </div>
        )}
      <DetailDrawer
        skill={detailSkill}
        api={api}
        onClose={() => { setDetailSkill(null) }}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
      />
    </div>
  )
}

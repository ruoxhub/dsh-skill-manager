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
import { SkillApi, type GroupPayload, type ListPayload, type PresetListPayload, type SkillEntry, type SkillPresetRecord, type SkillRootKey } from '../api.ts'
import { zh } from '../locales.ts'
import { tt } from '../panel-helpers.ts'
import {
  loadListPrefs,
  saveListPrefs,
  type ListViewPrefs,
  type StorageLike,
} from '../panel-prefs.ts'
import { selectGroups, type SkillListFilter, type SkillMark, type SkillStatus } from '../skill-filter.ts'
import {
  canToggle,
  duplicateSkillName,
  getAvatarLetter,
  getAvatarPalette,
  invokableMarks,
  localFileBadge,
  localFileHint,
  providerLabel,
  skillDirPath,
} from './skill-present.ts'
import type { SkillDraft } from './controller.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { DetailDrawer } from './DetailDrawer.tsx'
import css from './panel.module.css'

/** The mark facets, in the order the filter bar lists them. */
const MARK_FACETS: readonly SkillMark[] = ['provider-file', 'no-file', 'linked']

/** The enabled/disabled facets, in the order the filter bar lists them. */
const STATUS_FACETS: readonly SkillStatus[] = ['all', 'enabled', 'disabled']

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
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
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
   * Copy the skill's folder path, the unit the user pastes into a terminal or
   * an editor. A lone `<name>.md` skill has no folder of its own, so its own
   * path is the closest thing.
   */
  const copyPath = async (): Promise<void> => {
    const path = skill.path
    if (path === undefined) return
    setNotice(undefined)
    try {
      await navigator.clipboard.writeText(skillDirPath(path))
      setNotice(tt('list.copyPathDone'))
    } catch {
      // A rejected clipboard permission must not look like a successful copy.
      setError(tt('list.copyPathFailed'))
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

  const handleUpdateOne = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (updating) return
    setUpdating(true)
    setError(undefined)
    try {
      await api.updateOne(skill.name)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdating(false)
    }
  }

  const handleCheckOne = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await api.checkOne(skill.name)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
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
      className={`${css.skillRow}${isIsolated ? ` ${css.skillIsolated}` : ''}${menuOpen ? ` ${css.cardMenuOpen}` : ''}`}
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
          <div className={css.rowControls}>
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
              {skill.updateStatus === 'update_available' && (
                <span className={`${css.badge} ${css.badgeUpdateAvailable}`} title="有新版本可用">
                  可更新
                </span>
              )}
              {skill.updateStatus === 'up_to_date' && (
                <span className={`${css.badge} ${css.badgeUpToDate}`} title="已是最新版本">
                  最新
                </span>
              )}
              {skill.updateStatus === 'error' && (
                <span className={`${css.badge} ${css.badgeError}`} title={skill.lastCheckError || '检查更新失败'}>
                  检查失败
                </span>
              )}
            </div>
            <div className={css.cardActions}>
              {skill.updateStatus === 'update_available' && (
                <button
                  type="button"
                  className={css.updateButton}
                  title="更新此技能至最新版本"
                  disabled={updating}
                  onClick={handleUpdateOne}
                >
                  {updating ? '更新中' : '更新'}
                </button>
              )}
              <div className={css.moreMenuWrapper} ref={menuRef}>
                <button
                  type="button"
                  className={css.iconActionBtn}
                  aria-label={tt('list.more')}
                  title={tt('list.more')}
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o) }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="19" cy="12" r="1" />
                    <circle cx="5" cy="12" r="1" />
                  </svg>
                </button>
                <div className={`${css.actionDropdown}${menuOpen ? ` ${css.dropdownOpen}` : ''}`}>
                  <button
                    type="button"
                    className={css.menuItem}
                    disabled={busy}
                    onClick={(e) => { setMenuOpen(false); void handleCheckOne(e) }}
                  >
                    检查更新
                  </button>
                  {skill.updateStatus === 'update_available' && (
                    <button
                      type="button"
                      className={css.menuItem}
                      disabled={updating}
                      onClick={(e) => { setMenuOpen(false); void handleUpdateOne(e) }}
                    >
                      立即更新
                    </button>
                  )}
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
                  {skill.path !== undefined && (
                    <button
                      type="button"
                      className={css.menuItem}
                      disabled={busy}
                      onClick={() => { setMenuOpen(false); void copyPath() }}
                    >
                      {tt('list.copyPath')}
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
        {notice !== undefined && <p className={css.banner} data-kind="ok">{notice}</p>}
      </div>
    </article>
  )
}

/** The skills tab body. */
export function SkillsTab({ api, onEdit, onImport, onDuplicate, onSelectTab }: {
  api: SkillApi
  onEdit: (skill: SkillEntry) => void
  onImport: () => void
  onDuplicate: (draft: SkillDraft) => void
  /** Switch the panel to another tab (the command palette's navigation rows). */
  onSelectTab: (tab: 'market' | 'create' | 'import' | 'backup') => void
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [presetState, setPresetState] = useState<PresetListPayload | undefined>(undefined)
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')
  const [presetRoots, setPresetRoots] = useState<SkillRootKey[]>([])
  const [presetBusy, setPresetBusy] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [batchMenuOpen, setBatchMenuOpen] = useState(false)
  const batchMenuRef = useRef<HTMLDivElement>(null)
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(() => new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [checkingAll, setCheckingAll] = useState(false)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [statusNotice, setStatusNotice] = useState<{ kind: 'info' | 'success' | 'error'; text: string } | null>(null)
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
  useEffect(() => { void loadPresets() }, [api])

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

  const handleCheckAll = async (): Promise<void> => {
    if (checkingAll) return
    setCheckingAll(true)
    setStatusNotice({ kind: 'info', text: '正在检查全部技能的远端更新状态...' })
    try {
      const res = await api.checkAll()
      const summary = res.summary
      await load()
      const avail = summary?.updateAvailable ?? 0
      const errors = summary?.errors ?? 0
      setStatusNotice({
        kind: avail > 0 ? 'info' : 'success',
        text: `检查完成：共 ${summary?.total ?? 0} 个技能，${avail} 个有新版本${errors > 0 ? `，${errors} 个检查出错` : ''}。`,
      })
    } catch (err: unknown) {
      setStatusNotice({
        kind: 'error',
        text: `检查更新失败: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      setCheckingAll(false)
    }
  }

  const handleUpdateAll = async (): Promise<void> => {
    if (updatingAll) return
    setUpdatingAll(true)
    setStatusNotice({ kind: 'info', text: '正在拉取最新版本并批量更新技能...' })
    try {
      const res = await api.updateAll()
      const summary = res.summary
      await load()
      setStatusNotice({
        kind: 'success',
        text: `全部更新完成：成功更新 ${summary?.updated ?? 0} 个技能${summary?.failed > 0 ? `，${summary?.failed} 个失败` : ''}。`,
      })
    } catch (err: unknown) {
      setStatusNotice({
        kind: 'error',
        text: `批量更新失败: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      setUpdatingAll(false)
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
    // One refused skill must not abandon the rest of the selection: keep going
    // and report every failure instead of the first one only.
    const failures: string[] = []
    try {
      for (const s of deletableSkills) {
        if (s.path === undefined) continue
        try {
          await api.remove(s.name, s.path)
        } catch (err) {
          failures.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      setSelectedSkills(new Set())
      setStatusNotice(failures.length === 0
        ? { kind: 'success', text: tt('list.batchDeleteDone', { count: String(deletableSkills.length) }) }
        : { kind: 'error', text: tt('list.batchDeletePartial', { count: String(deletableSkills.length - failures.length), failed: failures.join('; ') }) })
    } finally {
      try { await load() } catch {}
      setBatchBusy(false)
    }
  }

  // Ctrl/Cmd+K opens the palette: the shortcut exists exactly for when the user
  // does not know where the thing they want lives.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  /** Reload the stored presets and the deployment records behind the bar. */
  const loadPresets = async (): Promise<void> => {
    try {
      const next = await api.listPresets()
      setPresetState(next)
      // Default the activation targets to whatever is already deployed, so
      // re-activating keeps writing where the user last chose.
      setPresetRoots(current => current.length > 0
        ? current
        : [...new Set(next.deployments.map((entry) => entry.root_key))])
    } catch {
      // A store that cannot be read leaves the bar absent rather than breaking
      // the skill list, which is the panel's main job.
    }
  }

  const handleSavePreset = async (): Promise<void> => {
    if (payload === undefined) return
    const name = window.prompt(tt('preset.namePrompt'))
    if (!name || !name.trim()) return
    // A new preset starts from what the model can see right now, which is the
    // only membership definition the panel can observe.
    const enabledSkills = payload.groups
      .flatMap(g => g.skills)
      .filter(s => s.modelInvocable)
      .map(s => s.name)
    setPresetBusy(true)
    try {
      await api.savePreset({ name: name.trim(), skillNames: enabledSkills })
      await loadPresets()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPresetBusy(false)
    }
  }

  const handleDeletePreset = async (presetId: string): Promise<void> => {
    setPresetBusy(true)
    try {
      await api.deletePreset(presetId)
      if (selectedPresetId === presetId) setSelectedPresetId('')
      await loadPresets()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPresetBusy(false)
    }
  }

  /**
   * Activate a preset: the host deploys its members into the selected roots and
   * takes back the skills it does not own, then we refresh both views.
   */
  const handleActivatePreset = async (preset: SkillPresetRecord): Promise<void> => {
    if (presetBusy) return
    setPresetBusy(true)
    setError(undefined)
    try {
      const result = await api.applyPreset({
        id: preset.id,
        ...(presetRoots.length > 0 ? { roots: presetRoots } : {}),
        cwd: payload?.cwd,
      })
      // Refusals are per skill, so they are reported together rather than
      // throwing: the moment one directory is someone else's, the rest of the
      // activation is still worth completing.
      const refused = result.deployed.filter((entry) => !entry.deployed && entry.reason !== undefined)
      if (refused.length > 0) {
        setStatusNotice({
          kind: 'info',
          text: refused.map((entry) => `${entry.skillName}: ${entry.reason}`).join('; '),
        })
      } else {
        setStatusNotice({
          kind: 'success',
          text: `${tt('preset.activated')}: ${result.deployed.filter((entry) => entry.deployed).length}`,
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      try { await load() } catch {}
      await loadPresets()
      setPresetBusy(false)
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
  const updateCount = payload.updateAvailableCount ?? payload.groups.flatMap(g => g.skills).filter(s => s.updateStatus === 'update_available').length
  const emptyText = query.trim() !== ''
    ? tt('filter.empty', { query: query.trim() })
    : narrowed ? tt('filter.emptyWorkspace') : tt('list.empty')

  return (
    <div className={css.fillBody}>
      <div className={css.toolbar} data-dsh-part="filter-bar">
        <div className={css.headerTitleGroup}>
          <h1 className={css.headerTitle}>
            {tt('list.installedSkills')} ({narrowed ? `${visibleCount}/${totalCount}` : totalCount})
          </h1>
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
          <button
            type="button"
            className={css.toolbarActionBtn}
            disabled={checkingAll || loading}
            onClick={() => { void handleCheckAll() }}
            title="检查全部技能的远端更新状态"
          >
            <svg
              className={checkingAll ? css.spinning : undefined}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>{checkingAll ? '检查中...' : '检查全部'}</span>
          </button>
          <button
            type="button"
            className={`${css.toolbarActionBtn}${updateCount > 0 ? ` ${css.toolbarActionBtnPrimary}` : ''}`}
            disabled={updatingAll || updateCount === 0 || loading}
            onClick={() => { void handleUpdateAll() }}
            title={updateCount > 0 ? `更新全部 ${updateCount} 个有新版本的技能` : '当前暂无可用更新'}
          >
            <svg
              className={updatingAll ? css.spinning : undefined}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>{updatingAll ? '更新中...' : `全部更新 (${updateCount})`}</span>
          </button>
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
      {/* The preset bar is the deployment control: a chip's mark says whether
          the model currently sees exactly this set of skills, some of them, or
          none. It sits outside batch mode because activating a preset is not a
          batch operation on the selection. */}
      {presetState !== undefined && presetState.presets.length > 0 && (
        <div className={css.presetBar} data-dsh-part="preset-bar">
          <span className={css.presetBarLabel}>{tt('preset.barLabel')}</span>
          {presetState.presets.map((preset) => {
            const deployedNames = new Set(
              presetState.deployments
                .filter((entry) => entry.preset_id === preset.id)
                .map((entry) => entry.skill_name),
            )
            const active = presetState.activeId === preset.id
            const installed = preset.skillNames.filter((name) => deployedNames.has(name)).length
            const total = preset.skillNames.length
            const mark = active && installed === total ? '\u2713' : installed > 0 ? `${installed}/${total}` : undefined
            const absent = presetState.deployments
              .filter((entry) => entry.preset_id === preset.id && !preset.skillNames.includes(entry.skill_name))
              .length
            return (
              <span key={preset.id} className={css.presetChipWrapper}>
                <button
                  type="button"
                  className={`${css.presetChip}${active ? ` ${css.presetChipActive}` : ''}`}
                  disabled={presetBusy}
                  aria-pressed={active}
                  title={preset.skillNames.join(', ')}
                  onClick={() => { void handleActivatePreset(preset) }}
                >
                  {preset.name}
                  {mark !== undefined && <span className={css.presetChipMark}>{mark}</span>}
                  {absent > 0 && <span className={css.presetChipStale}>{`-${absent}`}</span>}
                </button>
                <button
                  type="button"
                  className={css.presetChipDelete}
                  disabled={presetBusy}
                  aria-label={tt('preset.delete')}
                  title={tt('preset.delete')}
                  onClick={() => {
                    if (window.confirm(tt('preset.deleteConfirm'))) void handleDeletePreset(preset.id)
                  }}
                >
                  {'\u00d7'}
                </button>
              </span>
            )
          })}
          <select
            className={css.select}
            disabled={presetBusy}
            aria-label={tt('preset.rootLabel')}
            value={presetRoots[0] ?? ''}
            onChange={(e) => { setPresetRoots(e.target.value === '' ? [] : [e.target.value as SkillRootKey]) }}
          >
            <option value="">{tt('preset.rootAll')}</option>
            {presetState.roots.map((root) => (
              <option key={root} value={root}>{tt(`preset.root.${root}`)}</option>
            ))}
          </select>
        </div>
      )}
      {statusNotice && (
        <div
          className={`${css.statusNotice} ${
            statusNotice.kind === 'success'
              ? css.statusNoticeSuccess
              : statusNotice.kind === 'error'
                ? css.statusNoticeError
                : css.statusNoticeInfo
          }`}
        >
          <span>{statusNotice.text}</span>
          <button
            type="button"
            className={css.iconActionBtn}
            onClick={() => setStatusNotice(null)}
            title="关闭通知"
            aria-label="关闭通知"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
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
          <button type="button" className={css.batchActionBtn} disabled={batchBusy || presetBusy} onClick={() => { void handleSavePreset() }}>
            {tt('preset.save')}
          </button>
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => { setPaletteOpen(false) }}
        skills={payload.groups.flatMap(group => group.skills)}
        presets={presetState}
        onSelectSkill={(skill) => { setDetailSkill(skill) }}
        onActivatePreset={(presetId) => {
          const preset = presetState?.presets.find(item => item.id === presetId)
          if (preset !== undefined) void handleActivatePreset(preset)
        }}
        onSelectTab={onSelectTab}
        onCheckAll={() => { void handleCheckAll() }}
        onUpdateAll={() => { void handleUpdateAll() }}
      />
      <DetailDrawer
        skill={detailSkill}
        api={api}
        onClose={() => { setDetailSkill(null) }}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onChanged={() => { void load() }}
      />
    </div>
  )
}

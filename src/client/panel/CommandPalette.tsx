/**
 * Command palette (Ctrl/Cmd+K): jump to a skill, a preset, or a panel action.
 *
 * The panel is a single page with five tabs and a list of skills, so the slow
 * part of using it is not any one control — it is finding which control. One
 * keyboard-reachable list that searches skills, presets and actions together
 * removes that whole class of hunt, and it is the one affordance here whose cost
 * is a single filter over data the tab already holds.
 *
 * Matching reuses the list's own normalization (dashes, underscores and spaces
 * are equivalent), so a query that finds a skill in the search box finds it here
 * too, rather than there being two search behaviours to learn.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PresetListPayload, SkillEntry } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import css from './panel.module.css'

/** One row the palette can run. */
export interface PaletteCommand {
  /** Stable id, used as the list key and for the test hook. */
  id: string
  /** What the row shows. */
  label: string
  /** Which group the row belongs to, for the section heading. */
  group: 'skills' | 'presets' | 'actions'
  /** Extra text matched against the query, beyond the label. */
  keywords?: string
  /** Runs when the row is chosen. */
  run: () => void
}

/**
 * Normalize a query the way the skill list does.
 * @param value - raw text.
 * @returns lowercased text with separators collapsed to single spaces.
 */
export function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/[-_\s]+/gu, ' ').trim()
}

/**
 * Rank commands against a query.
 *
 * An exact label outranks a label prefix, which outranks a mid-label hit, which
 * outranks a keywords hit: typing a skill's whole name puts that skill first
 * even when an action shares the word. Ties keep the incoming order, which is
 * the order the caller listed them in.
 * @param commands - every command.
 * @param query - what the user typed.
 * @returns the matching commands, best first.
 */
export function rankCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const needle = normalizeQuery(query)
  if (needle === '') return [...commands]
  const scored: Array<{ command: PaletteCommand; score: number; order: number }> = []
  commands.forEach((command, order) => {
    const label = normalizeQuery(command.label)
    const keywords = normalizeQuery(command.keywords ?? '')
    if (label === needle) scored.push({ command, score: 0, order })
    else if (label.startsWith(needle)) scored.push({ command, score: 1, order })
    else if (label.includes(needle)) scored.push({ command, score: 2, order })
    else if (keywords.includes(needle)) scored.push({ command, score: 3, order })
  })
  return scored
    .sort((left, right) => (left.score - right.score) || (left.order - right.order))
    .map((entry) => entry.command)
}

/** Props for the palette. */
export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  /** Every skill the list currently holds. */
  skills: readonly SkillEntry[]
  /** Stored presets, when they have loaded. */
  presets: PresetListPayload | undefined
  /** Open one skill's detail drawer. */
  onSelectSkill: (skill: SkillEntry) => void
  /** Activate a preset. */
  onActivatePreset: (presetId: string) => void
  /** Switch to a tab. */
  onSelectTab: (tab: 'market' | 'create' | 'import' | 'backup') => void
  /** Start check-all. */
  onCheckAll: () => void
  /** Start update-all. */
  onUpdateAll: () => void
}

/** The palette dialog. Renders nothing while closed. */
export function CommandPalette({
  open,
  onClose,
  skills,
  presets,
  onSelectSkill,
  onActivatePreset,
  onSelectTab,
  onCheckAll,
  onUpdateAll,
}: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Every query starts from an empty box and the first row selected.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    inputRef.current?.focus()
  }, [open])

  // Close on Escape wherever focus sits inside the dialog.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])

  const commands = useMemo<PaletteCommand[]>(() => {
    const rows: PaletteCommand[] = []
    for (const skill of skills) {
      rows.push({
        id: `skill:${skill.name}`,
        label: skill.name,
        group: 'skills',
        keywords: `${skill.description ?? ''} ${skill.whenToUse ?? ''}`,
        run: () => { onSelectSkill(skill) },
      })
    }
    for (const preset of presets?.presets ?? []) {
      rows.push({
        id: `preset:${preset.id}`,
        label: preset.name,
        group: 'presets',
        keywords: preset.skillNames.join(' '),
        run: () => { onActivatePreset(preset.id) },
      })
    }
    rows.push(
      { id: 'action:market', label: tt('tab.market'), group: 'actions', run: () => { onSelectTab('market') } },
      { id: 'action:create', label: tt('tab.create'), group: 'actions', run: () => { onSelectTab('create') } },
      { id: 'action:import', label: tt('tab.import'), group: 'actions', run: () => { onSelectTab('import') } },
      { id: 'action:backup', label: tt('tab.backup'), group: 'actions', run: () => { onSelectTab('backup') } },
      { id: 'action:check-all', label: tt('palette.checkAll'), group: 'actions', run: onCheckAll },
      { id: 'action:update-all', label: tt('palette.updateAll'), group: 'actions', run: onUpdateAll },
    )
    return rows
  }, [skills, presets, onSelectSkill, onActivatePreset, onSelectTab, onCheckAll, onUpdateAll])

  const matches = useMemo(() => rankCommands(commands, query).slice(0, 50), [commands, query])

  // A shorter result list must not leave the cursor past its end.
  useEffect(() => {
    setCursor((current) => (current >= matches.length ? 0 : current))
  }, [matches.length])

  if (!open) return null

  const choose = (command: PaletteCommand | undefined): void => {
    if (command === undefined) return
    onClose()
    command.run()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((current) => (matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(matches[cursor])
    }
  }

  let lastGroup: PaletteCommand['group'] | undefined
  return (
    <div className={css.paletteOverlay} data-dsh-part="command-palette" role="presentation" onClick={onClose}>
      <div className={css.paletteDialog} role="dialog" aria-modal="true" aria-label={tt('palette.title')} onClick={(event) => { event.stopPropagation() }}>
        <input
          ref={inputRef}
          className={css.paletteInput}
          type="text"
          value={query}
          placeholder={tt('palette.placeholder')}
          aria-label={tt('palette.placeholder')}
          onChange={(event) => { setQuery(event.target.value); setCursor(0) }}
          onKeyDown={onKeyDown}
        />
        {matches.length === 0 ? (
          <p className={css.paletteEmpty}>{tt('palette.empty')}</p>
        ) : (
          <ul className={css.paletteList}>
            {matches.map((command, index) => {
              const heading = command.group === lastGroup ? undefined : tt(`palette.group.${command.group}`)
              lastGroup = command.group
              return (
                <li key={command.id}>
                  {heading !== undefined && <div className={css.paletteGroup}>{heading}</div>}
                  <button
                    type="button"
                    className={`${css.paletteRow}${index === cursor ? ` ${css.paletteRowActive}` : ''}`}
                    data-command={command.id}
                    onMouseEnter={() => { setCursor(index) }}
                    onClick={() => { choose(command) }}
                  >
                    {command.label}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

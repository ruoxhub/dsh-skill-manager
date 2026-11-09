/**
 * Skill detail modal for an installed skill: the centered card the skill list
 * opens on a row click. It shows the summary, the enable switch, the edit /
 * copy-path actions and the SKILL.md body with an in-document search.
 *
 * Modeled after the skill-manager detail sheet: one card, one scroll panel,
 * every action reachable from the header instead of a meta table.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkillApi, SkillEntry } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import type { SkillDraft } from './controller.ts'
import { DetailMenu, DetailModal, DocBody, type DetailMenuItem } from './detail-modal.tsx'
import {
  canToggle,
  duplicateSkillName,
  getAvatarLetter,
  getAvatarPalette,
  invokableMarks,
  providerLabel,
  skillDirPath,
} from './skill-present.ts'
import css from './panel.module.css'

export interface DetailDrawerProps {
  /** The skill to view, or null if the dialog is closed. */
  skill: (SkillEntry & { content?: string }) | null
  /** API client for reading the instruction body and mutating state. */
  api: SkillApi
  /** Dismiss callback. */
  onClose: () => void
  /** Jump to edit tab. */
  onEdit?: (skill: SkillEntry) => void
  /** Jump to create tab prefilled with this skill. */
  onDuplicate?: (draft: SkillDraft) => void
  /** Refresh the list after the dialog changed a skill. */
  onChanged?: () => void
}

/** The error text of an unknown rejection. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function DetailDrawer({ skill, api, onClose, onEdit, onDuplicate, onChanged }: DetailDrawerProps): React.JSX.Element | null {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  // Sync ref guard: state updates are async, so a double click before the
  // re-render would fire the same request twice.
  const busyRef = useRef(false)

  const skillName = skill?.name

  useEffect(() => {
    setQuery('')
    setNotice(undefined)
  }, [skillName])

  useEffect(() => {
    setEnabled(skill?.modelInvocable ?? false)
    setUpdateAvailable(skill?.updateStatus === 'update_available')
  }, [skill])

  // Fetch the markdown body when an editable skill is open.
  useEffect(() => {
    if (!skill) {
      setContent(null)
      setError(undefined)
      return
    }

    if (skill.content !== undefined) {
      setContent(skill.content)
      setLoading(false)
      setError(undefined)
      return
    }

    if (!skill.path) {
      setContent(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(undefined)

    void api.read(skill.name, skill.path)
      .then((res) => {
        if (!cancelled) {
          setContent(res.content)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(errorText(err))
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [skill, api])

  const canEdit = Boolean(skill?.path && !skill.linked && onEdit)
  const canCopy = Boolean(skill && (skill.path || skill.content !== undefined) && onDuplicate && content !== null)
  const palette = useMemo(() => getAvatarPalette(skill?.name ?? ''), [skill?.name])
  const letter = useMemo(() => getAvatarLetter(skill?.name ?? ''), [skill?.name])

  if (!skill) return null

  const run = async (action: () => Promise<void>, failure: (error: unknown) => string): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await action()
    } catch (err: unknown) {
      setError(failure(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleToggle = (): void => {
    if (!canToggle(skill)) return
    void run(async () => {
      if (skill.path !== undefined) await api.setEnabled(skill.name, skill.path, !enabled)
      else await api.setProviderEnabled(skill.name, skill.provider, !enabled)
      setEnabled(current => !current)
      onChanged?.()
    }, err => tt('list.toggleFailed', { error: errorText(err) }))
  }

  const handleCopyPath = (): void => {
    if (skill.path === undefined) return
    void run(async () => {
      await navigator.clipboard.writeText(skillDirPath(skill.path!))
      setNotice(tt('list.copyPathDone'))
    }, () => tt('list.copyPathFailed'))
  }

  const handleDuplicate = (): void => {
    if (!onDuplicate || content === null) return
    onDuplicate({
      from: skill.name,
      name: duplicateSkillName(skill.name),
      description: skill.description,
      whenToUse: skill.whenToUse,
      content,
    })
    onClose()
  }

  const handleCheckUpdate = (): void => {
    void run(async () => {
      const result = await api.checkOne(skill.name)
      setUpdateAvailable(result.result?.updateStatus === 'update_available')
      setNotice(tt('detail.checkDone'))
      onChanged?.()
    }, err => tt('detail.checkFailed', { error: errorText(err) }))
  }

  const handleUpdate = (): void => {
    void run(async () => {
      await api.updateOne(skill.name)
      setNotice(tt('detail.updated'))
      onChanged?.()
    }, err => tt('detail.updateFailed', { error: errorText(err) }))
  }

  const handleRemove = (): void => {
    if (skill.path === undefined) return
    if (!window.confirm(tt('list.deleteConfirm', { name: skill.name }))) return
    void run(async () => {
      await api.remove(skill.name, skill.path!)
      onChanged?.()
      onClose()
    }, err => tt('list.deleteFailed', { error: errorText(err) }))
  }

  const menuItems: DetailMenuItem[] = []
  if (canCopy) menuItems.push({ key: 'duplicate', label: tt('list.duplicate'), onSelect: handleDuplicate, disabled: busy })
  menuItems.push({ key: 'check', label: tt('detail.checkUpdate'), onSelect: handleCheckUpdate, disabled: busy })
  if (updateAvailable) menuItems.push({ key: 'update', label: tt('detail.updateNow'), onSelect: handleUpdate, disabled: busy })
  if (skill.path !== undefined && skill.linked !== true) {
    menuItems.push({ key: 'delete', label: tt('list.delete'), onSelect: handleRemove, danger: true, disabled: busy })
  }

  const summary = skill.whenToUse === undefined || skill.whenToUse === ''
    ? skill.description
    : `${skill.description}\n\n${tt('detail.whenToUse')} ${skill.whenToUse}`

  const breadcrumbs: string[] = []
  if (skill.workspaceName !== undefined) breadcrumbs.push(skill.workspaceName)
  if (skill.provider !== undefined) breadcrumbs.push(providerLabel(skill.provider))
  if (skill.linked === true) breadcrumbs.push(tt('list.linked'))
  const invokable = invokableMarks(skill)
  if (invokable !== '') breadcrumbs.push(tt('list.invokable', { marks: invokable }))
  if (updateAvailable) breadcrumbs.push(tt('detail.updateAvailable'))

  return (
    <DetailModal
      label={skill.name}
      dataPart="detail-dialog"
      icon={(
        <div className={css.modalLetterTile} style={{ backgroundColor: palette.bg, color: palette.color }} aria-hidden="true">
          {letter}
        </div>
      )}
      title={<span className={css.modalTitleText}>{skill.name}</span>}
      meta={breadcrumbs.length === 0
        ? undefined
        : breadcrumbs.map((fact, index) => (
          <span key={`${fact}:${index}`} className={css.modalFact}>{fact}</span>
        ))}
      aside={canToggle(skill) ? (
        <button
          type="button"
          className={css.modalSwitch}
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? tt('list.enabled') : tt('list.disabled')}
          title={enabled ? tt('list.enabled') : tt('list.disabled')}
          disabled={busy}
          onClick={handleToggle}
          data-dsh-action="detail-toggle"
        >
          <span className={css.switchTrack}><span className={css.switchThumb} /></span>
        </button>
      ) : undefined}
      actions={(
        <>
          {canEdit && (
            <button
              type="button"
              className={css.modalPrimary}
              disabled={busy}
              onClick={() => { onEdit?.(skill); onClose() }}
            >
              {tt('list.edit')}
            </button>
          )}
          {!canEdit && canCopy && (
            <button type="button" className={css.modalPrimary} disabled={busy} onClick={handleDuplicate}>
              {tt('list.duplicate')}
            </button>
          )}
          {skill.path !== undefined && (
            <button type="button" className={css.modalSecondary} disabled={busy} onClick={handleCopyPath}>
              {tt('list.copyPath')}
            </button>
          )}
          <DetailMenu label={tt('list.more')} items={menuItems} />
        </>
      )}
      description={summary}
      bar={(
        <>
          <svg className={css.modalBarIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="7" y1="9" x2="17" y2="9" />
            <line x1="7" y1="13" x2="14" y2="13" />
          </svg>
          <span className={css.modalBarTitle}>{tt('detail.overview')}</span>
        </>
      )}
      search={content === null ? undefined : {
        value: query,
        onChange: setQuery,
        placeholder: tt('detail.searchPlaceholder'),
      }}
      onClose={onClose}
    >
      {error !== undefined && <p className={css.banner} data-kind="error">{error}</p>}
      {notice !== undefined && <p className={css.banner} data-kind="ok">{notice}</p>}
      {loading && <p className={css.empty}>{tt('detail.loading')}</p>}
      {!loading && content === null && skill.path === undefined && (
        <p className={css.note}>{tt('detail.noFile')}</p>
      )}
      {!loading && content !== null && (
        <DocBody
          content={content}
          query={query}
          emptyText={tt('detail.searchEmpty', { query: query.trim() })}
        />
      )}
    </DetailModal>
  )
}

/**
 * Skill Detail Drawer: in-place preview for a skill's full SKILL.md body,
 * metadata, when-to-use guide, and quick action shortcuts (edit, duplicate).
 *
 * Modeled after skills-manager DetailSheet/SkillDetailPanel with native DSH
 * styling and zero third-party dependencies.
 */
import { useEffect, useRef, useState } from 'react'
import type { SkillApi, SkillEntry } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import type { SkillDraft } from './controller.ts'
import css from './panel.module.css'

export interface DetailDrawerProps {
  /** The skill to view, or null if drawer is closed. */
  skill: (SkillEntry & { content?: string }) | null
  /** API client for reading the instruction body. */
  api: SkillApi
  /** Dismiss callback. */
  onClose: () => void
  /** Jump to edit tab. */
  onEdit?: (skill: SkillEntry) => void
  /** Jump to create tab prefilled with this skill. */
  onDuplicate?: (draft: SkillDraft) => void
}

export function DetailDrawer({ skill, api, onClose, onEdit, onDuplicate }: DetailDrawerProps): React.JSX.Element | null {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  // Listen for Escape key to close the drawer.
  useEffect(() => {
    if (!skill) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => { window.removeEventListener('keydown', handleKeyDown) }
  }, [skill, onClose])

  // Focus close button on open for accessibility.
  useEffect(() => {
    if (skill) {
      closeBtnRef.current?.focus()
    }
  }, [skill])

  // Fetch full markdown body when an editable skill is open.
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
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [skill, api])

  if (!skill) return null

  const canEdit = Boolean(skill.path && !skill.linked && onEdit)
  const canCopy = Boolean((skill.path || skill.content !== undefined) && onDuplicate && content !== null)

  const handleDuplicate = () => {
    if (!onDuplicate) return
    onDuplicate({
      from: skill.name,
      name: `${skill.name}-copy`,
      description: skill.description,
      whenToUse: skill.whenToUse,
      content: content ?? '',
    })
    onClose()
  }

  const handleEdit = () => {
    if (!onEdit) return
    onEdit(skill)
    onClose()
  }

  const invokableText = [
    skill.modelInvocable && tt('list.mark.model'),
    skill.userInvocable && tt('list.mark.user'),
  ].filter(Boolean).join(' / ') || tt('detail.invokableNone')

  return (
    <>
      <div className={css.drawerBackdrop} onClick={onClose} aria-hidden="true" />
      <aside className={css.drawerContainer} role="dialog" aria-modal="true" aria-label={skill.name}>
        <div className={css.drawerHeader}>
          <div className={css.drawerTitleGroup}>
            <h2 className={css.drawerTitle} title={skill.name}>{skill.name}</h2>
          </div>
          <div className={css.drawerActions}>
            {canCopy && (
              <button
                type="button"
                className={css.button}
                onClick={handleDuplicate}
              >
                {tt('list.duplicate')}
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                className={`${css.button} ${css.buttonPrimary}`}
                onClick={handleEdit}
              >
                {tt('list.edit')}
              </button>
            )}
            <button
              ref={closeBtnRef}
              type="button"
              className={css.iconActionBtn}
              onClick={onClose}
              aria-label={tt('detail.close')}
              title={tt('detail.closeTooltip')}
              data-close=""
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className={css.drawerBody}>
          <div className={css.drawerMeta}>
            <div className={css.drawerMetaRow}>
              <span className={css.drawerMetaLabel}>{tt('detail.desc')}</span>
              <span className={css.drawerMetaValue}>{skill.description}</span>
            </div>
            {skill.whenToUse && (
              <div className={css.drawerMetaRow}>
                <span className={css.drawerMetaLabel}>{tt('detail.whenToUse')}</span>
                <span className={css.drawerMetaValue}>{skill.whenToUse}</span>
              </div>
            )}
            {skill.workspaceName && (
              <div className={css.drawerMetaRow}>
                <span className={css.drawerMetaLabel}>{tt('detail.workspace')}</span>
                <span className={css.drawerMetaValue}>{skill.workspaceName}</span>
              </div>
            )}
            {skill.path && (
              <div className={css.drawerMetaRow}>
                <span className={css.drawerMetaLabel}>{tt('detail.path')}</span>
                <span className={css.drawerMetaValue}>{skill.path}</span>
              </div>
            )}
            <div className={css.drawerMetaRow}>
              <span className={css.drawerMetaLabel}>{tt('detail.invokable')}</span>
              <span className={css.drawerMetaValue}>{invokableText}</span>
            </div>
          </div>

          {loading && <p className={css.empty}>{tt('detail.loading')}</p>}
          {error && <p className={css.banner} data-kind="error">{error}</p>}
          {!loading && !error && content !== null && (
            <pre className={css.drawerContentPre}>{content}</pre>
          )}
          {!loading && !error && !skill.path && content === null && (
            <p className={css.note}>{tt('detail.noFile')}</p>
          )}
        </div>
      </aside>
    </>
  )
}

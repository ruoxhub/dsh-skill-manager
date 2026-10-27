/**
 * Edit tab: the in-place editor for one skill.
 *
 * The list carries metadata only, so the host re-reads the file before the form
 * is shown and writes it back on save; the name and the location are fixed, and
 * the enabled state keeps its own control on the row.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { SkillApi, type SkillEntry } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import css from './panel.module.css'

/** Edit tab props. */
export interface EditTabProps {
  /** The skill center API client. */
  api: SkillApi
  /** The skill whose file this form rewrites. */
  skill: SkillEntry
  /** Called after a successful save: the list refetches on the way back. */
  onDone: () => void
  /** Called when the user leaves without saving. */
  onCancel: () => void
}

/** The edit tab body. */
export function EditTab({ api, skill, onDone, onCancel }: EditTabProps): React.JSX.Element {
  const skillPath = skill.path ?? ''
  const [description, setDescription] = useState('')
  const [whenToUse, setWhenToUse] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const current = await api.read(skill.name, skillPath)
        if (cancelled) return
        setDescription(current.description)
        setWhenToUse(current.whenToUse ?? '')
        setContent(current.content)
        setError(undefined)
      } catch (err) {
        if (cancelled) return
        setError(tt('edit.loadFailed', { error: err instanceof Error ? err.message : String(err) }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [api, skill.name, skillPath])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (description.trim() === '' || content.trim() === '') {
      setError(tt('create.empty'))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      await api.update({ name: skill.name, path: skillPath, description: description.trim(), whenToUse: whenToUse.trim() || undefined, content })
      onDone()
    } catch (err) {
      setError(tt('edit.failed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className={css.tabBody}>
        <p className={css.empty}>{tt('edit.loading')}</p>
      </div>
    )
  }

  return (
    <div className={css.tabBody}>
      <form className={css.form} onSubmit={(event) => { void submit(event) }}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{tt('edit.name')}</span>
          <input className={css.input} value={skill.name} readOnly />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{tt('create.description')}</span>
          <input className={css.input} value={description} onChange={(event) => { setDescription(event.target.value) }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{tt('create.whenToUse')}</span>
          <input className={css.input} value={whenToUse} onChange={(event) => { setWhenToUse(event.target.value) }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{tt('create.content')}</span>
          <textarea className={`${css.input} ${css.textarea}`} value={content} onChange={(event) => { setContent(event.target.value) }} />
        </label>
        <div className={css.formActions}>
          <button type="button" className={css.ghostButton} disabled={busy} onClick={onCancel}>{tt('edit.back')}</button>
          <button type="submit" className={css.primaryButton} disabled={busy}>{tt('edit.submit')}</button>
        </div>
        {error !== undefined && <p className={css.banner} data-kind="error">{error}</p>}
        <p className={css.note}>{tt('edit.note')}</p>
      </form>
    </div>
  )
}

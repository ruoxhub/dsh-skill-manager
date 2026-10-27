import { useState } from 'react'
import { tt } from '../panel-helpers.ts'
import css from './panel.module.css'

export interface AddMarketplaceModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (source: string, name?: string) => Promise<void>
}

export function AddMarketplaceModal({ isOpen, onClose, onSubmit }: AddMarketplaceModalProps): React.JSX.Element | null {
  const [source, setSource] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = source.trim()
    if (!trimmed) {
      setError(tt('suite.sourceRequired' as any) || '市场源不能为空')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(trimmed)
      setSource('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={css.modalOverlay} role="dialog" aria-modal="true" aria-labelledby="add-marketplace-title">
      <div className={css.modalBackdrop} onClick={onClose} />
      <div className={css.suiteModalCard}>
        <div className={css.suiteModalHeader}>
          <h3 id="add-marketplace-title" className={css.suiteModalTitle}>
            {tt('suite.addMarketplace' as any) || '添加市场'}
          </h3>
          <button
            type="button"
            className={css.suiteModalCloseBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={css.suiteModalBody}>
            <label className={css.suiteModalLabel}>
              {tt('suite.sourceLabel' as any) || '市场源'} <span className={css.suiteRequiredStar}>*</span>
            </label>
            <input
              type="text"
              className={css.suiteModalInput}
              value={source}
              placeholder="owner/repo 或 https://..."
              autoFocus
              disabled={submitting}
              onChange={e => {
                setSource(e.target.value)
                if (error) setError(null)
              }}
            />
            <div className={css.suiteModalHint}>
              示例：owner/repo（GitHub）、git@github.com:owner/repo.git（SSH）、https://example.com/marketplace.zip（ZIP）、./path/to/marketplace（本地）
            </div>

            {error && (
              <div className={css.suiteModalError}>{error}</div>
            )}
          </div>

          <div className={css.suiteModalFooter}>
            <button
              type="button"
              className={css.suiteModalCancelBtn}
              onClick={onClose}
              disabled={submitting}
            >
              {tt('suite.cancel' as any) || '取消'}
            </button>
            <button
              type="submit"
              className={css.suiteModalSubmitBtn}
              disabled={submitting || !source.trim()}
            >
              {submitting ? (tt('suite.submitting' as any) || '正在添加…') : (tt('suite.submit' as any) || '提交')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

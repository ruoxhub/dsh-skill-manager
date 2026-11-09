/**
 * Backup tab: the library's git repository, its snapshots, and its remote.
 *
 * The library directory is a plain git repository, so this tab is thin: it
 * reads the repository's state, asks for a commit (with or without a snapshot
 * tag), and lists the tags it can restore. Every operation reports what actually
 * happened — a rejected push is shown as a failure of the push, not of the
 * backup, because the commit already landed locally.
 *
 * Restoring is the one destructive action here, so it goes through a confirm and
 * the host commits the current state first; the response names that safety
 * commit, which is the way back.
 */
import { useEffect, useState } from 'react'
import { SkillApi, type BackupSnapshotEntry, type BackupStatusPayload } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import css from './panel.module.css'

/** Localized health badge for the repository state. */
function healthLabel(status: BackupStatusPayload): string {
  return tt(`backup.health.${status.health}`)
}

/** Render a snapshot's timestamp in the browser's locale. */
function when(timestamp: number): string {
  if (timestamp === 0) return ''
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return ''
  }
}

/** The backup tab body. */
export function BackupTab({ api }: { api: SkillApi }): React.JSX.Element {
  const [status, setStatus] = useState<BackupStatusPayload | undefined>(undefined)
  const [snapshots, setSnapshots] = useState<BackupSnapshotEntry[]>([])
  const [remote, setRemote] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'info' | 'success' | 'error'; text: string } | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    try {
      const next = await api.backupStatus()
      setStatus(next)
      setRemote((current) => (current === '' ? next.remoteUrl ?? '' : current))
      const listed = await api.backupSnapshots()
      setSnapshots(listed.snapshots)
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  useEffect(() => {
    void refresh()
  }, [api])

  /** Run one action, reporting its own outcome rather than a generic message. */
  const run = async (action: () => Promise<string>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice(undefined)
    try {
      setNotice({ kind: 'success', text: await action() })
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  const handleInit = (): void => {
    void run(async () => {
      const next = await api.initBackup()
      return next.isRepo ? tt('backup.initialized') : tt('backup.initFailed')
    })
  }

  const handleBackup = (push: boolean): void => {
    void run(async () => {
      const result = await api.backupCommit({ message: tt('backup.defaultMessage'), snapshot: true, remote: push })
      if (!result.ok) {
        // The commit succeeded and only the push failed; saying so keeps the
        // user from thinking their skills are still unbacked.
        return tt('backup.pushFailed', { error: result.error ?? '' })
      }
      return result.tag === null ? tt('backup.committed') : tt('backup.snapshotCreated', { tag: result.tag })
    })
  }

  const handleRestore = (tag: string): void => {
    if (!window.confirm(tt('backup.restoreConfirm', { tag }))) return
    void run(async () => {
      const result = await api.restoreBackup(tag)
      return tt('backup.restored', { commit: result.safetyCommit.slice(0, 7) })
    })
  }

  const handleRemote = (): void => {
    void run(async () => {
      const next = await api.setBackupRemote(remote)
      return tt('backup.remoteSet', { url: next.remoteUrl ?? '' })
    })
  }

  return (
    <div className={css.tabBody} data-dsh-part="backup-tab">
      <div className={css.statusNotice}>
        <span>{status === undefined ? tt('backup.loading') : healthLabel(status)}</span>
        {status !== undefined && status.changedSkillCount > 0 && (
          <span>{tt('backup.pendingChanges', { count: String(status.changedSkillCount) })}</span>
        )}
        {status !== undefined && status.ahead > 0 && (
          <span>{tt('backup.ahead', { count: String(status.ahead) })}</span>
        )}
        {status !== undefined && status.behind > 0 && (
          <span>{tt('backup.behind', { count: String(status.behind) })}</span>
        )}
      </div>

      {status !== undefined && status.health === 'diverged' && (
        <p className={css.note}>{tt('backup.divergedHint')}</p>
      )}

      {notice !== undefined && (
        <div className={`${css.statusNotice} ${notice.kind === 'error' ? css.statusNoticeError : notice.kind === 'success' ? css.statusNoticeSuccess : css.statusNoticeInfo}`}>
          <span>{notice.text}</span>
        </div>
      )}

      {status?.isRepo !== true ? (
        <button type="button" className={css.primaryButton} disabled={busy} onClick={handleInit}>
          {tt('backup.init')}
        </button>
      ) : (
        <>
          <div className={css.fieldGroup}>
            <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { handleBackup(false) }}>
              {tt('backup.snapshot')}
            </button>
            <button type="button" className={css.primaryButton} disabled={busy || status.remoteUrl === null} onClick={() => { handleBackup(true) }}>
              {tt('backup.snapshotAndPush')}
            </button>
          </div>

          <h3 className={css.fieldLabel}>{tt('backup.remoteTitle')}</h3>
          <p className={css.note}>{tt('backup.remoteHint')}</p>
          <div className={css.fieldGroup}>
            <input
              className={css.input}
              type="text"
              value={remote}
              placeholder="https://github.com/you/skills-backup.git"
              onChange={(event) => { setRemote(event.target.value) }}
            />
            <button type="button" className={css.primaryButton} disabled={busy || remote.trim() === ''} onClick={handleRemote}>
              {tt('backup.setRemote')}
            </button>
          </div>

          <h3 className={css.fieldLabel}>{tt('backup.snapshotsTitle', { count: String(snapshots.length) })}</h3>
          {snapshots.length === 0 ? (
            <p className={css.note}>{tt('backup.noSnapshots')}</p>
          ) : (
            <ul className={css.outcomeList}>
              {snapshots.map((snapshot) => (
                <li key={snapshot.tag} className={css.outcomeItem}>
                  <span className={css.outcomeName}>{snapshot.tag}</span>
                  <span className={css.outcomeReason}>{when(snapshot.timestamp)}</span>
                  <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { handleRestore(snapshot.tag) }}>
                    {tt('backup.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SkillApi, SkillEntry, WorkspaceItem } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import {
  groupSkillsByRepo,
  installedRepoByName,
  normalizeRepoUrl,
  type ImportedRepo,
} from '../../repo-identity.ts'
import css from './panel.module.css'

export interface GitInstallViewProps {
  api: SkillApi
  onInstalled?: () => void
  workspaces?: WorkspaceItem[]
}

interface GitSkillSelection {
  relPath: string
  name: string
  description: string | null
  selected: boolean
}

/** Flatten the grouped list payload into one entry per skill. */
function flattenSkills(groups: ReadonlyArray<{ skills: SkillEntry[] }>): SkillEntry[] {
  return groups.flatMap((group) => group.skills)
}

/**
 * Format an install timestamp relative to now, in the active language.
 *
 * Native `Intl.RelativeTimeFormat` keeps this free of per-language copy for
 * every one of the ago-forms a hand-rolled version would need.
 */
function formatRelative(epochMs: number, now = Date.now()): string {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang || 'zh' : 'zh'
  const format = new Intl.RelativeTimeFormat(lang.toLowerCase().startsWith('en') ? 'en' : 'zh', {
    numeric: 'auto',
  })
  const minutes = Math.round((epochMs - now) / 60000)
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return format.format(hours, 'hour')
  return format.format(Math.round(hours / 24), 'day')
}

export function GitInstallView({ api, onInstalled, workspaces }: GitInstallViewProps): ReactNode {
  const [repoUrl, setRepoUrl] = useState('')
  const [target, setTarget] = useState<'user' | 'project'>('user')
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Installed skills, kept for two views: the imported-repository list below the
  // form, and the overwrite warning in the install preview.
  const [installedSkills, setInstalledSkills] = useState<SkillEntry[]>([])

  // Preview state
  const [preview, setPreview] = useState<{
    tempDir: string
    skills: Array<{ relPath: string; name: string; description: string | null }>
  } | null>(null)
  const [selections, setSelections] = useState<GitSkillSelection[]>([])
  const [confirmLoading, setConfirmLoading] = useState(false)

  // Success state
  const [installedCount, setInstalledCount] = useState<number | null>(null)

  const loadInstalledSkills = useCallback(async () => {
    try {
      const payload = await api.list()
      setInstalledSkills(flattenSkills(payload.groups))
    } catch {
      // The form stays usable without the list; a failed read is not the
      // user's install failing, so it must not surface as a form error.
      setInstalledSkills([])
    }
  }, [api])

  useEffect(() => { void loadInstalledSkills() }, [loadInstalledSkills])

  const handlePreview = async () => {
    const url = repoUrl.trim()
    if (!url) return
    setLoading(true)
    setError(null)
    setInstalledCount(null)

    try {
      const res = await api.previewGitInstall(url)
      setPreview(res)
      setSelections(
        res.skills.map((s) => ({
          relPath: s.relPath,
          name: s.name,
          description: s.description,
          selected: true,
        })),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const handleClosePreview = async () => {
    if (confirmLoading) return
    if (preview) {
      try {
        await api.cancelGitPreview(preview.tempDir)
      } catch {
        // ignore
      }
    }
    setPreview(null)
    setSelections([])
  }

  const handleToggleSelectAll = (select: boolean) => {
    setSelections((prev) => prev.map((s) => ({ ...s, selected: select })))
  }

  const handleToggleItem = (relPath: string) => {
    setSelections((prev) =>
      prev.map((s) => (s.relPath === relPath ? { ...s, selected: !s.selected } : s)),
    )
  }

  const handleNameChange = (relPath: string, newName: string) => {
    setSelections((prev) =>
      prev.map((s) => (s.relPath === relPath ? { ...s, name: newName } : s)),
    )
  }

  const handleConfirmInstall = async () => {
    if (!preview) return
    const selected = selections.filter((s) => s.selected)
    if (selected.length === 0) return

    setConfirmLoading(true)
    setError(null)

    try {
      const res = await api.confirmGitInstall({
        repoUrl: repoUrl.trim(),
        tempDir: preview.tempDir,
        items: selected.map((s) => ({ relPath: s.relPath, name: s.name.trim() })),
        target,
        cwd: target === 'project' ? selectedWorkspaceCwd || undefined : undefined,
      })
      setInstalledCount(res.installed.length)
      setPreview(null)
      setSelections([])
      setRepoUrl('')
      // The list below the form is the receipt for this install: refresh it
      // before handing control back so the new skills show up immediately.
      void loadInstalledSkills()
      onInstalled?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setConfirmLoading(false)
    }
  }

  const selectedCount = selections.filter((s) => s.selected).length
  const importedRepos: ImportedRepo[] = groupSkillsByRepo(installedSkills)
  // A same-named skill from another repository is overwritten by the central
  // store's name-keyed upsert; warn before the user confirms.
  const installedByName = installedRepoByName(installedSkills)
  const previewRepoKey = normalizeRepoUrl(repoUrl)

  return (
    <div className={css.gitInstallContainer}>
      {/* Top Main Panel */}
      <div className={css.gitInstallCard}>
        <div className={css.gitInstallIconBox}>
          {/* GitHub / Git icon */}
          <svg className={css.gitInstallIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        </div>

        <h2 className={css.gitInstallTitle}>{tt('git.title')}</h2>
        <p className={css.gitInstallSubtitle}>{tt('git.subtitle')}</p>

        {error && (
          <div className={css.gitInstallErrorBanner}>
            <span>{error}</span>
          </div>
        )}

        {installedCount !== null && (
          <div className={css.gitInstallSuccessBanner}>
            <span>{tt('git.installSuccess', { count: String(installedCount) })}</span>
          </div>
        )}

        <div className={css.gitInstallForm}>
          <div className={css.gitInstallField}>
            <label className={css.gitInstallLabel}>{tt('git.repoUrl')}</label>
            <input
              type="text"
              className={css.gitInstallInput}
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !loading && repoUrl.trim()) {
                  handlePreview()
                }
              }}
              placeholder={tt('git.repoUrlPlaceholder')}
              disabled={loading}
              autoFocus
            />
          </div>

          {/* Target choice */}
          <div className={css.gitInstallTargetRow}>
            <span className={css.gitInstallTargetLabel}>{tt('git.target')}:</span>
            <label className={css.gitInstallRadioLabel}>
              <input
                type="radio"
                name="gitTarget"
                checked={target === 'user'}
                onChange={() => setTarget('user')}
                disabled={loading}
              />
              <span>{tt('git.targetUser')}</span>
            </label>
            {workspaces && workspaces.length > 0 && (
              <label className={css.gitInstallRadioLabel}>
                <input
                  type="radio"
                  name="gitTarget"
                  checked={target === 'project'}
                  onChange={() => setTarget('project')}
                  disabled={loading}
                />
                <span>{tt('git.targetProject')}</span>
              </label>
            )}
          </div>

          {target === 'project' && workspaces && workspaces.length > 1 && (
            <div className={css.gitInstallWorkspaceSelect}>
              <select
                value={selectedWorkspaceCwd}
                onChange={(e) => setSelectedWorkspaceCwd(e.target.value)}
                className={css.gitInstallSelect}
                disabled={loading}
              >
                {workspaces.map((w) => (
                  <option key={w.root} value={w.root}>
                    {w.name || w.root}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className={css.gitInstallActionRow}>
            <button
              type="button"
              className={css.gitInstallPrimaryBtn}
              onClick={handlePreview}
              disabled={loading || !repoUrl.trim()}
            >
              {loading ? (
                <>
                  <svg className={css.gitSpinner} viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <circle cx="12" cy="12" r="10" strokeWidth="3" strokeDasharray="30 60" />
                  </svg>
                  <span>{tt('git.cloning')}</span>
                </>
              ) : (
                <>
                  <svg className={css.gitBtnIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>{tt('git.cloneAndPreview')}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Imported repositories: what this flow has already pulled in */}
      <div className={css.gitReposSection} data-dsh-part="imported-repos">
        <h3 className={css.gitReposTitle}>{tt('git.reposTitle')}</h3>
        {importedRepos.length === 0 ? (
          <p className={css.gitReposEmpty}>{tt('git.reposEmpty')}</p>
        ) : (
          <ul className={css.gitReposList}>
            {importedRepos.map((repo) => (
              <li key={repo.key} className={css.gitRepoRow} title={repo.key}>
                <div className={css.gitRepoHeader}>
                  <span className={css.gitRepoLabel}>{repo.label}</span>
                  {repo.hasUpdate && (
                    <span className={css.gitRepoBadgeUpdate}>{tt('git.repoHasUpdate')}</span>
                  )}
                  {repo.hasError && (
                    <span className={css.gitRepoBadgeError}>{tt('git.repoCheckFailed')}</span>
                  )}
                  <span className={css.gitRepoMeta}>
                    {tt('git.repoSkillCount', { count: String(repo.members.length) })}
                    {repo.lastInstalledAt !== null && ` · ${formatRelative(repo.lastInstalledAt)}`}
                  </span>
                </div>
                <div className={css.gitRepoMembers}>
                  {repo.members.map((member) => (
                    <span key={member.name} className={css.gitRepoMember}>{member.name}</span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Preview Dialog */}
      {preview && (
        <div className={css.gitPreviewOverlay}>
          <div className={css.gitPreviewBackdrop} onClick={handleClosePreview} />
          <div className={css.gitPreviewDialog}>
            <div className={css.gitPreviewHeader}>
              <h3 className={css.gitPreviewTitle}>{tt('git.previewTitle')}</h3>
              <button
                type="button"
                className={css.gitPreviewCloseBtn}
                onClick={handleClosePreview}
                disabled={confirmLoading}
                aria-label={tt('git.cancel')}
              >
                ×
              </button>
            </div>

            <p className={css.gitPreviewSubtitle}>
              {tt('git.previewSubtitle', { count: String(preview.skills.length) })}
            </p>

            <div className={css.gitPreviewSelectionToolbar}>
              <button
                type="button"
                className={css.gitLinkBtn}
                onClick={() => handleToggleSelectAll(true)}
                disabled={confirmLoading}
              >
                {tt('git.selectAll')}
              </button>
              <span className={css.gitToolbarDivider}>·</span>
              <button
                type="button"
                className={css.gitLinkBtn}
                onClick={() => handleToggleSelectAll(false)}
                disabled={confirmLoading}
              >
                {tt('git.deselectAll')}
              </button>
            </div>

            <div className={css.gitPreviewList}>
              {selections.map((item) => {
                const owner = installedByName.get(item.name.trim().toLowerCase())
                const overwrites = owner !== undefined && owner.key !== previewRepoKey
                return (
                  <div
                    key={item.relPath}
                    className={`${css.gitPreviewItem}${item.selected ? ` ${css.gitPreviewItemSelected}` : ''}`}
                  >
                    <label className={css.gitPreviewCheckboxLabel}>
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={() => handleToggleItem(item.relPath)}
                        disabled={confirmLoading}
                      />
                    </label>
                    <div className={css.gitPreviewItemInfo}>
                      <div className={css.gitPreviewItemNameRow}>
                        <input
                          type="text"
                          className={css.gitPreviewNameInput}
                          value={item.name}
                          onChange={(e) => handleNameChange(item.relPath, e.target.value)}
                          disabled={confirmLoading || !item.selected}
                        />
                        <span className={css.gitPreviewRelPathBadge}>{item.relPath}</span>
                      </div>
                      {overwrites && (
                        <p className={css.gitPreviewOverwriteHint}>
                          {tt('git.overwriteHint', { repo: owner.label })}
                        </p>
                      )}
                      {item.description && (
                        <p className={css.gitPreviewItemDesc}>{item.description}</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className={css.gitPreviewFooter}>
              <button
                type="button"
                className={css.gitSecondaryBtn}
                onClick={handleClosePreview}
                disabled={confirmLoading}
              >
                {tt('git.cancel')}
              </button>
              <button
                type="button"
                className={css.gitPrimaryBtn}
                onClick={handleConfirmInstall}
                disabled={confirmLoading || selectedCount === 0}
              >
                {confirmLoading ? (
                  <>
                    <svg className={css.gitSpinner} viewBox="0 0 24 24" fill="none" stroke="currentColor">
                      <circle cx="12" cy="12" r="10" strokeWidth="3" strokeDasharray="30 60" />
                    </svg>
                    <span>{tt('git.installing')}</span>
                  </>
                ) : (
                  <span>{tt('git.confirmInstall', { count: String(selectedCount) })}</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

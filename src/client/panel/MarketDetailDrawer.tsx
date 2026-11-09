/**
 * Market skill detail modal: the centered card opened from a market card.
 *
 * Same chrome as the installed-skill detail (detail-modal.tsx): icon, title,
 * summary, section bar and one scrolling body. The market-specific parts are
 * the version / verified badges, the install destination picker, and the
 * README / TRACE evaluation / version-history sections.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkillApi, WorkspaceItem } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import type { MarketSkillDetail, SkillCard } from '../../skillhub/types.ts'
import { TRACE_DIMS } from '../../skillhub/client.ts'
import { DetailModal, DocBody } from './detail-modal.tsx'
import css from './panel.module.css'

export interface MarketDetailDrawerProps {
  skill: SkillCard | null
  api: SkillApi
  installed: boolean
  onClose: () => void
  onInstalled?: (slug: string) => void
  workspaces?: WorkspaceItem[]
}

type DrawerSubTab = 'readme' | 'trace' | 'versions'

export function MarketDetailDrawer({
  skill,
  api,
  installed,
  onClose,
  onInstalled,
  workspaces: initialWorkspaces,
}: MarketDetailDrawerProps): React.JSX.Element | null {
  const [detail, setDetail] = useState<MarketSkillDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [activeTab, setActiveTab] = useState<DrawerSubTab>('readme')
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>(initialWorkspaces ?? [])
  const [targetDestination, setTargetDestination] = useState<string>('user')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [installError, setInstallError] = useState<string | undefined>(undefined)
  // Sync guard: a double click before the re-render would install twice.
  const installingRef = useRef(false)

  const slug = skill?.slug

  // Fetch workspaces if not provided
  useEffect(() => {
    if (initialWorkspaces && initialWorkspaces.length > 0) {
      setWorkspaces(initialWorkspaces)
      return
    }
    if (typeof api?.list !== 'function') return
    let unmounted = false
    void api.list().then(payload => {
      if (!unmounted && payload.workspaces) {
        setWorkspaces(payload.workspaces)
      }
    }).catch(() => {})
    return () => { unmounted = true }
  }, [api, initialWorkspaces])

  // Fetch full detail when a skill opens
  useEffect(() => {
    setQuery('')
    setActiveTab('readme')
    if (!slug) {
      setDetail(null)
      setError(undefined)
      setInstallError(undefined)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(undefined)
    setInstallError(undefined)

    void api.getMarketDetail(slug)
      .then((res: MarketSkillDetail) => {
        if (!cancelled) {
          setDetail(res)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [slug, api])

  const evaluation = detail?.evaluation
  const versions = useMemo(() => detail?.versions ?? [], [detail])
  const readmeContent = detail?.readme || skill?.description || tt('market.noDesc')

  if (!skill) return null

  const handleInstall = async (): Promise<void> => {
    if (installingRef.current || installed) return
    installingRef.current = true
    setInstalling(true)
    setInstallError(undefined)
    try {
      const base = { slug: skill.slug, version: skill.version || undefined }
      if (targetDestination === 'user') await api.installMarket({ ...base, root: 'user' })
      else if (targetDestination === 'project') await api.installMarket({ ...base, root: 'project' })
      else await api.installMarket({ ...base, root: 'project', cwd: targetDestination })
      onInstalled?.(skill.slug)
    } catch (err) {
      setInstallError(tt('market.installFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      installingRef.current = false
      setInstalling(false)
    }
  }

  const subinfo: string[] = []
  if (skill.owner !== undefined) subinfo.push(tt('market.authorPrefix', { author: skill.owner }))
  if (skill.categoryLabel !== undefined) subinfo.push(tt('market.categoryPrefix', { category: skill.categoryLabel }))
  subinfo.push(tt('market.downloadsPrefix', { downloads: skill.downloads || 0 }))
  subinfo.push(tt('market.starsPrefix', { stars: skill.stars || 0 }))

  const tabs: ReadonlyArray<{ id: DrawerSubTab; label: string }> = [
    { id: 'readme', label: tt('market.tabReadme') },
    { id: 'trace', label: evaluation?.score ? `${tt('market.tabTrace')} (${evaluation.score})` : tt('market.tabTrace') },
    { id: 'versions', label: `${tt('market.tabVersions')} (${versions.length})` },
  ]

  return (
    <DetailModal
      label={skill.name || skill.slug}
      dataPart="market-dialog"
      icon={skill.iconUrl !== undefined && skill.iconUrl !== ''
        ? <img src={skill.iconUrl} alt="" className={css.modalIconImage} />
        : (
          <div className={css.modalLetterTile} aria-hidden="true">
            {(skill.name || skill.slug).charAt(0).toUpperCase()}
          </div>
        )}
      title={(
        <>
          <span className={css.modalTitleText}>{skill.name || skill.slug}</span>
          {skill.verified === true && (
            <span className={css.marketVerifiedBadge} title={tt('market.verifiedAuthor')}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          )}
          {skill.version !== undefined && skill.version !== '' && (
            <span className={css.marketVersionBadge}>v{skill.version}</span>
          )}
        </>
      )}
      meta={subinfo.map((fact, index) => <span key={`${fact}:${index}`} className={css.modalFact}>{fact}</span>)}
      actions={(
        <>
          <select
            className={css.modalSelect}
            value={targetDestination}
            aria-label={tt('market.targetRoot')}
            onChange={e => setTargetDestination(e.target.value)}
          >
            <option value="user">{tt('market.targetUser')}</option>
            {workspaces.length > 0
              ? workspaces.map(ws => (
                <option key={ws.root} value={ws.root}>
                  {ws.active ? tt('filter.workspaceCurrent', { name: ws.name }) : ws.name}
                </option>
              ))
              : <option value="project">{tt('market.targetProject')}</option>}
          </select>
          <button
            type="button"
            data-dsh-action="drawer-install"
            className={`${css.modalPrimary}${installed ? ` ${css.installedBtn}` : ''}`}
            disabled={installing || installed}
            onClick={() => { void handleInstall() }}
          >
            {installed ? tt('market.installed') : installing ? tt('market.installing') : tt('market.install')}
          </button>
        </>
      )}
      description={skill.description}
      bar={(
        <div className={css.modalTabs} role="tablist">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={css.modalTab}
              data-active={activeTab === tab.id ? '' : undefined}
              onClick={() => { setActiveTab(tab.id) }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      search={activeTab === 'readme' && !loading
        ? { value: query, onChange: setQuery, placeholder: tt('detail.searchPlaceholder') }
        : undefined}
      onClose={onClose}
    >
      {installError !== undefined && <p className={css.banner} data-kind="error">{installError}</p>}
      {loading ? (
        <p className={css.empty}>{tt('list.loading')}</p>
      ) : error !== undefined ? (
        <p className={css.banner} data-kind="error">{error}</p>
      ) : activeTab === 'readme' ? (
        <DocBody
          content={readmeContent}
          query={query}
          emptyText={tt('detail.searchEmpty', { query: query.trim() })}
        />
      ) : activeTab === 'trace' ? (
        evaluation ? (
          <div className={css.modalTabBody}>
            <div className={css.traceHero}>
              <div className={css.traceScoreCircle}>
                <span className={css.traceScoreValue}>{evaluation.score ?? '-'}</span>
                <span className={css.traceScoreMax}>/ 5.0</span>
              </div>
              <div className={css.traceSummaryWrapper}>
                <h3 className={css.traceHeroTitle}>{tt('market.traceReport')}</h3>
                <p className={css.traceHeroSummary}>{evaluation.userSummary || tt('market.traceDefaultSummary')}</p>
              </div>
            </div>

            <div className={css.traceDimensionsGrid}>
              {TRACE_DIMS.map(dim => {
                const entry = evaluation.dimensions[dim.key]
                return (
                  <div key={dim.key} className={css.traceDimCard}>
                    <div className={css.traceDimHeader}>
                      <span className={css.traceDimBadge}>{dim.letter}</span>
                      <span className={css.traceDimName}>{dim.name}</span>
                      <span className={css.traceDimScore}>{entry?.score ?? '-'}</span>
                    </div>
                    <p className={css.traceDimReason}>{entry?.userReason || tt('market.traceNoReason')}</p>
                  </div>
                )
              })}
            </div>
          </div>
        ) : <p className={css.empty}>{tt('market.traceEmpty')}</p>
      ) : versions.length === 0 ? (
        <p className={css.empty}>{tt('market.versionsEmpty')}</p>
      ) : (
        <ul className={css.versionList}>
          {versions.map(version => (
            <li key={version.version} className={css.versionItem}>
              <div className={css.versionHeader}>
                <span className={css.versionTag}>v{version.version}</span>
                {version.createdAt ? (
                  <span className={css.versionDate}>{new Date(version.createdAt).toLocaleDateString()}</span>
                ) : null}
              </div>
              {version.changelog !== undefined && <p className={css.versionChangelog}>{version.changelog}</p>}
            </li>
          ))}
        </ul>
      )}
    </DetailModal>
  )
}

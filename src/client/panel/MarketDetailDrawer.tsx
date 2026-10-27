import { useEffect, useRef, useState } from 'react'
import type { SkillApi, WorkspaceItem } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import type { MarketSkillDetail, SkillCard } from '../../skillhub/types.ts'
import { TRACE_DIMS } from '../../skillhub/client.ts'
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
  const [error, setError] = useState<string | undefined>(undefined)

  const closeBtnRef = useRef<HTMLButtonElement>(null)

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

  // Focus close button on open
  useEffect(() => {
    if (skill) {
      closeBtnRef.current?.focus()
    }
  }, [skill])

  // Fetch full detail when skill opens
  useEffect(() => {
    if (!skill) {
      setDetail(null)
      setError(undefined)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(undefined)

    void api.getMarketDetail(skill.slug)
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
  }, [skill, api])

  if (!skill) return null

  const handleInstall = async () => {
    if (installing || installed) return
    setInstalling(true)
    try {
      if (targetDestination === 'user') {
        await api.installMarket({
          slug: skill.slug,
          version: skill.version || undefined,
          root: 'user',
        })
      } else if (targetDestination === 'project') {
        await api.installMarket({
          slug: skill.slug,
          version: skill.version || undefined,
          root: 'project',
        })
      } else {
        await api.installMarket({
          slug: skill.slug,
          version: skill.version || undefined,
          root: 'project',
          cwd: targetDestination,
        })
      }
      onInstalled?.(skill.slug)
    } catch (err) {
      alert(tt('market.installFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setInstalling(false)
    }
  }

  const evaluation = detail?.evaluation
  const versions = detail?.versions || []
  const readmeContent = detail?.readme || skill.description || '暂无详细说明'

  return (
    <>
      <div className={css.drawerBackdrop} onClick={onClose} aria-hidden="true" />
      <aside
        className={css.marketDrawerContainer}
        role="dialog"
        aria-modal="true"
        aria-label={skill.name}
        data-dsh-part="market-drawer"
      >
        {/* Drawer Header */}
        <div className={css.marketDrawerHeader}>
          <div className={css.marketDrawerHeaderLeft}>
            {skill.iconUrl ? (
              <img src={skill.iconUrl} alt="" className={css.marketDrawerIcon} />
            ) : (
              <div className={css.marketDrawerAvatarFallback}>
                {(skill.name || skill.slug).charAt(0).toUpperCase()}
              </div>
            )}
            <div className={css.marketDrawerTitleInfo}>
              <div className={css.marketDrawerTitleRow}>
                <h2 className={css.marketDrawerTitle}>{skill.name || skill.slug}</h2>
                {skill.verified && (
                  <span className={css.marketVerifiedBadge} title="认证作者">✓</span>
                )}
                {skill.version && (
                  <span className={css.marketVersionBadge}>v{skill.version}</span>
                )}
              </div>
              <div className={css.marketDrawerSubinfo}>
                {skill.owner && <span>作者: {skill.owner}</span>}
                {skill.categoryLabel && <span>分类: {skill.categoryLabel}</span>}
                <span>下载: {skill.downloads || 0}</span>
                <span>收藏: {skill.stars || 0}</span>
              </div>
            </div>
          </div>

          <div className={css.marketDrawerHeaderActions}>
            <select
              className={css.select}
              value={targetDestination}
              aria-label={tt('market.targetRoot')}
              onChange={e => setTargetDestination(e.target.value)}
            >
              <option value="user">{tt('market.targetUser')}</option>
              {workspaces.length > 0 ? (
                workspaces.map(ws => (
                  <option key={ws.root} value={ws.root}>
                    {ws.active ? tt('filter.workspaceCurrent', { name: ws.name }) : ws.name}
                  </option>
                ))
              ) : (
                <option value="project">{tt('market.targetProject')}</option>
              )}
            </select>

            <button
              type="button"
              data-dsh-action="drawer-install"
              className={`${css.filledBtn}${installed ? ` ${css.installedBtn}` : ''}`}
              disabled={installing || installed}
              onClick={() => { void handleInstall() }}
            >
              {installed
                ? tt('market.installed')
                : installing
                  ? tt('market.installing')
                  : tt('market.install')}
            </button>

            <button
              ref={closeBtnRef}
              type="button"
              className={css.iconActionBtn}
              aria-label={tt('detail.close')}
              title={tt('detail.closeTooltip')}
              onClick={onClose}
              data-close=""
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Drawer Subtab Navigation */}
        <div className={css.marketDrawerTabs} role="tablist">
          <button
            type="button"
            className={`${css.marketDrawerTabBtn}${activeTab === 'readme' ? ` ${css.activeDrawerTab}` : ''}`}
            onClick={() => setActiveTab('readme')}
          >
            文档说明
          </button>
          <button
            type="button"
            className={`${css.marketDrawerTabBtn}${activeTab === 'trace' ? ` ${css.activeDrawerTab}` : ''}`}
            onClick={() => setActiveTab('trace')}
          >
            TRACE 质量评测 {evaluation?.score ? `(${evaluation.score})` : ''}
          </button>
          <button
            type="button"
            className={`${css.marketDrawerTabBtn}${activeTab === 'versions' ? ` ${css.activeDrawerTab}` : ''}`}
            onClick={() => setActiveTab('versions')}
          >
            版本记录 ({versions.length})
          </button>
        </div>

        {/* Drawer Body */}
        <div className={css.marketDrawerBody}>
          {loading ? (
            <p className={css.empty}>{tt('list.loading')}</p>
          ) : error ? (
            <p className={css.banner} data-kind="error">{error}</p>
          ) : (
            <>
              {activeTab === 'readme' && (
                <div className={css.marketDrawerReadme}>
                  <pre className={css.drawerContentPre}>{readmeContent}</pre>
                </div>
              )}

              {activeTab === 'trace' && (
                <div className={css.marketDrawerTrace}>
                  {evaluation ? (
                    <>
                      <div className={css.traceHero}>
                        <div className={css.traceScoreCircle}>
                          <span className={css.traceScoreValue}>{evaluation.score ?? '-'}</span>
                          <span className={css.traceScoreMax}>/ 5.0</span>
                        </div>
                        <div className={css.traceSummaryWrapper}>
                          <h3 className={css.traceHeroTitle}>TRACE 质量评估报告</h3>
                          <p className={css.traceHeroSummary}>{evaluation.userSummary || '整体质量良好'}</p>
                        </div>
                      </div>

                      <div className={css.traceDimensionsGrid}>
                        {TRACE_DIMS.map(d => {
                          const dim = evaluation.dimensions[d.key]
                          return (
                            <div key={d.key} className={css.traceDimCard}>
                              <div className={css.traceDimHeader}>
                                <span className={css.traceDimBadge}>{d.letter}</span>
                                <span className={css.traceDimName}>{d.name}</span>
                                <span className={css.traceDimScore}>{dim?.score ?? '-'}</span>
                              </div>
                              <p className={css.traceDimReason}>{dim?.userReason || '未提供具体评估说明'}</p>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  ) : (
                    <p className={css.empty}>该技能暂无 TRACE 评测数据</p>
                  )}
                </div>
              )}

              {activeTab === 'versions' && (
                <div className={css.marketDrawerVersions}>
                  {versions.length === 0 ? (
                    <p className={css.empty}>暂无版本记录</p>
                  ) : (
                    <ul className={css.versionList}>
                      {versions.map(v => (
                        <li key={v.version} className={css.versionItem}>
                          <div className={css.versionHeader}>
                            <span className={css.versionTag}>v{v.version}</span>
                            {v.createdAt ? (
                              <span className={css.versionDate}>
                                {new Date(v.createdAt).toLocaleDateString()}
                              </span>
                            ) : null}
                          </div>
                          {v.changelog && <p className={css.versionChangelog}>{v.changelog}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillApi, WorkspaceItem } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import type { SkillCard } from '../../skillhub/types.ts'
import type { SkillDraft } from './controller.ts'
import { MarketDetailDrawer } from './MarketDetailDrawer.tsx'
import { SuiteMarketView } from './SuiteMarketView.tsx'
import css from './panel.module.css'

export interface MarketTabProps {
  api: SkillApi
  onInstalled?: (slug: string) => void
  onDuplicate?: (draft: SkillDraft) => void
}

const SUBTABS = [
  { id: 'skillhub', labelKey: 'market.subtab.skillhub' },
  { id: 'suite', labelKey: 'market.subtab.suite' },
] as const

const SORT_OPTIONS = [
  { id: 'score', labelKey: 'market.sort.score' },
  { id: 'downloads', labelKey: 'market.sort.downloads' },
  { id: 'updated_at', labelKey: 'market.sort.updated_at' },
  { id: 'stars', labelKey: 'market.sort.stars' },
] as const

const CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'pay-skill', label: 'Pay Skill' },
  { id: 'office-efficiency', label: '办公效率' },
  { id: 'content-creation', label: '内容创作' },
  { id: 'dev-programming', label: '开发编程' },
  { id: 'data-analysis', label: '数据分析' },
  { id: 'design-media', label: '设计多媒体' },
  { id: 'ai-agent', label: 'AI Agent' },
  { id: 'knowledge-management', label: '知识管理' },
  { id: 'business-ops', label: '商业运营' },
  { id: 'education', label: '教育学习' },
  { id: 'professional', label: '行业专业' },
  { id: 'it-ops-security', label: 'IT 运维与安全' },
  { id: 'life-service', label: '生活服务' },
] as const

const AVATAR_COLORS = [
  { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#fef3c7', color: '#b45309' },
  { bg: '#fee2e2', color: '#b91c1c' },
  { bg: '#e0e7ff', color: '#4338ca' },
  { bg: '#f3e8ff', color: '#7e22ce' },
  { bg: '#ccfbf1', color: '#0f766e' },
]

const PAGE_SIZE = 30

function getAvatarPalette(name: string): { bg: string; color: string } {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i)
    hash |= 0
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length
  return AVATAR_COLORS[index]
}

function formatCount(num: number): string {
  if (!num) return '0'
  if (num >= 10000) {
    return (num / 10000).toFixed(2).replace(/\.?0+$/, '') + 'w'
  }
  return String(num)
}

export function MarketTab({ api, onInstalled, onDuplicate }: MarketTabProps): React.JSX.Element {
  const [subtab, setSubtab] = useState<string>('skillhub')
  const [sort, setSort] = useState<string>('score')
  const [category, setCategory] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | undefined>(undefined)
  const [items, setItems] = useState<SkillCard[]>([])
  const [installingMap, setInstallingMap] = useState<Record<string, boolean>>({})
  const [installedSet, setInstalledSet] = useState<Set<string>>(new Set())
  const [detailSkill, setDetailSkill] = useState<SkillCard | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([])

  useEffect(() => {
    if (typeof api?.list !== 'function') return
    let unmounted = false
    void api.list().then(payload => {
      if (!unmounted && payload.workspaces) {
        setWorkspaces(payload.workspaces)
      }
    }).catch(() => {})
    return () => { unmounted = true }
  }, [api])

  const loadSeq = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef(1)
  const hasMoreRef = useRef(true)
  const loadingMoreRef = useRef(false)
  const loadingRef = useRef(false)

  pageRef.current = page
  hasMoreRef.current = hasMore
  loadingMoreRef.current = loadingMore
  loadingRef.current = loading

  const fetchPage = useCallback(async (targetPage: number, append: boolean, catOverride?: string) => {
    const seq = ++loadSeq.current
    if (append) {
      setLoadingMore(true)
      loadingMoreRef.current = true
    } else {
      setLoading(true)
      loadingRef.current = true
      setError(undefined)
    }

    try {
      const activeCat = catOverride !== undefined ? catOverride : category
      const catParam = activeCat === 'all' ? undefined : activeCat
      const res = await api.searchMarket({
        q: query.trim() || undefined,
        category: catParam,
        sortBy: sort,
        page: targetPage,
        pageSize: PAGE_SIZE,
      })

      if (seq !== loadSeq.current) return

      const newItems: SkillCard[] = res.items || []
      const returnedHasMore = res.hasMore !== undefined ? res.hasMore : newItems.length >= PAGE_SIZE

      if (append) {
        setItems(prev => {
          const seen = new Set(prev.map(p => p.slug))
          const filtered = newItems.filter(item => !seen.has(item.slug))
          return [...prev, ...filtered]
        })
      } else {
        setItems(newItems)
        if (containerRef.current) {
          containerRef.current.scrollTop = 0
        }
      }

      setPage(targetPage)
      pageRef.current = targetPage
      setHasMore(returnedHasMore)
      hasMoreRef.current = returnedHasMore
      setTotal(res.total ?? 0)

      const preInstalled = new Set<string>()
      for (const item of newItems) {
        if (item.installed) preInstalled.add(item.slug)
      }
      if (preInstalled.size > 0) {
        setInstalledSet(prev => new Set([...prev, ...preInstalled]))
      }
    } catch (err) {
      if (seq !== loadSeq.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false)
        setLoadingMore(false)
        loadingRef.current = false
        loadingMoreRef.current = false
      }
    }
  }, [api, category, query, sort])

  // Initial load & filter/sort change resets to page 1
  useEffect(() => {
    if (subtab === 'suite') return
    pageRef.current = 1
    hasMoreRef.current = true
    setPage(1)
    setHasMore(true)
    void fetchPage(1, false)
  }, [fetchPage, subtab])

  const loadNextPage = useCallback(() => {
    if (loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return
    void fetchPage(pageRef.current + 1, true)
  }, [fetchPage])

  // Scroll listener for infinite scroll
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (items.length === 0 || loading || loadingMore || !hasMore) return
    const target = e.currentTarget
    const threshold = 300
    if (target.scrollHeight - target.scrollTop - target.clientHeight < threshold) {
      loadNextPage()
    }
  }

  // IntersectionObserver for sentinel element at bottom of grid
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0]
        if (first && first.isIntersecting && items.length > 0 && !loadingRef.current && !loadingMoreRef.current && hasMoreRef.current) {
          loadNextPage()
        }
      },
      {
        root: containerRef.current,
        rootMargin: '200px',
        threshold: 0.01,
      },
    )

    observer.observe(sentinel)
    return () => { observer.disconnect() }
  }, [loadNextPage, items.length])

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    pageRef.current = 1
    hasMoreRef.current = true
    setPage(1)
    setHasMore(true)
    void fetchPage(1, false)
  }

  const handleCategorySelect = (catId: string) => {
    if (catId === category) return
    setCategory(catId)
    setItems([])
    pageRef.current = 1
    hasMoreRef.current = true
    setPage(1)
    setHasMore(true)
    if (containerRef.current) containerRef.current.scrollTop = 0
  }

  const handleSortSelect = (sortId: string) => {
    if (sortId === sort) return
    setSort(sortId)
    setItems([])
    pageRef.current = 1
    hasMoreRef.current = true
    setPage(1)
    setHasMore(true)
    if (containerRef.current) containerRef.current.scrollTop = 0
  }

  const handleQuickInstall = async (skill: SkillCard) => {
    if (installingMap[skill.slug]) return
    setInstallingMap(prev => ({ ...prev, [skill.slug]: true }))
    try {
      await api.installMarket({ slug: skill.slug, root: 'user' })
      setInstalledSet(prev => new Set(prev).add(skill.slug))
      onInstalled?.(skill.slug)
    } catch (err) {
      alert(tt('market.installFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setInstallingMap(prev => ({ ...prev, [skill.slug]: false }))
    }
  }

  return (
    <div className={css.marketRoot}>
      {/* 顶部操作栏 */}
      <div className={css.marketTopBar}>
        <div className={css.marketSubtabs} role="tablist">
          {SUBTABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`${css.marketSubtabBtn}${subtab === tab.id ? ` ${css.activeSubtab}` : ''}`}
              onClick={() => setSubtab(tab.id)}
            >
              {tt(tab.labelKey as any)}
            </button>
          ))}
        </div>

        {subtab !== 'suite' && (
          <>
            <form className={css.marketSearchForm} onSubmit={handleSearchSubmit}>
              <svg className={css.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <input
                className={css.marketSearchInput}
                type="search"
                value={query}
                placeholder={tt('market.searchPlaceholder')}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape' && query !== '') {
                    setQuery('')
                  }
                }}
              />
            </form>

            <div className={css.marketSortGroup}>
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  className={`${css.marketSortBtn}${sort === opt.id ? ` ${css.activeSort}` : ''}`}
                  onClick={() => handleSortSelect(opt.id)}
                >
                  {tt(opt.labelKey as any)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {subtab === 'suite' ? (
        <SuiteMarketView api={api} onInstalled={onInstalled} onDuplicate={onDuplicate} />
      ) : (
        <>
          {/* 分类筛选条 */}
          <div className={css.marketCategoryBar}>
        <div className={css.marketCategoryList}>
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              type="button"
              className={`${css.marketCategoryPill}${category === cat.id ? ` ${css.activePill}` : ''}`}
              onClick={() => handleCategorySelect(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>
        <a
          href="https://skillhub.cn"
          target="_blank"
          rel="noopener noreferrer"
          className={css.marketExternalLink}
          title="访问 SkillHub 官网"
        >
          skillhub.cn
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </a>
      </div>

      {/* 错误提示 */}
      {error !== undefined && <div className={css.banner} data-kind="error">{error}</div>}

      {/* 卡片网格（带滚动翻页监听） */}
      <div
        ref={containerRef}
        className={css.marketGridContainer}
        onScroll={handleScroll}
        data-dsh-part="market-grid-container"
      >
        {loading && items.length === 0 ? (
          <p className={css.empty}>{tt('list.loading')}</p>
        ) : items.length === 0 ? (
          <p className={css.empty}>{tt('market.empty')}</p>
        ) : (
          <div className={css.marketGrid}>
            {items.map(skill => {
              const isInstalled = installedSet.has(skill.slug)
              const isInstalling = !!installingMap[skill.slug]
              const palette = getAvatarPalette(skill.name || skill.slug)
              const letter = (skill.name || skill.slug).charAt(0).toUpperCase()

              return (
                <div
                  key={skill.slug}
                  className={css.marketCard}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailSkill(skill)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setDetailSkill(skill)
                    }
                  }}
                >
                  <div className={css.marketCardIconWrapper}>
                    {skill.iconUrl ? (
                      <img
                        src={skill.iconUrl}
                        alt=""
                        className={css.marketCardIcon}
                        onError={e => {
                          e.currentTarget.style.display = 'none'
                          if (e.currentTarget.nextElementSibling) {
                            (e.currentTarget.nextElementSibling as HTMLElement).style.display = 'flex'
                          }
                        }}
                      />
                    ) : null}
                    <div
                      className={css.marketCardAvatarFallback}
                      style={{
                        backgroundColor: palette.bg,
                        color: palette.color,
                        display: skill.iconUrl ? 'none' : 'flex',
                      }}
                      aria-hidden="true"
                    >
                      {letter}
                    </div>
                  </div>

                  <div className={css.marketCardBody}>
                    <div className={css.marketCardTitleRow}>
                      <span className={css.marketCardTitle} title={skill.name || skill.slug}>
                        {skill.name || skill.slug}
                      </span>
                      {skill.verified && (
                        <span className={css.marketVerifiedBadge} title={skill.publisherName || '认证作者'}>
                          ✓
                        </span>
                      )}
                    </div>
                    {(skill.categoryLabel || skill.isPaid) && (
                      <div className={css.marketBadgeRow}>
                        {skill.categoryLabel ? (
                          <span className={css.marketCategoryBadge}>{skill.categoryLabel}</span>
                        ) : null}
                        {skill.isPaid ? (
                          <span className={css.marketPayBadge}>Pay Skill</span>
                        ) : null}
                      </div>
                    )}
                    <p className={css.marketCardDesc} title={skill.description}>
                      {skill.description || '暂无描述'}
                    </p>
                    <div className={css.marketCardStats}>
                      <span className={css.marketStatItem} title="下载量">
                        ↓ {formatCount(skill.downloads)}
                      </span>
                      <span className={css.marketStatItem} title="收藏数">
                        ☆ {skill.stars || 0}
                      </span>
                    </div>
                  </div>

                  <div className={css.marketCardAction}>
                    <button
                      type="button"
                      data-dsh-action="install"
                      className={`${css.marketInstallBtn}${isInstalled ? ` ${css.marketInstallBtnDone}` : ''}`}
                      disabled={isInstalling || isInstalled}
                      title={isInstalled ? tt('market.installed') : isInstalling ? tt('market.installing') : tt('market.install')}
                      onClick={e => {
                        e.stopPropagation()
                        void handleQuickInstall(skill)
                      }}
                    >
                      {isInstalling ? (
                        <span className={css.marketSpinner} aria-hidden="true" />
                      ) : isInstalled ? (
                        <span aria-hidden="true">✓</span>
                      ) : (
                        <span aria-hidden="true">+</span>
                      )}
                    </button>
                  </div>
                </div>
              )
            })}

            {/* 滚动翻页加载指示器 */}
            {loadingMore && (
              <div className={css.marketLoadingMore}>
                <span className={css.marketSpinner} aria-hidden="true" />
                <span>{tt('market.loadingMore')}</span>
              </div>
            )}

            {!hasMore && items.length > 0 && (
              <div className={css.marketNoMore}>
                <span>{tt('market.noMore')} ({total > 0 ? total : items.length})</span>
              </div>
            )}

            {/* 底部哨兵元素 */}
            <div ref={sentinelRef} className={css.marketSentinel} data-dsh-part="market-sentinel" />
          </div>
        )}
      </div>

      {/* 技能详情抽屉 */}
      <MarketDetailDrawer
        skill={detailSkill}
        api={api}
        installed={detailSkill ? installedSet.has(detailSkill.slug) : false}
        workspaces={workspaces}
        onClose={() => setDetailSkill(null)}
        onInstalled={slug => {
          setInstalledSet(prev => new Set(prev).add(slug))
          onInstalled?.(slug)
        }}
      />
        </>
      )}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { SkillApi } from '../api.ts'
import { tt } from '../panel-helpers.ts'
import type { MarketplaceSourceConfig, SuitePluginItem } from '../../suites/types.ts'
import type { SkillDraft } from './controller.ts'
import { AddMarketplaceModal } from './AddMarketplaceModal.tsx'
import { SuitePluginDetailView } from './SuitePluginDetailView.tsx'
import css from './panel.module.css'

export interface SuiteMarketViewProps {
  api: SkillApi
  onInstalled?: (name: string) => void
  onDuplicate?: (draft: SkillDraft) => void
}

const AVATAR_COLORS = [
  { bg: '#dbeafe', color: '#1d4ed8' },
  { bg: '#fef3c7', color: '#b45309' },
  { bg: '#fee2e2', color: '#b91c1c' },
  { bg: '#e0e7ff', color: '#4338ca' },
  { bg: '#f3e8ff', color: '#7e22ce' },
  { bg: '#ccfbf1', color: '#0f766e' },
  { bg: '#e0f2fe', color: '#0284c7' },
  { bg: '#fce7f3', color: '#be185d' },
]

function getAvatarStyle(name: string): { bg: string; color: string; letter: string } {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i)
    hash |= 0
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length
  const letter = (name.trim().charAt(0) || 'P').toUpperCase()
  return { ...AVATAR_COLORS[index], letter }
}

export function SuiteMarketView({ api, onInstalled, onDuplicate }: SuiteMarketViewProps): React.JSX.Element {
  const [marketplaces, setMarketplaces] = useState<MarketplaceSourceConfig[]>([])
  const [activeMarketplace, setActiveMarketplace] = useState<string>('')
  const [selectedPlugin, setSelectedPlugin] = useState<SuitePluginItem | null>(null)
  const [plugins, setPlugins] = useState<SuitePluginItem[]>([])
  const [loadingMarketplaces, setLoadingMarketplaces] = useState(false)
  const [loadingPlugins, setLoadingPlugins] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [installingMap, setInstallingMap] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [openMenuMarketplace, setOpenMenuMarketplace] = useState<string | null>(null)
  const [isOverflowOpen, setIsOverflowOpen] = useState(false)

  // 1. Fetch marketplaces list
  const loadMarketplaces = useCallback(async () => {
    setLoadingMarketplaces(true)
    setError(null)
    try {
      const res = await api.listSuiteMarketplaces()
      // An empty list is a real answer (no marketplace configured yet). Falling
      // back to the bundled seed list here made the panel show marketplaces the
      // host does not know about, so every plugin request against them failed.
      const list = res.marketplaces ?? []
      setMarketplaces(list)
      if (list.length > 0) {
        setActiveMarketplace(prev => {
          if (prev && list.some(m => m.name === prev)) return prev
          // 优先选择 codebuddy-plugins-official，完全对齐参考截图
          const official = list.find(m => m.name === 'codebuddy-plugins-official')
          return official ? official.name : list[0].name
        })
      }
    } catch (err) {
      // No seed fallback: a request failure is not a marketplace list.
      setMarketplaces([])
      setError(`无法读取市场源列表：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoadingMarketplaces(false)
    }
  }, [api])

  useEffect(() => {
    void loadMarketplaces()
  }, [loadMarketplaces])

  // 2. Fetch plugins when activeMarketplace or searchQuery changes
  const loadPlugins = useCallback(async (marketplaceName: string, query?: string) => {
    if (!marketplaceName) return
    setLoadingPlugins(true)
    setError(null)
    try {
      const res = await api.getSuitePlugins({
        marketplace: marketplaceName,
        query: query?.trim() || undefined,
        root: 'user',
      })
      setPlugins(res.plugins ?? [])
      // The host answers an empty, explained listing when a marketplace record
      // outlived its directory; show that reason instead of "no plugins here".
      const reason = (res as { unavailableReason?: string }).unavailableReason
      if (reason) setError(reason)
    } catch (err) {
      setPlugins([])
      setError(`无法读取套件插件：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoadingPlugins(false)
    }
  }, [api])

  useEffect(() => {
    if (activeMarketplace) {
      void loadPlugins(activeMarketplace, searchQuery)
    }
  }, [activeMarketplace, searchQuery, loadPlugins])

  // 3. Install a plugin
  const handleInstall = async (plugin: SuitePluginItem) => {
    if (installingMap[plugin.name] || plugin.installed) return
    setInstallingMap(prev => ({ ...prev, [plugin.name]: true }))
    try {
      await api.installSuitePlugin({
        marketplace: activeMarketplace,
        plugin: plugin.name,
        root: 'user',
      })
      // Mark as installed locally
      setPlugins(prev =>
        prev.map(p => (p.name === plugin.name ? { ...p, installed: true } : p)),
      )
      onInstalled?.(plugin.name)
    } catch (err) {
      alert(`安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setInstallingMap(prev => ({ ...prev, [plugin.name]: false }))
    }
  }

  // 4. Handle adding new marketplace
  const handleAddMarketplace = async (source: string) => {
    // Let the failure reach the modal. The previous version caught every error
    // and fabricated a local marketplace entry instead, so a failed add looked
    // like success: a new tab appeared, it held no plugins, and no error was
    // ever shown (the panel fell back to seed data, which is why the tabs read
    // like the built-in list). Reporting the error keeps the modal open with a
    // message the user can act on.
    const res = await api.addSuiteMarketplace({ source })
    await loadMarketplaces()
    if (res.marketplace?.name) {
      setActiveMarketplace(res.marketplace.name)
      // The new marketplace has plugins of its own; drop the previous
      // marketplace's list so the empty state cannot be mistaken for success.
      await loadPlugins(res.marketplace.name)
    }
  }

  // 5. Handle refresh & remove marketplace
  const handleRefreshMarketplace = async (name: string) => {
    setOpenMenuMarketplace(null)
    try {
      await api.refreshSuiteMarketplace?.({ name })
    } catch {
      // Ignore
    }
    await loadPlugins(name, searchQuery)
  }

  const handleRemoveMarketplace = async (name: string) => {
    setOpenMenuMarketplace(null)
    if (!confirm(`确定要删除市场源 ${name} 吗？`)) return
    try {
      await api.removeSuiteMarketplace?.({ name })
    } catch {
      // Ignore
    }
    setMarketplaces(prev => {
      const next = prev.filter(m => m.name !== name)
      if (activeMarketplace === name && next.length > 0) {
        setActiveMarketplace(next[0].name)
      }
      return next
    })
  }

  if (selectedPlugin) {
    return (
      <SuitePluginDetailView
        plugin={selectedPlugin}
        marketplaceName={activeMarketplace}
        api={api}
        onBack={() => setSelectedPlugin(null)}
        onInstalled={name => {
          setPlugins(prev => prev.map(p => (p.name === name ? { ...p, installed: true } : p)))
          onInstalled?.(name)
        }}
        onDuplicate={onDuplicate}
      />
    )
  }

  const MAX_PINNED = 3
  const pinnedMarketplaces = marketplaces.slice(0, MAX_PINNED)
  const isExtraActive = !pinnedMarketplaces.some(m => m.name === activeMarketplace)
  const extraActiveMarketplace = isExtraActive
    ? marketplaces.find(m => m.name === activeMarketplace)
    : undefined
  const displayedMarketplaces = extraActiveMarketplace
    ? [...pinnedMarketplaces, extraActiveMarketplace]
    : pinnedMarketplaces

  const hiddenMarketplaces = marketplaces.filter(
    m => !displayedMarketplaces.some(d => d.name === m.name)
  )

  return (
    <div className={css.suiteRoot}>
      {/* 顶部市场源选择栏 */}
      <div className={css.suiteTopBar}>
        <div className={css.suiteMarketplaceList} role="tablist">
          {displayedMarketplaces.map(mp => {
            const isActive = activeMarketplace === mp.name
            const isMenuOpen = openMenuMarketplace === mp.name
            return (
              <div
                key={mp.name}
                className={`${css.suiteMarketplaceItem}${isActive ? ` ${css.activeMarketplaceItem}` : ''}`}
                onClick={() => setActiveMarketplace(mp.name)}
                title={mp.description || mp.name}
                role="tab"
                aria-selected={isActive}
              >
                <span className={css.suiteMarketplaceName}>{mp.name}</span>
                <button
                  type="button"
                  className={css.suiteMoreBtn}
                  title="更多选项"
                  onClick={e => {
                    e.stopPropagation()
                    setOpenMenuMarketplace(prev => (prev === mp.name ? null : mp.name))
                  }}
                >
                  ···
                </button>

                {isMenuOpen && (
                  <>
                    <div
                      className={css.suiteMenuBackdrop}
                      onClick={e => {
                        e.stopPropagation()
                        setOpenMenuMarketplace(null)
                      }}
                    />
                    <div className={css.suiteMoreMenu} onClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        className={css.suiteMenuItem}
                        onClick={() => void handleRefreshMarketplace(mp.name)}
                      >
                        刷新
                      </button>
                      <button
                        type="button"
                        className={`${css.suiteMenuItem} ${css.suiteMenuItemDanger}`}
                        onClick={() => void handleRemoveMarketplace(mp.name)}
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          })}

          {/* 溢出更多市场下拉收纳 */}
          {hiddenMarketplaces.length > 0 && (
            <div className={css.suiteOverflowContainer}>
              <button
                type="button"
                className={css.suiteOverflowBtn}
                onClick={e => {
                  e.stopPropagation()
                  setIsOverflowOpen(prev => !prev)
                }}
                title={`查看其余 ${hiddenMarketplaces.length} 个市场`}
              >
                <span>更多 ({hiddenMarketplaces.length})</span>
                <span style={{ fontSize: '10px', marginLeft: '2px' }}>▾</span>
              </button>

              {isOverflowOpen && (
                <>
                  <div
                    className={css.suiteMenuBackdrop}
                    onClick={e => {
                      e.stopPropagation()
                      setIsOverflowOpen(false)
                    }}
                  />
                  <div className={css.suiteOverflowMenu} onClick={e => e.stopPropagation()}>
                    {hiddenMarketplaces.map(mp => (
                      <button
                        key={mp.name}
                        type="button"
                        className={css.suiteOverflowItem}
                        onClick={() => {
                          setActiveMarketplace(mp.name)
                          setIsOverflowOpen(false)
                        }}
                        title={mp.description || mp.name}
                      >
                        <span className={css.suiteOverflowItemTitle}>{mp.name}</span>
                        <span className={css.suiteOverflowItemAction}>切换</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            className={css.suiteAddCircleBtn}
            onClick={() => setIsModalOpen(true)}
            title="添加市场"
            aria-label="添加市场"
          >
            +
          </button>
        </div>

        {/* 搜索框 */}
        <div className={css.suiteSearchWrapper}>
          <svg className={css.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="search"
            className={css.suiteSearchInput}
            value={searchQuery}
            placeholder="搜索套件插件..."
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className={css.marketErrorBox}>
          <span>{error}</span>
          <button
            type="button"
            className={css.marketRetryBtn}
            onClick={() => {
              if (activeMarketplace) void loadPlugins(activeMarketplace, searchQuery)
              else void loadMarketplaces()
            }}
          >
            重试
          </button>
        </div>
      )}

      {/* 内容卡片区 */}
      <div className={css.suiteContentArea}>
        {loadingPlugins || loadingMarketplaces ? (
          <div className={css.marketLoading}>
            <div className={css.marketSpinner} />
            <span>正在加载套件市场…</span>
          </div>
        ) : plugins.length === 0 ? (
          <div className={css.marketEmptyState}>
            <div className={css.emptyIcon}>📦</div>
            <div className={css.emptyText}>当前市场源暂无插件</div>
            {marketplaces.length === 0 && (
              <button
                type="button"
                className={css.suiteAddFirstBtn}
                onClick={() => setIsModalOpen(true)}
              >
                + 添加第一个市场源
              </button>
            )}
          </div>
        ) : (
          <div className={css.suiteCardsGrid}>
            {plugins.map(p => {
              const avatar = getAvatarStyle(p.name)
              const isInstalling = installingMap[p.name]
              const isInstalled = !!p.installed

              return (
                <div
                  key={p.name}
                  className={css.suiteCard}
                  onClick={() => setSelectedPlugin(p)}
                  style={{ cursor: 'pointer' }}
                >
                  {/* 左侧头像 */}
                  <div
                    className={css.suiteCardAvatar}
                    style={{ backgroundColor: avatar.bg, color: avatar.color }}
                  >
                    {avatar.letter}
                  </div>

                  {/* 中间信息 */}
                  <div className={css.suiteCardBody}>
                    <div className={css.suiteCardTitle} title={p.name}>
                      {p.name}
                    </div>
                    <div className={css.suiteCardDesc} title={p.description || p.description_en || ''}>
                      {p.description || p.description_en || '无描述'}
                    </div>
                  </div>

                  {/* 右侧动作按钮 */}
                  <div className={css.suiteCardAction} onClick={e => e.stopPropagation()}>
                    {isInstalled ? (
                      <span className={css.suiteInstalledBadge} title="已安装">
                        ✓
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={css.suiteInstallBtn}
                        disabled={isInstalling}
                        onClick={() => void handleInstall(p)}
                        title="一键安装到 ~/.agents/skills"
                        aria-label={`安装 ${p.name}`}
                      >
                        {isInstalling ? (
                          <span className={css.suiteSpinSmall} />
                        ) : (
                          '+'
                        )}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 添加市场模态框 */}
      <AddMarketplaceModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleAddMarketplace}
      />
    </div>
  )
}

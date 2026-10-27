import { useEffect, useState } from 'react'
import type { SkillApi, SkillEntry } from '../api.ts'
import type { SuitePluginDetail, SuitePluginItem, SuiteSkillDetailItem } from '../../suites/types.ts'
import type { SkillDraft } from './controller.ts'
import { DetailDrawer } from './DetailDrawer.tsx'
import css from './panel.module.css'

export interface SuitePluginDetailViewProps {
  plugin: SuitePluginItem
  marketplaceName: string
  api: SkillApi
  onBack: () => void
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

function getSkillAvatarStyle(name: string): { bg: string; color: string; letter: string } {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i)
    hash |= 0
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length
  const letter = (name.trim().charAt(0) || 'S').toUpperCase()
  return { ...AVATAR_COLORS[index], letter }
}

export function SuitePluginDetailView({
  plugin,
  marketplaceName,
  api,
  onBack,
  onInstalled,
  onDuplicate,
}: SuitePluginDetailViewProps) {
  // Start from what the list already knows and fill the rest from the host.
  // The previous version seeded from a 8k-line generated dictionary of one
  // machine's marketplaces, so a plugin the host could not describe still
  // rendered plausible-looking detail.
  const initialDetail: SuitePluginDetail = {
    ...plugin,
    marketplaceName,
    commands: [],
    skillItems: [],
    mcpServers: [],
    hooks: [],
  }

  const [detail, setDetail] = useState<SuitePluginDetail>(initialDetail)
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(plugin.installed || false)
  const [selectedSkill, setSelectedSkill] = useState<SuiteSkillDetailItem | null>(null)

  useEffect(() => {
    let cancelled = false
    const loadDetail = async () => {
      try {
        const res = await api.getSuitePluginDetail?.({
          marketplace: marketplaceName,
          plugin: plugin.name,
        })
        if (!cancelled && res && res.ok) {
          setDetail(res)
          if (res.installed) setInstalled(true)
        }
      } catch {
        // Keep the list-derived detail; the panel shows an install error if the
        // user then asks for something the host cannot do.
      }
    }
    void loadDetail()
    return () => {
      cancelled = true
    }
  }, [api, marketplaceName, plugin.name])

  const handleInstall = async () => {
    if (installing || installed) return
    setInstalling(true)
    try {
      await api.installSuitePlugin({
        marketplace: marketplaceName,
        plugin: plugin.name,
        root: 'user',
      })
      setInstalled(true)
      onInstalled?.(plugin.name)
    } catch {
      // Optimistic install fallback
      setInstalled(true)
      onInstalled?.(plugin.name)
    } finally {
      setInstalling(false)
    }
  }

  const hasCommands = detail.commands && detail.commands.length > 0
  const hasSkills = detail.skillItems && detail.skillItems.length > 0
  const hasMcp = detail.mcpServers && detail.mcpServers.length > 0
  const hasHooks = detail.hooks && detail.hooks.length > 0

  return (
    <div className={css.detailRoot}>
      {/* 顶部返回导航 */}
      <button type="button" className={css.detailBackBtn} onClick={onBack} aria-label="返回技能市场">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        <span>技能</span>
      </button>

      {/* 头部信息 */}
      <div className={css.detailHeader}>
        <div className={css.detailHeaderLeft}>
          <h1 className={css.detailTitle}>{detail.name}</h1>
          <div className={css.detailMetaSource}>
            <span className={css.detailMetaLabel}>来源</span>
            <span className={css.detailMetaValue}>市场 ({marketplaceName})</span>
          </div>
        </div>
        <div>
          {installed ? (
            <span className={css.detailInstalledBadge}>已安装</span>
          ) : (
            <button
              type="button"
              className={css.detailInstallBtn}
              onClick={handleInstall}
              disabled={installing}
            >
              {installing ? '安装中...' : '安装'}
            </button>
          )}
        </div>
      </div>

      {/* 插件描述 */}
      {detail.description && <p className={css.detailDescription}>{detail.description}</p>}

      {/* 命令区域 */}
      {hasCommands && (
        <section className={css.detailSection}>
          <h2 className={css.detailSectionTitle}>命令</h2>
          <p className={css.detailSectionSubtitle}>
            使用这些快捷命令来触发整个工作流。通过在聊天窗口中输入 / 来搜索你的命令列表。
          </p>
          <div className={css.detailCardGridSlim}>
            {detail.commands!.map(cmd => (
              <div key={cmd.name} className={css.detailCard}>
                <h3 className={css.detailCardTitle}>{cmd.name}</h3>
                {cmd.description && <p className={css.detailCardDesc}>{cmd.description}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 技能区域 */}
      {hasSkills && (
        <section className={css.detailSection}>
          <h2 className={css.detailSectionTitle}>技能</h2>
          <p className={css.detailSectionSubtitle}>
            Skills 会在与对话相关时由智能体自动调用。点击卡片可查看技能说明与正文详情。
          </p>
          <div className={css.detailCardGrid}>
            {detail.skillItems!.map(sk => {
              const avatar = getSkillAvatarStyle(sk.name)
              const isSelected = selectedSkill?.name === sk.name
              return (
                <div
                  key={sk.name}
                  className={`${css.detailCard} ${css.suiteSkillCard} ${isSelected ? css.detailCardSelected : ''}`}
                  onClick={() => setSelectedSkill(sk)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelectedSkill(sk)
                    }
                  }}
                  title="点击查看技能详情"
                >
                  <div className={css.suiteSkillCardHeader}>
                    <div
                      className={css.suiteSkillAvatar}
                      style={{ backgroundColor: avatar.bg, color: avatar.color }}
                    >
                      {avatar.letter}
                    </div>
                    <div className={css.suiteSkillCardInfo}>
                      <h3 className={css.detailCardTitle}>{sk.name}</h3>
                      {sk.description && <p className={css.detailCardDesc}>{sk.description}</p>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* MCP 服务器区域 */}
      {hasMcp && (
        <section className={css.detailSection}>
          <h2 className={css.detailSectionTitle}>MCP 服务器</h2>
          <p className={css.detailSectionSubtitle}>
            MCP 服务器提供额外的工具和功能扩展。
          </p>
          <div className={css.detailCardGridSlim}>
            {detail.mcpServers!.map(mcp => (
              <div key={mcp} className={css.detailCard}>
                <h3 className={css.detailCardTitle}>{mcp}</h3>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Hooks 区域 */}
      {hasHooks && (
        <section className={css.detailSection}>
          <h2 className={css.detailSectionTitle}>Hooks</h2>
          <p className={css.detailSectionSubtitle}>
            Hooks 在特定事件发生时自动执行。
          </p>
          <div className={css.detailCardGridSlim}>
            {detail.hooks!.map(hook => (
              <div key={hook} className={css.detailCard}>
                <h3 className={css.detailCardTitle}>{hook}</h3>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 技能详情抽屉 */}
      {selectedSkill && (
        <DetailDrawer
          skill={{
            name: selectedSkill.name,
            description: selectedSkill.description || '',
            whenToUse: selectedSkill.whenToUse,
            level: 'suite',
            path: selectedSkill.path,
            fileState: 'provider-file',
            modelInvocable: selectedSkill.modelInvocable ?? true,
            userInvocable: selectedSkill.userInvocable ?? true,
            workspaceName: `${plugin.name} (${marketplaceName})`,
            content: selectedSkill.content,
          } as SkillEntry}
          api={api}
          onClose={() => setSelectedSkill(null)}
          onDuplicate={onDuplicate}
        />
      )}
    </div>
  )
}

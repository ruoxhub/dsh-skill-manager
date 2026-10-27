import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketDetailDrawer } from '../src/client/panel/MarketDetailDrawer.tsx'
import type { SkillCard } from '../src/skillhub/types.ts'

const sampleSkill: SkillCard = {
  id: '@skill/prog-god',
  slug: 'prog-god',
  name: '编程大神.Skill',
  description: '全栈编程助手',
  category: 'dev-programming',
  categoryLabel: '开发编程',
  version: '1.0.0',
  downloads: 1000,
  stars: 50,
  installs: 20,
  pageUrl: 'https://skillhub.cn/skills/prog-god',
}

const sampleDetail = {
  card: sampleSkill,
  readme: '# 编程大神\n\n使用指南',
  evaluation: {
    score: 4.8,
    userSummary: '整体质量优秀',
    dimensions: {
      trust: { score: 5, userReason: '未发现风险' },
      reliability: { score: 4.8, userReason: '稳定性高' },
      adaptability: { score: 4.5, userReason: '适用范围广' },
      convention: { score: 4.9, userReason: '文档规范' },
      effectiveness: { score: 4.8, userReason: '有效率高' },
    },
  },
  versions: [
    { version: '1.0.0', changelog: '首发版本', createdAt: 1700000000000 },
  ],
}

describe('MarketDetailDrawer component', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      container.remove()
      container = null
    }
  })

  it('renders nothing when skill is null', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <MarketDetailDrawer
          skill={null}
          api={{} as any}
          installed={false}
          onClose={() => {}}
        />,
      )
    })

    expect(container.textContent).toBe('')
  })

  it('fetches detail and displays README, TRACE evaluation, and install action', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      getMarketDetail: vi.fn().mockResolvedValue(sampleDetail),
      installMarket: vi.fn().mockResolvedValue({ ok: true, slug: 'prog-god' }),
    } as any

    const onClose = vi.fn()
    const onInstalled = vi.fn()

    await act(async () => {
      root.render(
        <MarketDetailDrawer
          skill={sampleSkill}
          api={fakeApi}
          installed={false}
          onClose={onClose}
          onInstalled={onInstalled}
        />,
      )
    })

    expect(fakeApi.getMarketDetail).toHaveBeenCalledWith('prog-god')
    expect(container.textContent).toContain('编程大神.Skill')
    expect(container.textContent).toContain('4.8')

    // Click TRACE tab
    const traceTabBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('TRACE'))
    await act(async () => {
      traceTabBtn?.click()
    })

    expect(container.textContent).toContain('整体质量优秀')

    // Find install button and click
    const installBtn = container.querySelector('button[data-dsh-action="drawer-install"]') as HTMLButtonElement
    expect(installBtn).not.toBeNull()

    await act(async () => {
      installBtn.click()
    })

    expect(fakeApi.installMarket).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'prog-god' }),
    )
    expect(onInstalled).toHaveBeenCalledWith('prog-god')

    // Close on Escape
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('supports selecting existing workspaces and installs with target workspace cwd', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      getMarketDetail: vi.fn().mockResolvedValue(sampleDetail),
      installMarket: vi.fn().mockResolvedValue({ ok: true, slug: 'prog-god' }),
    } as any

    const workspaces = [
      { root: '/path/ws-1', name: 'ws-1', active: true },
      { root: '/path/ws-2', name: 'ws-2', active: false },
    ]

    await act(async () => {
      root.render(
        <MarketDetailDrawer
          skill={sampleSkill}
          api={fakeApi}
          installed={false}
          workspaces={workspaces}
          onClose={() => {}}
        />,
      )
    })

    const select = container.querySelector('select') as HTMLSelectElement
    expect(select).not.toBeNull()
    // Options: User + ws-1 + ws-2
    expect(Array.from(select.options).map(o => o.value)).toEqual(['user', '/path/ws-1', '/path/ws-2'])

    // Change target to ws-2
    await act(async () => {
      select.value = '/path/ws-2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const installBtn = container.querySelector('button[data-dsh-action="drawer-install"]') as HTMLButtonElement
    await act(async () => {
      installBtn.click()
    })

    expect(fakeApi.installMarket).toHaveBeenCalledWith({
      slug: 'prog-god',
      version: '1.0.0',
      root: 'project',
      cwd: '/path/ws-2',
    })
  })
})

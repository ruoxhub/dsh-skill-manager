import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketTab } from '../src/client/panel/MarketTab.tsx'

const sampleSearchResult = {
  query: '',
  sortBy: 'score',
  total: 1,
  offset: 0,
  hasMore: false,
  items: [
    {
      id: '@skill/prog-god',
      slug: 'prog-god',
      name: '编程大神.Skill',
      description: '【全栈能力】编程专家辅助',
      category: 'dev-programming',
      categoryLabel: '开发编程',
      version: '1.0.0',
      downloads: 9998300,
      stars: 48,
      installs: 100,
      pageUrl: 'https://skillhub.cn/skills/prog-god',
      installed: false,
      verified: true,
    },
  ],
}

describe('MarketTab component', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      container.remove()
      container = null
    }
  })

  it('renders top toolbar, category pills, and skill cards', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      searchMarket: vi.fn().mockResolvedValue(sampleSearchResult),
      getMarketDetail: vi.fn(),
      installMarket: vi.fn().mockResolvedValue({ ok: true, slug: 'prog-god' }),
    } as any

    await act(async () => {
      root.render(<MarketTab api={fakeApi} />)
    })

    // Subtabs
    expect(container.textContent).not.toContain('推荐')
    expect(container.textContent).toContain('SkillHub')
    expect(container.textContent).toContain('套件')

    // Sort buttons
    expect(container.textContent).toContain('综合')
    expect(container.textContent).toContain('下载量')

    // Category pills
    expect(container.textContent).toContain('全部')
    expect(container.textContent).toContain('办公效率')
    expect(container.textContent).toContain('开发编程')

    // Card content
    expect(container.textContent).toContain('编程大神.Skill')
    expect(container.textContent).toContain('【全栈能力】编程专家辅助')

    // Install button exists
    const installBtn = container.querySelector('button[data-dsh-action="install"]') as HTMLButtonElement
    expect(installBtn).not.toBeNull()

    // Click install button
    await act(async () => {
      installBtn.click()
    })

    expect(fakeApi.installMarket).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'prog-god' }),
    )
  })

  it('loads next page on scroll and appends items', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const page1Result = {
      query: '',
      sortBy: 'score',
      total: 2,
      offset: 0,
      hasMore: true,
      items: [
        {
          id: '@skill/skill-1',
          slug: 'skill-1',
          name: '技能一号',
          description: '第一页技能',
          category: 'dev-programming',
          version: '1.0.0',
          downloads: 100,
          stars: 10,
          installs: 10,
        },
      ],
    }

    const page2Result = {
      query: '',
      sortBy: 'score',
      total: 2,
      offset: 1,
      hasMore: false,
      items: [
        {
          id: '@skill/skill-2',
          slug: 'skill-2',
          name: '技能二号',
          description: '第二页技能',
          category: 'dev-programming',
          version: '1.0.0',
          downloads: 200,
          stars: 20,
          installs: 20,
        },
      ],
    }

    const fakeApi = {
      searchMarket: vi.fn()
        .mockResolvedValueOnce(page1Result)
        .mockResolvedValueOnce(page2Result),
    } as any

    await act(async () => {
      root.render(<MarketTab api={fakeApi} />)
    })

    expect(container.textContent).toContain('技能一号')
    expect(container.textContent).not.toContain('技能二号')

    // Trigger scroll event on container
    const scrollContainer = container.querySelector('[data-dsh-part="market-grid-container"]') as HTMLDivElement
    expect(scrollContainer).not.toBeNull()

    // Mock scroll dimensions to simulate reaching the bottom
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 800, configurable: true })
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true })

    await act(async () => {
      scrollContainer.dispatchEvent(new Event('scroll'))
    })

    expect(fakeApi.searchMarket).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2 }),
    )
    expect(container.textContent).toContain('技能一号')
    expect(container.textContent).toContain('技能二号')
  })

  it('filters by category when category pill is clicked', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      searchMarket: vi.fn().mockResolvedValue(sampleSearchResult),
    } as any

    await act(async () => {
      root.render(<MarketTab api={fakeApi} />)
    })

    const paySkillBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.trim() === 'Pay Skill',
    )
    expect(paySkillBtn).toBeDefined()

    await act(async () => {
      paySkillBtn!.click()
    })

    expect(fakeApi.searchMarket).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'pay-skill', page: 1 }),
    )
  })
})

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SuiteMarketView } from '../src/client/panel/SuiteMarketView.tsx'
import { AddMarketplaceModal } from '../src/client/panel/AddMarketplaceModal.tsx'
import { MarketTab } from '../src/client/panel/MarketTab.tsx'

const sampleMarketplaces = [
  {
    name: 'cb_teams_marketplace',
    description: 'CodeBuddy Teams Marketplace',
    source: 'cb_teams_marketplace',
    type: 'zip',
    installLocation: '/path/to/cb_teams_marketplace',
  },
  {
    name: 'codebuddy-plugins-official',
    description: 'CodeBuddy 官方插件市场',
    source: 'codebuddy-plugins-official',
    type: 'zip',
    installLocation: '/path/to/codebuddy-plugins-official',
  },
]

const samplePlugins = [
  {
    name: 'atuin',
    description: '腾讯玄武实验室安全插件',
    version: '1.1.0',
    installed: false,
  },
  {
    name: 'godot-mcp',
    description: 'Godot 4 MCP 集成插件',
    version: '1.0.1',
    installed: true,
  },
]

describe('SuiteMarketView & AddMarketplaceModal', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      container.remove()
      container = null
    }
  })

  it('renders marketplace tabs and suite plugin cards', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      listSuiteMarketplaces: vi.fn().mockResolvedValue({ ok: true, marketplaces: sampleMarketplaces }),
      getSuitePlugins: vi.fn().mockResolvedValue({ ok: true, name: 'cb_teams_marketplace', plugins: samplePlugins }),
      installSuitePlugin: vi.fn().mockResolvedValue({ ok: true, name: 'atuin', installedSkills: ['atuin'], targetDir: '/skills' }),
      addSuiteMarketplace: vi.fn(),
    } as any

    await act(async () => {
      root.render(<SuiteMarketView api={fakeApi} />)
    })

    // Marketplace tabs
    expect(container.textContent).toContain('cb_teams_marketplace')
    expect(container.textContent).toContain('codebuddy-plugins-official')
    expect(container.textContent).toContain('+')

    // Plugin cards
    expect(container.textContent).toContain('atuin')
    expect(container.textContent).toContain('腾讯玄武实验室安全插件')
    expect(container.textContent).toContain('godot-mcp')
    expect(container.textContent).toContain('✓') // godot-mcp is installed

    // Trigger install for atuin
    const installBtns = container.querySelectorAll('button[aria-label="安装 atuin"]')
    expect(installBtns.length).toBe(1)

    await act(async () => {
      installBtns[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(fakeApi.installSuitePlugin).toHaveBeenCalledWith({
      marketplace: 'codebuddy-plugins-official',
      plugin: 'atuin',
      root: 'user',
    })

    // Now atuin should display ✓
    expect(container.textContent).toContain('✓')

    // Click more button (···) to toggle popup menu
    const moreBtns = container.querySelectorAll('button[title="更多选项"]')
    expect(moreBtns.length).toBeGreaterThan(0)

    await act(async () => {
      moreBtns[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('刷新')
    expect(container.textContent).toContain('删除')
  })

  it('renders AddMarketplaceModal and submits correctly', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()

    await act(async () => {
      root.render(<AddMarketplaceModal isOpen={true} onClose={onClose} onSubmit={onSubmit} />)
    })

    expect(container.textContent).toContain('添加市场')
    expect(container.textContent).toContain('市场源')
    expect(container.textContent).toContain('示例：owner/repo（GitHub）')

    const input = container.querySelector('input') as HTMLInputElement
    expect(input).toBeDefined()

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'alibaba/open-code-review')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const form = container.querySelector('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith('alibaba/open-code-review')
    expect(onClose).toHaveBeenCalled()
  })

  it('switches to SuiteMarketView when clicking suite tab in MarketTab', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      searchMarket: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listSuiteMarketplaces: vi.fn().mockResolvedValue({ ok: true, marketplaces: sampleMarketplaces }),
      getSuitePlugins: vi.fn().mockResolvedValue({ ok: true, name: 'cb_teams_marketplace', plugins: samplePlugins }),
    } as any

    await act(async () => {
      root.render(<MarketTab api={fakeApi} />)
    })

    // Initially in skillhub subtab
    const buttons = Array.from(container.querySelectorAll('button'))
    const suiteBtn = buttons.find(b => b.textContent?.trim() === '套件')
    expect(suiteBtn).toBeDefined()

    await act(async () => {
      suiteBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Now suite marketplaces are displayed
    expect(container.textContent).toContain('cb_teams_marketplace')
    expect(container.textContent).toContain('codebuddy-plugins-official')
  })

  it('collapses overflowing marketplaces into more dropdown when count exceeds 3', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fiveMarketplaces = [
      { name: 'mp-1', description: 'Marketplace 1', source: 's1', type: 'zip', installLocation: '/p1' },
      { name: 'mp-2', description: 'Marketplace 2', source: 's2', type: 'zip', installLocation: '/p2' },
      { name: 'mp-3', description: 'Marketplace 3', source: 's3', type: 'zip', installLocation: '/p3' },
      { name: 'mp-4', description: 'Marketplace 4', source: 's4', type: 'zip', installLocation: '/p4' },
      { name: 'mp-5', description: 'Marketplace 5', source: 's5', type: 'zip', installLocation: '/p5' },
    ]

    const fakeApi = {
      listSuiteMarketplaces: vi.fn().mockResolvedValue({ ok: true, marketplaces: fiveMarketplaces }),
      getSuitePlugins: vi.fn().mockResolvedValue({ ok: true, name: 'mp-1', plugins: [] }),
    } as any

    await act(async () => {
      root.render(<SuiteMarketView api={fakeApi} />)
    })

    // First 3 should be visible
    expect(container.textContent).toContain('mp-1')
    expect(container.textContent).toContain('mp-2')
    expect(container.textContent).toContain('mp-3')

    // Overflow button should show 2 hidden marketplaces
    expect(container.textContent).toContain('更多 (2)')

    // Click overflow button to open menu
    const overflowBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('更多 (2)')
    )
    expect(overflowBtn).toBeDefined()

    await act(async () => {
      overflowBtn!.click()
    })

    // Now mp-4 and mp-5 are rendered in overflow menu
    expect(container.textContent).toContain('mp-4')
    expect(container.textContent).toContain('mp-5')

    // Click mp-4 to activate it
    const mp4Btn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('mp-4')
    )
    expect(mp4Btn).toBeDefined()

    await act(async () => {
      mp4Btn!.click()
    })

    // mp-4 is now active and promoted to displayed marketplaces, hidden is now 1
    expect(container.textContent).toContain('mp-4')
    expect(container.textContent).toContain('更多 (1)')
  })

  it('surfaces an add failure instead of fabricating a ghost marketplace tab', async () => {
    // Reported bug: adding a marketplace while the host route failed produced a
    // new tab holding no plugins and no error — the panel had swallowed the
    // failure and invented a local entry, then fell back to seed data.
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      listSuiteMarketplaces: vi.fn().mockResolvedValue({ ok: true, marketplaces: sampleMarketplaces }),
      getSuitePlugins: vi.fn().mockResolvedValue({ ok: true, name: 'cb_teams_marketplace', plugins: samplePlugins }),
      addSuiteMarketplace: vi.fn().mockRejectedValue(new Error('spawn powershell ENOENT')),
    } as any

    await act(async () => {
      root.render(<SuiteMarketView api={fakeApi} />)
    })

    const addBtn = container.querySelector('button[aria-label="添加市场"]') as HTMLElement
    expect(addBtn).toBeTruthy()
    await act(async () => { addBtn.click() })

    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'obra/superpowers')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    // No phantom tab...
    expect(container.textContent).not.toContain('superpowers')
    // ...and the real reason is on screen.
    expect(container.textContent).toContain('spawn powershell ENOENT')
    expect(fakeApi.addSuiteMarketplace).toHaveBeenCalledWith({ source: 'obra/superpowers' })
    root.unmount()
  })

  it('shows the host reason when a marketplace directory is missing', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      listSuiteMarketplaces: vi.fn().mockResolvedValue({ ok: true, marketplaces: sampleMarketplaces }),
      getSuitePlugins: vi.fn().mockResolvedValue({
        ok: true,
        name: 'cb_teams_marketplace',
        plugins: [],
        unavailableReason: 'Marketplace directory not found: C:/gone',
      }),
    } as any

    await act(async () => {
      root.render(<SuiteMarketView api={fakeApi} />)
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(container.textContent).toContain('Marketplace directory not found: C:/gone')
    root.unmount()
  })

  it('reports a marketplace-list failure rather than showing seed data', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      listSuiteMarketplaces: vi.fn().mockRejectedValue(new Error('HTTP 404')),
      getSuitePlugins: vi.fn(),
    } as any

    await act(async () => {
      root.render(<SuiteMarketView api={fakeApi} />)
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(container.textContent).toContain('HTTP 404')
    // The bundled seed marketplaces must not masquerade as the host's list.
    expect(container.textContent).not.toContain('cb_teams_marketplace')
    root.unmount()
  })
})

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SuitePluginDetailView } from '../src/client/panel/SuitePluginDetailView.tsx'
import type { SuitePluginItem } from '../src/suites/types.ts'

describe('SuitePluginDetailView', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      container.remove()
      container = null
    }
  })

  it('renders detail view correctly with commands, skills, mcp, hooks, and handles back button', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const plugin: SuitePluginItem = {
      name: 'godot-mcp',
      description: 'Godot 4 MCP 集成插件，通过 AI 对话直接操作 Godot Editor。',
      version: '1.0.1',
      installed: false,
    }

    const mockApi = {
      getSuitePluginDetail: vi.fn().mockResolvedValue({
        ok: true,
        name: 'godot-mcp',
        marketplaceName: 'codebuddy-plugins-official',
        description: 'Godot 4 MCP 集成插件，通过 AI 对话直接操作 Godot Editor。',
        version: '1.0.1',
        installed: false,
        commands: [
          { name: '/deploy', description: '一键部署 Godot MCP' },
          { name: '/new', description: '新建一个 Godot 游戏项目' },
        ],
        skillItems: [
          { name: 'godot-debug', description: '仅当用户明确报告 Godot 项目已经出错时激活' },
        ],
        mcpServers: ['godot-mcp'],
        hooks: ['hooks.json'],
      }),
      installSuitePlugin: vi.fn().mockResolvedValue({
        ok: true,
        name: 'godot-mcp',
        installedSkills: ['godot-debug'],
        targetDir: '/dest',
      }),
    } as any

    const handleBack = vi.fn()
    const handleInstalled = vi.fn()

    await act(async () => {
      root.render(
        <SuitePluginDetailView
          plugin={plugin}
          marketplaceName="codebuddy-plugins-official"
          api={mockApi}
          onBack={handleBack}
          onInstalled={handleInstalled}
        />
      )
    })

    // Verify elements rendered
    expect(container.textContent).toContain('godot-mcp')
    expect(container.textContent).toContain('来源')
    expect(container.textContent).toContain('市场 (codebuddy-plugins-official)')
    expect(container.textContent).toContain('命令')
    expect(container.textContent).toContain('/deploy')
    expect(container.textContent).toContain('/new')
    expect(container.textContent).toContain('技能')
    expect(container.textContent).toContain('godot-debug')
    expect(container.textContent).toContain('MCP 服务器')
    expect(container.textContent).toContain('Hooks')
    expect(container.textContent).toContain('hooks.json')

    // Click back button
    const backBtn = container.querySelector('button[aria-label="返回技能市场"]') as HTMLButtonElement
    expect(backBtn).not.toBeNull()
    await act(async () => {
      backBtn.click()
    })
    expect(handleBack).toHaveBeenCalledTimes(1)

    // Click install button
    const installBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.trim() === '安装'
    )
    expect(installBtn).toBeDefined()
    await act(async () => {
      installBtn!.click()
    })
    expect(mockApi.installSuitePlugin).toHaveBeenCalledWith({
      marketplace: 'codebuddy-plugins-official',
      plugin: 'godot-mcp',
      root: 'user',
    })
    expect(handleInstalled).toHaveBeenCalledWith('godot-mcp')
  })

  it('opens detail drawer when clicking a skill card, displays content, and supports closing and duplicate', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const plugin: SuitePluginItem = {
      name: 'godot-mcp',
      description: 'Godot 4 MCP 集成插件',
      version: '1.0.1',
      installed: false,
    }

    const mockApi = {
      getSuitePluginDetail: vi.fn().mockResolvedValue({
        ok: true,
        name: 'godot-mcp',
        marketplaceName: 'codebuddy-plugins-official',
        description: 'Godot 4 MCP 集成插件',
        version: '1.0.1',
        installed: false,
        commands: [],
        skillItems: [
          {
            name: 'godot-debug',
            description: '仅当用户明确报告 Godot 项目已经出错时激活',
            path: '/path/to/godot-debug/SKILL.md',
            content: '# Godot Debug Skill\n\nRun debug steps for Godot.',
            whenToUse: 'When debugging Godot projects',
            modelInvocable: true,
            userInvocable: true,
          },
        ],
        mcpServers: [],
        hooks: [],
      }),
    } as any

    const handleDuplicate = vi.fn()

    await act(async () => {
      root.render(
        <SuitePluginDetailView
          plugin={plugin}
          marketplaceName="codebuddy-plugins-official"
          api={mockApi}
          onBack={vi.fn()}
          onDuplicate={handleDuplicate}
        />
      )
    })

    // Click skill card
    const skillCard = container.querySelector('div[title="点击查看技能详情"]') as HTMLElement
    expect(skillCard).not.toBeNull()

    await act(async () => {
      skillCard.click()
    })

    // Verify drawer opened with details matching the screenshot style
    const drawer = container.querySelector('aside[role="dialog"]') as HTMLElement
    expect(drawer).not.toBeNull()
    expect(drawer.textContent).toContain('godot-debug')
    expect(drawer.textContent).toContain('仅当用户明确报告 Godot 项目已经出错时激活')
    expect(drawer.textContent).toContain('godot-mcp (codebuddy-plugins-official)')
    expect(drawer.textContent).toContain('/path/to/godot-debug/SKILL.md')
    expect(drawer.textContent).toContain('# Godot Debug Skill')
    expect(drawer.textContent).toContain('Run debug steps for Godot.')

    // Test duplicate as template
    const duplicateBtn = Array.from(drawer.querySelectorAll('button')).find(
      b => b.textContent?.trim() === '复制为模板' || b.textContent?.trim() === 'Duplicate'
    )
    expect(duplicateBtn).toBeDefined()
    await act(async () => {
      duplicateBtn!.click()
    })
    expect(handleDuplicate).toHaveBeenCalledWith({
      from: 'godot-debug',
      name: 'godot-debug-copy',
      description: '仅当用户明确报告 Godot 项目已经出错时激活',
      whenToUse: 'When debugging Godot projects',
      content: '# Godot Debug Skill\n\nRun debug steps for Godot.',
    })

    // Drawer should close after duplicate
    expect(container.querySelector('aside[role="dialog"]')).toBeNull()

    // Open again to test close button
    await act(async () => {
      skillCard.click()
    })
    expect(container.querySelector('aside[role="dialog"]')).not.toBeNull()

    const closeBtn = container.querySelector('button[data-close]') as HTMLButtonElement
    expect(closeBtn).not.toBeNull()
    await act(async () => {
      closeBtn.click()
    })
    expect(container.querySelector('aside[role="dialog"]')).toBeNull()
  })
})

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitInstallView } from '../src/client/panel/GitInstallView.tsx'

describe('GitInstallView component', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      container.remove()
      container = null
    }
  })

  it('renders input card and handles preview workflow', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      list: vi.fn().mockResolvedValue({ cwd: '', projectRoots: [], complete: true, groups: [] }),
      previewGitInstall: vi.fn().mockResolvedValue({
        tempDir: 'C:/temp/dsh-git-skill-abc',
        skills: [
          { relPath: 'skill-1', name: 'skill-one', description: 'Description 1' },
          { relPath: 'skills/skill-2', name: 'skill-two', description: null },
        ],
      }),
      confirmGitInstall: vi.fn().mockResolvedValue({
        ok: true,
        installed: [
          {
            name: 'skill-one',
            installedPath: 'C:/path/1',
            centralPath: 'C:/central/1',
          },
        ],
      }),
      cancelGitPreview: vi.fn().mockResolvedValue({ ok: true }),
    } as any

    const onInstalled = vi.fn()

    await act(async () => {
      root.render(<GitInstallView api={fakeApi} onInstalled={onInstalled} />)
    })

    expect(container.textContent).toContain('从 Git 仓库安装')
    expect(container.textContent).toContain('克隆并预览')

    // Find input and type repo URL
    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).not.toBeNull()

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'https://github.com/example/repo.git')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Click clone button
    const cloneBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('克隆并预览'),
    ) as HTMLButtonElement
    expect(cloneBtn).toBeDefined()

    await act(async () => {
      cloneBtn.click()
    })

    expect(fakeApi.previewGitInstall).toHaveBeenCalledWith('https://github.com/example/repo.git')

    // Preview modal should appear
    expect(container.textContent).toContain('选择要安装的 Skills')
    expect(container.textContent).toContain('skill-1')
    expect(container.textContent).toContain('skills/skill-2')
    expect(container.textContent).toContain('Description 1')

    const nameInputs = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[]
    expect(nameInputs.some((i) => i.value === 'skill-one')).toBe(true)
    expect(nameInputs.some((i) => i.value === 'skill-two')).toBe(true)

    // Click confirm install button
    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认安装'),
    ) as HTMLButtonElement
    expect(confirmBtn).toBeDefined()

    await act(async () => {
      confirmBtn.click()
    })

    expect(fakeApi.confirmGitInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: 'https://github.com/example/repo.git',
        tempDir: 'C:/temp/dsh-git-skill-abc',
        target: 'user',
      }),
    )

    expect(onInstalled).toHaveBeenCalled()
    expect(container.textContent).toContain('成功安装 1 个技能！')
  })

  async function renderWithSkills(
    skills: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const fakeApi = {
      list: vi.fn().mockResolvedValue({
        cwd: '',
        projectRoots: [],
        complete: true,
        groups: [{ key: 'central-store', title: '', hint: '', skills }],
      }),
      previewGitInstall: vi.fn(),
      confirmGitInstall: vi.fn(),
      cancelGitPreview: vi.fn(),
      ...extra,
    } as any

    await act(async () => {
      root.render(<GitInstallView api={fakeApi} />)
    })
    return { fakeApi, root }
  }

  it('shows the empty state when no repository came from Git yet', async () => {
    await renderWithSkills([])

    expect(container!.textContent).toContain('已导入的仓库')
    expect(container!.textContent).toContain('还没有从 Git 安装过仓库')
  })

  it('lists an imported repository with its skills, count and update badge', async () => {
    await renderWithSkills([
      {
        name: 'alpha',
        description: '',
        level: 'central-store',
        fileState: 'editable',
        modelInvocable: true,
        userInvocable: true,
        sourceType: 'git',
        sourceRef: 'https://github.com/acme/skills.git',
        sourceRefResolved: 'github.com/acme/skills',
        updateStatus: 'update_available',
        installedAt: Date.now(),
      },
      {
        name: 'beta',
        description: '',
        level: 'central-store',
        fileState: 'editable',
        modelInvocable: true,
        userInvocable: true,
        sourceType: 'git',
        sourceRef: 'git@github.com:acme/skills.git',
        sourceRefResolved: 'github.com/acme/skills',
        updateStatus: 'up_to_date',
        installedAt: Date.now(),
      },
    ])

    const text = container!.textContent ?? ''
    expect(text).toContain('acme/skills')
    expect(text).toContain('2 个技能')
    expect(text).toContain('有更新')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    // One row for two skills of the same repository.
    expect(container!.querySelectorAll('[data-dsh-part="imported-repos"] li')).toHaveLength(1)
  })

  it('warns in the preview that a same-named skill from another repo gets overwritten', async () => {
    const { fakeApi } = await renderWithSkills(
      [
        {
          name: 'alpha',
          description: '',
          level: 'central-store',
          fileState: 'editable',
          modelInvocable: true,
          userInvocable: true,
          sourceType: 'git',
          sourceRef: 'https://github.com/acme/other.git',
        },
      ],
      {
        previewGitInstall: vi.fn().mockResolvedValue({
          tempDir: 'C:/temp/dsh-git-skill-abc',
          skills: [{ relPath: '.', name: 'alpha', description: null }],
        }),
      },
    )

    const input = container!.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'https://github.com/acme/skills.git')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const cloneBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('克隆并预览'),
    ) as HTMLButtonElement
    await act(async () => {
      cloneBtn.click()
    })

    expect(fakeApi.previewGitInstall).toHaveBeenCalled()
    expect(container!.textContent).toContain('将覆盖来自 acme/other 的同名技能')
  })
})

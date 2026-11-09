/**
 * DetailDrawer component tests (jsdom):
 * verifies mount/unmount, async read fetch, fallback for fileless skills,
 * close button, Escape key handling, error boundary, and action callbacks.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillEntry } from '../src/client/api.ts'
import { DetailDrawer } from '../src/client/panel/DetailDrawer.tsx'

const sampleSkill: SkillEntry = {
  name: 'test-skill',
  description: 'A test skill for drawer',
  whenToUse: 'Use when testing drawer',
  level: 'project-dsh',
  path: '/work/.dsh/skills/test-skill/SKILL.md',
  fileState: 'editable',
  modelInvocable: true,
  userInvocable: true,
}

describe('DetailDrawer', () => {
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
      root.render(<DetailDrawer skill={null} api={{} as never} onClose={() => {}} />)
    })

    expect(container.innerHTML).toBe('')
    root.unmount()
  })

  it('fetches and displays content via api.read', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      read: vi.fn().mockResolvedValue({
        name: 'test-skill',
        path: sampleSkill.path,
        description: 'A test skill for drawer',
        whenToUse: 'Use when testing drawer',
        content: '# Test Skill\n\nPrompt instructions here.',
      }),
    }

    await act(async () => {
      root.render(<DetailDrawer skill={sampleSkill} api={fakeApi as never} onClose={() => {}} />)
    })

    expect(fakeApi.read).toHaveBeenCalledWith('test-skill', sampleSkill.path)
    expect(container.textContent).toContain('test-skill')
    expect(container.textContent).toContain('A test skill for drawer')
    expect(container.textContent).toContain('Prompt instructions here.')

    root.unmount()
  })

  it('displays error banner when api.read fails', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      read: vi.fn().mockRejectedValue(new Error('File not readable')),
    }

    await act(async () => {
      root.render(<DetailDrawer skill={sampleSkill} api={fakeApi as never} onClose={() => {}} />)
    })

    expect(container.textContent).toContain('File not readable')
    root.unmount()
  })

  it('calls onClose when close button clicked', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const onClose = vi.fn()
    const fakeApi = {
      read: vi.fn().mockResolvedValue({
        name: 'test-skill',
        path: sampleSkill.path,
        description: 'desc',
        content: 'content',
      }),
    }

    await act(async () => {
      root.render(<DetailDrawer skill={sampleSkill} api={fakeApi as never} onClose={onClose} />)
    })

    const closeBtn = container.querySelector('button[data-close]')
    expect(closeBtn).not.toBeNull()
    act(() => {
      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalled()
    root.unmount()
  })

  it('calls onClose when backdrop clicked', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const onClose = vi.fn()
    const fakeApi = {
      read: vi.fn().mockResolvedValue({
        name: 'test-skill',
        path: sampleSkill.path,
        description: 'desc',
        content: 'content',
      }),
    }

    await act(async () => {
      root.render(<DetailDrawer skill={sampleSkill} api={fakeApi as never} onClose={onClose} />)
    })

    const backdrop = container.querySelector('div[class*="modalBackdrop"]')
    expect(backdrop).not.toBeNull()
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalled()
    root.unmount()
  })

  it('calls onClose on Escape and removes listener on unmount', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const onClose = vi.fn()
    const fakeApi = {
      read: vi.fn().mockResolvedValue({
        name: 'test-skill',
        path: sampleSkill.path,
        description: 'desc',
        content: 'content',
      }),
    }

    await act(async () => {
      root.render(<DetailDrawer skill={sampleSkill} api={fakeApi as never} onClose={onClose} />)
    })

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    // Unmount
    root.unmount()

    // Dispatch again
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    // Must NOT be called again after unmount
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('triggers onEdit and onDuplicate callbacks', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const onEdit = vi.fn()
    const onDuplicate = vi.fn()
    const fakeApi = {
      read: vi.fn().mockResolvedValue({
        name: 'test-skill',
        path: sampleSkill.path,
        description: 'desc',
        content: 'content',
      }),
    }

    await act(async () => {
      root.render(
        <DetailDrawer
          skill={sampleSkill}
          api={fakeApi as never}
          onClose={() => {}}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
        />
      )
    })

    const dialog = container
    const editBtn = Array.from(dialog.querySelectorAll('button'))
      .find(b => b.textContent?.includes('编辑'))

    expect(editBtn).toBeDefined()

    act(() => {
      editBtn?.click()
    })
    expect(onEdit).toHaveBeenCalledWith(sampleSkill)

    // The duplicate action lives in the overflow menu.
    act(() => {
      dialog.querySelector('button[aria-expanded]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const copyBtn = Array.from(dialog.querySelectorAll('button'))
      .find(b => b.textContent?.includes('复制为模板'))
    expect(copyBtn).toBeDefined()

    act(() => {
      copyBtn?.click()
    })
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({
      from: 'test-skill',
      name: 'test-skill-copy',
    }))

    root.unmount()
  })

  it('gracefully handles virtual skill without path', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const virtualSkill: SkillEntry = {
      name: 'virtual-skill',
      description: 'Virtual skill desc',
      level: 'bundled',
      fileState: 'virtual',
      modelInvocable: true,
      userInvocable: true,
    }

    const fakeApi = {
      read: vi.fn(),
    }

    await act(async () => {
      root.render(<DetailDrawer skill={virtualSkill} api={fakeApi as never} onClose={() => {}} />)
    })

    expect(fakeApi.read).not.toHaveBeenCalled()
    expect(container.textContent).toContain('virtual-skill')
    expect(container.textContent).toContain('Virtual skill desc')

    root.unmount()
  })
})

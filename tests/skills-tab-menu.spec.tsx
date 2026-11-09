/**
 * SkillsTab card menu integration test:
 * clicking more action button elevates the card and displays dropdown,
 * and pressing Escape or clicking outside closes it cleanly.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ListPayload } from '../src/client/api.ts'
import { SkillsTab } from '../src/client/panel/SkillsTab.tsx'
import css from '../src/client/panel/panel.module.css'

const samplePayload: ListPayload = {
  cwd: '/work',
  projectRoots: [],
  complete: true,
  groups: [
    {
      key: 'user-dsh',
      title: 'User Skills',
      hint: '',
      skills: [
        {
          name: 'my-preview-skill',
          description: 'A skill with actions',
          whenToUse: 'Whenever needed',
          level: 'user-dsh',
          path: '/work/.dsh/skills/my-preview-skill/SKILL.md',
          fileState: 'editable',
          modelInvocable: true,
          userInvocable: true,
          isActiveWorkspace: false,
        },
      ],
    },
  ],
}

describe('SkillsTab card menu & elevation', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      container.remove()
      container = null
    }
  })

  it('elevates the card on menu open and closes on Escape or click outside', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      list: vi.fn().mockResolvedValue(samplePayload),
      read: vi.fn().mockResolvedValue({
        name: 'my-preview-skill',
        path: '/work/.dsh/skills/my-preview-skill/SKILL.md',
        description: 'A skill with actions',
        content: '# Instructions',
      }),
      setEnabled: vi.fn(),
      remove: vi.fn(),
    }

    await act(async () => {
      root.render(
        <SkillsTab
          api={fakeApi as never}
          onEdit={() => {}}
          onImport={() => {}}
          onDuplicate={() => {}}
          onSelectTab={() => {}}
        />
      )
    })

    const card = container.querySelector('[data-dsh-part="skill-row"]') as HTMLElement
    expect(card).not.toBeNull()
    expect(card.classList.contains(css.cardMenuOpen)).toBe(false)

    // Find the "more" button inside card actions
    const moreBtn = card.querySelector(`button[aria-label="更多操作"]`) as HTMLButtonElement
    expect(moreBtn).not.toBeNull()

    // 1. Click more button to open dropdown
    await act(async () => {
      moreBtn.click()
    })

    expect(card.classList.contains(css.cardMenuOpen)).toBe(true)
    const dropdown = card.querySelector(`.${css.actionDropdown}`) as HTMLElement
    expect(dropdown.classList.contains(css.dropdownOpen)).toBe(true)

    // 2. Press Escape to close menu
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(card.classList.contains(css.cardMenuOpen)).toBe(false)
    expect(dropdown.classList.contains(css.dropdownOpen)).toBe(false)

    // 3. Open menu again and test click outside
    await act(async () => {
      moreBtn.click()
    })
    expect(card.classList.contains(css.cardMenuOpen)).toBe(true)

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(card.classList.contains(css.cardMenuOpen)).toBe(false)
    expect(dropdown.classList.contains(css.dropdownOpen)).toBe(false)

    root.unmount()
  })

  it('copies the skill folder path from the menu and reports a refused write', async () => {
    // Given a panel listing one skill and a clipboard we control
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const fakeApi = {
      list: vi.fn().mockResolvedValue(samplePayload),
      read: vi.fn(),
      setEnabled: vi.fn(),
      remove: vi.fn(),
    }
    await act(async () => {
      root.render(
        <SkillsTab api={fakeApi as never} onEdit={() => {}} onImport={() => {}} onDuplicate={() => {}} onSelectTab={() => {}} />
      )
    })

    // When the operator picks the copy-path action
    const card = container.querySelector('[data-dsh-part="skill-row"]') as HTMLElement
    await act(async () => {
      (card.querySelector('button[aria-label="更多操作"]') as HTMLButtonElement).click()
    })
    const copyButton = Array.from(card.querySelectorAll('button')).find(b => b.textContent?.trim() === '复制路径')
    expect(copyButton).toBeInstanceOf(HTMLButtonElement)
    await act(async () => {
      copyButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 5))
    })

    // Then the folder is on the clipboard and the row says so
    expect(writeText).toHaveBeenCalledWith('/work/.dsh/skills/my-preview-skill')
    expect(card.textContent).toContain('路径已复制到剪贴板')

    // When the browser refuses the write
    writeText.mockRejectedValueOnce(new Error('denied'))
    await act(async () => {
      (card.querySelector('button[aria-label="更多操作"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      Array.from(card.querySelectorAll('button')).find(b => b.textContent?.trim() === '复制路径')?.click()
      await new Promise((resolve) => setTimeout(resolve, 5))
    })

    // Then the failure is reported instead of a false success
    expect(card.textContent).toContain('复制路径失败')

    await act(async () => { root.unmount() })
  })
})

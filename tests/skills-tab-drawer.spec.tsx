/**
 * SkillsTab DetailDrawer integration test:
 * clicking a skill card opens the detail drawer and renders instructions.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ListPayload } from '../src/client/api.ts'
import { SkillsTab } from '../src/client/panel/SkillsTab.tsx'

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
          description: 'A skill with rich instructions',
          whenToUse: 'Whenever needed',
          level: 'user-dsh',
          path: '/work/.dsh/skills/my-preview-skill/SKILL.md',
          fileState: 'editable',
          modelInvocable: true,
          userInvocable: true,
        },
      ],
    },
  ],
}

describe('SkillsTab DetailDrawer integration', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      container.remove()
      container = null
    }
  })

  it('opens DetailDrawer when clicking on a skill card', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      list: vi.fn().mockResolvedValue(samplePayload),
      read: vi.fn().mockResolvedValue({
        name: 'my-preview-skill',
        path: '/work/.dsh/skills/my-preview-skill/SKILL.md',
        description: 'A skill with rich instructions',
        whenToUse: 'Whenever needed',
        content: '# Deep Instructions\nStep 1: do this.\nStep 2: do that.',
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
        />
      )
    })

    // Verify card is in document
    const card = container.querySelector('[data-dsh-part="skill-row"]')
    expect(card).not.toBeNull()

    // Click card body
    await act(async () => {
      card?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Verify drawer dialog is open
    const drawer = container.querySelector('aside[role="dialog"]')
    expect(drawer).not.toBeNull()
    expect(drawer?.textContent).toContain('Deep Instructions')

    root.unmount()
  })
})

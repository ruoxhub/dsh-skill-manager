/**
 * SkillsTab Batch Delete tests:
 * verifies selecting multiple skills and triggering batch deletion.
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
          name: 'skill-a',
          description: 'Skill A',
          level: 'user-dsh',
          path: '/work/.dsh/skills/skill-a/SKILL.md',
          fileState: 'editable',
          modelInvocable: true,
          userInvocable: true,
        },
        {
          name: 'skill-b',
          description: 'Skill B',
          level: 'user-dsh',
          path: '/work/.dsh/skills/skill-b/SKILL.md',
          fileState: 'editable',
          modelInvocable: false,
          userInvocable: true,
        },
        {
          name: 'skill-linked',
          description: 'Linked skill',
          level: 'user-dsh',
          path: '/work/.dsh/skills/skill-linked/SKILL.md',
          fileState: 'editable',
          linked: true, // Should NOT be deleted
          modelInvocable: true,
          userInvocable: true,
        },
      ],
    },
  ],
}

describe('SkillsTab Batch Delete', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      container.remove()
      container = null
    }
    vi.restoreAllMocks()
  })

  it('triggers api.remove for deletable selected skills upon confirmation', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    const fakeApi = {
      list: vi.fn().mockResolvedValue(samplePayload),
      setEnabled: vi.fn(),
      setProviderEnabled: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true, name: '', moved: '' }),
      read: vi.fn(),
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

    // Click the batch mode toggle button
    const batchBtn = container.querySelector('button[class*="batchButton"]') as HTMLButtonElement
    expect(batchBtn).not.toBeNull()
    await act(async () => {
      batchBtn.click()
    })

    // Click select all
    const selectAllBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('全选')
    )
    expect(selectAllBtn).toBeDefined()
    await act(async () => {
      selectAllBtn?.click()
    })

    // Find the batch delete button
    const deleteBtn = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('批量删除')
    )
    expect(deleteBtn).toBeDefined()

    // Confirm dialog mock
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    // Click batch delete
    await act(async () => {
      deleteBtn?.click()
    })

    // Verify api.remove called for skill-a and skill-b, but NOT for skill-linked
    expect(fakeApi.remove).toHaveBeenCalledWith('skill-a', '/work/.dsh/skills/skill-a/SKILL.md')
    expect(fakeApi.remove).toHaveBeenCalledWith('skill-b', '/work/.dsh/skills/skill-b/SKILL.md')
    expect(fakeApi.remove).not.toHaveBeenCalledWith('skill-linked', expect.anything())

    root.unmount()
  })
})

/**
 * Skill center panel state ownership.
 *
 * The panel's tab and editor target live in the controller because the layout
 * mounts a keyed main page only while its panel is selected: component-local
 * state would drop the open tab and any in-progress edit on every panel
 * switch. These cases lock that contract, plus the layout handshake the native
 * registration depends on.
 */
import { describe, expect, it } from 'vitest'
import type { SkillEntry } from '../src/client/api.ts'
import { PanelController, SKILL_EXPLORER_PANEL_ID } from '../src/client/panel/controller.ts'

/** A skill row the editor can be opened for. */
function skill(name: string): SkillEntry {
  return { name, description: '', level: 'user', fileState: 'editable', modelInvocable: true, userInvocable: true }
}

/** A controller plus the panel ids it asked the layout to select. */
function withPanelFace() {
  const selections: Array<string | null> = []
  const controller = new PanelController({ panel: { select: id => { selections.push(id) } } })
  return { controller, selections }
}

describe('skill center panel state', () => {
  it('operator sees the open tab survive a panel switch away and back', () => {
    // Given a panel showing the create tab
    const { controller } = withPanelFace()
    controller.open()
    controller.setActiveTab('create')

    // When the user switches to another panel and returns
    controller.syncPanelSelection(null)
    controller.syncPanelSelection(SKILL_EXPLORER_PANEL_ID)

    // Then the tab is still the one they left, because the state is not in the
    // page component the layout unmounted
    expect(controller.getSnapshot().activeTab).toBe('create')
    expect(controller.getSnapshot().panelOpen).toBe(true)
  })

  it('operator editing a skill sees the edit target survive a panel switch', () => {
    // Given an open editor for one skill
    const { controller } = withPanelFace()
    controller.open()
    controller.openEditor(skill('alpha'))

    // When the user leaves the panel and comes back
    controller.syncPanelSelection(null)
    controller.syncPanelSelection(SKILL_EXPLORER_PANEL_ID)

    // Then the edit tab and its target are intact, so a half-finished edit is
    // never silently discarded
    expect(controller.getSnapshot().activeTab).toBe('edit')
    expect(controller.getSnapshot().editing?.name).toBe('alpha')

    // And leaving the editor returns to the list and clears the target
    controller.closeEditor()
    expect(controller.getSnapshot().activeTab).toBe('skills')
    expect(controller.getSnapshot().editing).toBeUndefined()
  })

  it('operator opening the panel sees the layout asked to select it', () => {
    // Given a controller wired to the layout's panel-navigation face
    const { controller, selections } = withPanelFace()

    // When the panel opens and closes
    controller.open()
    controller.close()

    // Then the layout was asked for this panel id and then for the
    // conversation, instead of the plugin taking the column over itself
    expect(selections).toEqual([SKILL_EXPLORER_PANEL_ID, null])
  })

  it('operator on the skill center has no plugin-driven close, only the shell reconciliation (#1785)', () => {
    // Given a controller whose only production driver is the layout's panelInfo
    // reconciliation: the sidebar row selects a panel (it never asks the plugin
    // to close one) and session navigation goes through the shell
    const { controller, selections } = withPanelFace()

    // When the shell reports the panel selected, then unselected — the way a
    // session row leaving the center column arrives
    controller.syncPanelSelection(SKILL_EXPLORER_PANEL_ID)
    controller.syncPanelSelection(null)

    // Then the controller follows the layout both ways, and neither direction
    // asks the layout for anything: the reconciliation must not loop back into
    // a selection, which is what removed the panel's own close path (#1785)
    expect(selections).toEqual([])
    expect(controller.getSnapshot().panelOpen).toBe(false)
  })

  it('operator selecting another panel row sees the controller follow the layout', () => {
    // Given an open panel
    const { controller } = withPanelFace()
    controller.open()

    // When the layout reports a different panel (the user clicked another row)
    controller.syncPanelSelection('task-board')

    // Then the controller reflects what the column actually shows, without
    // asking the layout to select anything back
    expect(controller.getSnapshot().panelOpen).toBe(false)
  })

  it('operator sees a snapshot stay stable until something changes', () => {
    // Given a controller
    const { controller } = withPanelFace()

    // When the snapshot is read twice with no change in between
    const first = controller.getSnapshot()
    const second = controller.getSnapshot()

    // Then it is the same object, so a React store subscriber does not re-render
    // forever on an unchanged value
    expect(second).toBe(first)

    // And a change produces a new snapshot
    controller.setActiveTab('create')
    expect(controller.getSnapshot()).not.toBe(first)
  })
})

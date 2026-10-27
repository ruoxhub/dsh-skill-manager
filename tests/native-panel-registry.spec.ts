// @vitest-environment jsdom
/**
 * The skill center's registrations validated against the REAL slot core.
 *
 * Every other spec in this package drives a fake seats service, so it checks
 * the wiring but not the registry's own rules: that a keyed slot admits one
 * entry per key, that a list entry carries the id/order/label shape its kind
 * requires, and that disposal releases what was registered. This spec runs
 * `registerSkillExplorerPanel` against the genuine `SlotCore` the running
 * shell installs, so an option shape the registry rejects fails here instead
 * of in the GUI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillApi } from '../src/client/api.ts'
import { registerSkillExplorerPanel } from '../src/client/native-panel.tsx'
import { PanelController } from '../src/client/panel/controller.ts'

/** A controller with no layout face: the registration drives its own state. */
function controller(): PanelController {
  return new PanelController()
}

/** The API face the page receives; the registration never calls it. */
const api = {} as SkillApi

/**
 * A client context whose slots service is the real SlotCore. `inject` answers
 * immediately (the real one defers until ui-layout / ui-sidebar declare the
 * seats), which is the point: the core itself validates the option shapes.
 *
 * The core only admits a registration into a DECLARED seat, so the harness
 * declares the two seats the way the shell does.
 */
function realCoreContext() {
  const core = new SlotCore()
  const slots = {
    register: (options: never, component: never) => core.register(options, component as never),
    inject: (_key: string, callback: () => () => void) => callback(),
  }
  const ctx = {
    effect(callback: () => void | (() => void)) { callback() },
    get: () => undefined,
    on: () => () => {},
    slots,
  }
  return { ctx: ctx as never, core, declare: () => {
    core.register({
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        sidebar: { kind: 'single', scope: 'root' },
      },
    } as never, (() => null) as never)
    core.register({
      name: 'sidebar',
      children: {
        'sidebar.panellist': { kind: 'list', scope: 'root' },
      },
    } as never, (() => null) as never)
  } }
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') })) })

describe('skill-explorer registrations against the real slot core', () => {
  it('operator sees the skill center occupy the keyed main seat and a list row seat', () => {
    // Given the genuine slot registry the shell installs
    const { ctx, core, declare } = realCoreContext()
    declare()

    // When the skill center registers its panel
    const dispose = registerSkillExplorerPanel(ctx, controller(), api)

    // Then the registry holds one keyed main entry and one list row entry
    const main = core.entries('main')
    const rows = core.entries('sidebar.panellist')
    expect(main).toHaveLength(1)
    expect(main[0]!.options.key).toBe('skill-explorer')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.options.id).toBe('skill-explorer')
    expect(rows[0]!.options.order).toBe(30)

    dispose()
    // And disposal clears both, so a rebuilt bundle re-registers cleanly
    expect(core.entries('main')).toHaveLength(0)
    expect(core.entries('sidebar.panellist')).toHaveLength(0)
  })

  it('operator switching language sees the row label resolve through the registry', () => {
    // Given a registered panel whose row carries a function label
    const { ctx, core, declare } = realCoreContext()
    declare()
    const dispose = registerSkillExplorerPanel(ctx, controller(), api)

    // When the shell resolves the row label
    const label = core.entries('sidebar.panellist')[0]!.options.label

    // Then it is a function, so the shell re-resolves it on every locale
    // change instead of freezing the mount-time copy, and it renders the
    // active language rather than the dictionary key
    expect(typeof label).toBe('function')
    const text = (label as () => string)()
    expect(text).not.toBe('entry.label')
    expect(text.length).toBeGreaterThan(0)

    dispose()
  })

  it('operator sees a duplicate panel registration refused, never silently duplicated', () => {
    // Given a registered skill center
    const { ctx, declare } = realCoreContext()
    declare()
    registerSkillExplorerPanel(ctx, controller(), api)

    // When a second registration claims the same panel seats
    // Then the registry refuses it rather than silently shadowing the first,
    // which is why the id/key pair must stay stable across a bundle rebuild
    expect(() => registerSkillExplorerPanel(ctx, controller(), api)).toThrow(/already has an entry/)
  })
})

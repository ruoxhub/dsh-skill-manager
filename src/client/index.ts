/**
 * Browser-half entry for the dsh-skill-explorer plugin — runs inside the dsh web GUI.
 *
 * Registers the skill-explorer locale dictionaries and mounts the panel as a
 * native center-column page: a row in the shell's own sidebar panel list and a
 * keyed `main` page, both through the official slot seats. Failure policy:
 * registration problems are logged, never thrown — the web shell fails the
 * whole boot when a plugin apply throws, and an external plugin must not take
 * the GUI down.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry since 0.1.2).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SkillApi } from './api.ts'
import { PanelController, SKILL_EXPLORER_PANEL_ID } from './panel/controller.ts'
import { setRuntimeTranslate } from './panel-helpers.ts'
import { en, zh, type SkillExplorerKey } from './locales.ts'
import { registerSkillExplorerPanel } from './native-panel.tsx'
import { reportDailyHeartbeat } from './telemetry.ts'

/** Locale namespace this plugin owns. */
const NS = 'dsh-skill-explorer'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** skill-explorer surface copy. */
    'dsh-skill-explorer': SkillExplorerKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'layout']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { SkillPanelProps } from './panel/SkillPanel.tsx'
export type { SkillExplorerKey } from './locales.ts'
export type { SkillApi } from './api.ts'

/**
 * Mount the skill center surfaces.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: ClientContext): void {
  // Anonymous install heartbeat (docs/telemetry.md): one beat per browser per
  // UTC day, package name only, silent failure.
  reportDailyHeartbeat([{ name: '@moruoxing/dsh-skill-manager' }])

  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'skill-explorer: dictionaries')

  // Wire the SDK translate seat into the module-level tt (panel chrome and
  // other plain-DOM callers): reads the active locale at call time, so they
  // follow the Language setting without a reload.
  try { setRuntimeTranslate(ctx.locale.bind(NS)) } catch { /* locale missing: document-language fallback stays */ }

  const api = new SkillApi()
  // Panel navigation belongs to the layout service: the panel asks it to
  // select its own panel id (or the conversation) instead of taking over the
  // center column at the DOM level. The lookup stays lazy so a selection
  // issued before the service settles still lands once it does, and the face
  // throws by contract before the layout root entry mounts, which the
  // controller tolerates.
  const controller = new PanelController({
    panel: {
      select: panelId => {
        const layout = (ctx as unknown as { get?(name: string): unknown }).get?.('layout') as { selectPanel?: (id: string | null) => void } | undefined
        layout?.selectPanel?.(panelId)
      },
    },
  })
  const disposers: Array<() => void> = []
  try {
    disposers.push(registerSkillExplorerPanel(ctx, controller, api))
    // The layout's panel selection is reconciled back into the controller, so
    // the panel follows the user clicking another panel row.
    const layoutFace = (ctx as unknown as { get?(name: string): unknown }).get?.('layout') as { panelInfo?: { subscribe(listener: () => void): () => void; getSnapshot(): { activePanelId: unknown } } } | undefined
    if (layoutFace?.panelInfo !== undefined) {
      const sync = (): void => {
        const active = layoutFace.panelInfo!.getSnapshot().activePanelId
        controller.syncPanelSelection(active === SKILL_EXPLORER_PANEL_ID ? SKILL_EXPLORER_PANEL_ID : null)
      }
      sync()
      disposers.push(layoutFace.panelInfo.subscribe(sync))
    }
  } catch (error) {
    // Registration failures degrade the panel, never the GUI.
    console.warn('[skill-explorer] panel registration failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'skill-explorer: ui mounts')
}

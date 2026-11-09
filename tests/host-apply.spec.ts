/**
 * Host apply tests: enabled=false registers nothing; enabled registers the
 * route family and disposes cleanly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

/** The mountOnce registry key (mirrors shared/host/mount-once.ts) — reset between applies so each case starts fresh. */
const MOUNTED = Symbol.for('dsh-web.mounted-plugins')

function resetMountOnce(): void {
  ;(globalThis as Record<symbol, unknown>)[MOUNTED] = undefined
}

beforeEach(resetMountOnce)

/** Fake cordis ctx capturing route registrations. */
function fakeCtx() {
  const state = { routes: [] as Array<{ path?: string }>, effects: [] as string[] }
  return {
    ...state,
    webServer: {
      register: (route: { path?: string }) => { state.routes.push(route); return () => {} },
    },
    skills: {
      snapshot: async () => ({ skills: [], complete: true }),
    },
    sessions: {
      list: () => [],
    },
    logger: { warn: () => {} },
    effect: (fn: () => unknown, label: string) => {
      state.effects.push(label)
      const disposer = fn()
      return () => { if (typeof disposer === 'function') (disposer as () => void)() }
    },
  }
}

describe('skill-explorer host apply', () => {
  it('is a no-op for a second mount of the same package (aggregate + standalone coexist)', () => {
    const first = fakeCtx()
    apply(first as never, {})
    expect(first.routes.length).toBe(36)
    const second = fakeCtx()
    apply(second as never, {})
    expect(second.routes.length).toBe(0)
  })

  it('registers nothing when enabled is false', () => {
    const ctx = fakeCtx()
    apply(ctx as never, { enabled: false })
    expect(ctx.routes.length).toBe(0)
  })

  it('registers the thirty-six routes when enabled (default)', () => {
    const ctx = fakeCtx()
    apply(ctx as never, {})
    const paths = ctx.routes.map((route) => route.path)
    expect(paths).toEqual([
      '/api/dsh-skill-explorer/list',
      '/api/dsh-skill-explorer/read',
      '/api/dsh-skill-explorer/set-enabled',
      '/api/dsh-skill-explorer/set-provider-enabled',
      '/api/dsh-skill-explorer/create',
      '/api/dsh-skill-explorer/import',
      '/api/dsh-skill-explorer/update',
      '/api/dsh-skill-explorer/delete',
      '/api/dsh-skill-explorer/health',
      '/api/dsh-skill-explorer/market/search',
      '/api/dsh-skill-explorer/market/detail',
      '/api/dsh-skill-explorer/market/install',
      '/api/dsh-skill-explorer/git/preview',
      '/api/dsh-skill-explorer/git/confirm',
      '/api/dsh-skill-explorer/git/cancel',
      '/api/dsh-skill-explorer/check-all',
      '/api/dsh-skill-explorer/check-one',
      '/api/dsh-skill-explorer/update-all',
      '/api/dsh-skill-explorer/presets',
      '/api/dsh-skill-explorer/presets/save',
      '/api/dsh-skill-explorer/presets/delete',
      '/api/dsh-skill-explorer/presets/apply',
      '/api/dsh-skill-explorer/backup/status',
      '/api/dsh-skill-explorer/backup/init',
      '/api/dsh-skill-explorer/backup/commit',
      '/api/dsh-skill-explorer/backup/snapshots',
      '/api/dsh-skill-explorer/backup/restore',
      '/api/dsh-skill-explorer/backup/remote',
      '/api/dsh-skill-explorer/tags',
      '/api/dsh-skill-explorer/tags/set',
      '/api/dsh-skill-explorer/tags/rename',
      '/api/dsh-skill-explorer/tags/delete',
      '/api/dsh-skill-explorer/trash',
      '/api/dsh-skill-explorer/trash/restore',
      '/api/dsh-skill-explorer/audit',
      '/api/dsh-skill-explorer/update-one',
    ])
  })
})

describe('skill-explorer host apply: provider-row custom roots (#1801)', () => {
  it('operator sees the live skill-filesystem row customSkillDirs reach the list route', async () => {
    // Given a host whose loader carries a skill-filesystem row with a custom
    // root, and a skill file inside that root
    const tmp = mkdtempSync(join(tmpdir(), 'skill-explorer-apply-'))
    const customRoot = join(tmp, 'custom-root')
    const file = join(customRoot, 'apply-skill', 'SKILL.md')
    mkdirSync(join(customRoot, 'apply-skill'), { recursive: true })
    writeFileSync(file, '---\nname: apply-skill\ndescription: 行配置\n---\n', 'utf8')
    try {
      const state = { routes: [] as Array<{ path?: string; handler: (req: unknown, res: unknown) => Promise<void> }> }
      const ctx = {
        webServer: { register: (route: { path?: string; handler: (req: unknown, res: unknown) => Promise<void> }) => { state.routes.push(route); return () => {} } },
        skills: { snapshot: async () => ({ skills: [], complete: true }) },
        sessions: { list: () => [] },
        logger: { warn: () => {} },
        get: (name: string) => name === 'loader'
          ? { entries: () => [{ options: { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [customRoot] } } }] }
          : undefined,
        effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') (d as () => void)() } },
      }
      resetMountOnce()
      apply(ctx as never, {})

      // When the list route serves the panel
      const list = state.routes.find(route => route.path === '/api/dsh-skill-explorer/list')!
      const captured = { status: 0, body: '' }
      const res = {
        writeHead(status: number) { captured.status = status },
        end(body: string) { captured.body = body },
      }
      const req = {
        url: '/api/dsh-skill-explorer/list',
        method: 'GET',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:3080' },
      }
      await list.handler(req, res)

      // Then the row-configured skill is listed with its editable path
      expect(captured.status).toBe(200)
      const payload = JSON.parse(captured.body)
      const custom = payload.groups.find((g: { key: string }) => g.key === 'custom')
      expect(custom.skills[0].name).toBe('apply-skill')
      expect(custom.skills[0].path).toBe(file)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})


describe('skill-explorer host apply: central store wiring (#central)', () => {
  it('the list route scans the central skills dir by default', async () => {
    // Given a home whose central skills-manager store holds one skill, and a
    // plugin config that overrides dshHome/agentsHome (which makes collect.ts
    // skip its implicit central dir fallback)
    const tmp = mkdtempSync(join(tmpdir(), 'skill-explorer-central-'))
    const central = join(tmp, 'central', 'skills')
    mkdirSync(join(central, 'central-skill'), { recursive: true })
    writeFileSync(join(central, 'central-skill', 'SKILL.md'), '---\nname: central-skill\ndescription: 中央库技能\n---\n', 'utf8')
    try {
      const state = { routes: [] as Array<{ path?: string; handler: (req: unknown, res: unknown) => Promise<void> }> }
      const ctx = {
        webServer: { register: (route: { path?: string; handler: (req: unknown, res: unknown) => Promise<void> }) => { state.routes.push(route); return () => {} } },
        skills: { snapshot: async () => ({ skills: [], complete: true }) },
        sessions: { list: () => [] },
        logger: { warn: () => {} },
        effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') (d as () => void)() } },
      }
      resetMountOnce()
      apply(ctx as never, { dshHome: join(tmp, 'dsh'), agentsHome: join(tmp, 'agents'), centralSkillsDir: central })

      // When the panel asks for the list
      const list = state.routes.find(route => route.path === '/api/dsh-skill-explorer/list')!
      const captured = { status: 0, body: '' }
      const res = { writeHead(status: number) { captured.status = status }, end(body: string) { captured.body = body } }
      const req = { url: '/api/dsh-skill-explorer/list', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' } }
      await list.handler(req, res)

      // Then the central skill is listed under its own group
      expect(captured.status).toBe(200)
      const payload = JSON.parse(captured.body)
      const group = payload.groups.find((g: { key: string }) => g.key === 'central-store')
      expect(group?.skills.map((s: { name: string }) => s.name)).toEqual(['central-skill'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

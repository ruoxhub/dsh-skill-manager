import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CentralSkillStore } from '../src/central-store.ts'
import * as remoteResolver from '../src/remote-resolver.ts'
import * as skillUpdater from '../src/skill-updater.ts'
import { ROUTES, makeRoutes } from '../src/routes.ts'

/** One fake IncomingMessage: loopback socket + Host by default. */
function request(
  url: string,
  method = 'GET',
  options: { remoteAddress?: string; host?: string; body?: unknown } = {},
): IncomingMessage {
  const req = {
    url,
    method,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers: {
      host: options.host ?? 'localhost:3080',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body))
    },
  }
  return req as unknown as IncomingMessage
}

/** One fake ServerResponse capturing status/body. */
function response(): { res: ServerResponse; status: () => number; json: () => unknown } {
  const state = { status: 0, body: '' }
  const res = {
    writeHead(status: number) { state.status = status },
    end(body: string) { state.body = body },
  } as unknown as ServerResponse
  return {
    res,
    status: () => state.status,
    json: () => JSON.parse(state.body || '{}'),
  }
}

describe('check & update routes', () => {
  let store: CentralSkillStore
  let routes: ReturnType<typeof makeRoutes>
  const find = (path: string) => routes.find((r) => r.path === path)

  beforeEach(() => {
    store = new CentralSkillStore(':memory:', true)
    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db
    db.exec(`
      INSERT INTO skills (id, name, description, source_type, source_ref, central_path, source_revision, remote_revision, source_branch, update_status, created_at, updated_at)
      VALUES 
        ('s1', 'caveman', 'Terse voice', 'git', 'https://github.com/JuliusBrussee/caveman', 'C:/Users/test/.skills-manager/skills/caveman', 'rev1', 'rev1', 'main', 'up_to_date', 1700000000000, 1700000000000),
        ('s2', 'test-tool', 'Another tool', 'git', 'https://github.com/example/repo', 'C:/Users/test/.skills-manager/skills/test-tool', 'rev1', 'rev2', 'main', 'update_available', 1700000000000, 1700000000000);
    `)

    routes = makeRoutes({} as never, {
      dshHome: 'C:/Users/test/.dsh',
      agentsHome: 'C:/Users/test/.agents',
      customSkillDirs: [],
      registry: { snapshot: async () => ({ skills: [], complete: true }) },
      activeSessionCwds: () => [],
      logger: { warn: () => {} },
      centralStore: store,
    })
  })

  afterEach(() => {
    store.close()
    vi.restoreAllMocks()
  })

  it('handles POST /api/dsh-skill-explorer/check-all', async () => {
    vi.spyOn(remoteResolver, 'checkAllSkills').mockResolvedValueOnce({
      total: 2,
      checked: 2,
      updateAvailable: 1,
      errors: 0,
      lastCheckedAt: 1700000000000,
      results: [
        { id: 's1', name: 'caveman', sourceType: 'git', sourceRef: 'https://github.com/JuliusBrussee/caveman', sourceRevision: 'rev1', updateStatus: 'up_to_date', remoteRevision: 'rev1' },
        { id: 's2', name: 'test-tool', sourceType: 'git', sourceRef: 'https://github.com/example/repo', sourceRevision: 'rev1', updateStatus: 'update_available', remoteRevision: 'rev2' },
      ],
    })

    const route = find(ROUTES.checkAll)
    expect(route).toBeDefined()
    const { res, status, json } = response()
    await route!.handler(request(ROUTES.checkAll, 'POST'), res)
    expect(status()).toBe(200)
    const data = json() as { ok: boolean; summary: { total: number; updateAvailable: number } }
    expect(data.ok).toBe(true)
    expect(data.summary.total).toBe(2)
    expect(data.summary.updateAvailable).toBe(1)
  })

  it('rejects GET on check-all (mutating scan must stay POST)', async () => {
    const route = find(ROUTES.checkAll)
    const { res, status, json } = response()
    await route!.handler(request(ROUTES.checkAll, 'GET'), res)
    expect(status()).toBe(405)
    expect((json() as { error: string }).error).toContain('method not allowed')
  })

  it('handles POST /api/dsh-skill-explorer/check-one with name', async () => {
    vi.spyOn(remoteResolver, 'checkOneSkill').mockResolvedValueOnce({
      id: 's1',
      name: 'caveman',
      sourceType: 'git',
      sourceRef: 'https://github.com/JuliusBrussee/caveman',
      sourceRevision: 'rev1',
      updateStatus: 'up_to_date',
      remoteRevision: 'rev1',
    })

    const route = find(ROUTES.checkOne)
    expect(route).toBeDefined()
    const { res, status, json } = response()
    await route!.handler(request(ROUTES.checkOne, 'POST', { body: { name: 'caveman' } }), res)
    expect(status()).toBe(200)
    const data = json() as { ok: boolean; result: { name: string; updateStatus: string } }
    expect(data.ok).toBe(true)
    expect(data.result.name).toBe('caveman')
    expect(data.result.updateStatus).toBe('up_to_date')
  })

  it('handles POST /api/dsh-skill-explorer/update-all', async () => {
    vi.spyOn(skillUpdater, 'updateAllSkills').mockResolvedValueOnce({
      total: 1,
      updated: 1,
      failed: 0,
      results: [{ id: 's2', name: 'test-tool', success: true, newRevision: 'rev2', previousRevision: 'rev1', updatedTargetsCount: 1 }],
    })

    const route = find(ROUTES.updateAll)
    expect(route).toBeDefined()
    const { res, status, json } = response()
    await route!.handler(request(ROUTES.updateAll, 'POST'), res)
    expect(status()).toBe(200)
    const data = json() as { ok: boolean; summary: { updated: number } }
    expect(data.ok).toBe(true)
    expect(data.summary.updated).toBe(1)
  })

  it('handles POST /api/dsh-skill-explorer/update-one with name', async () => {
    vi.spyOn(skillUpdater, 'updateOneSkill').mockResolvedValueOnce({
      id: 's2',
      name: 'test-tool',
      success: true,
      newRevision: 'rev2',
      previousRevision: 'rev1',
      updatedTargetsCount: 1,
    })

    const route = find(ROUTES.updateOne)
    expect(route).toBeDefined()
    const { res, status, json } = response()
    await route!.handler(request(ROUTES.updateOne, 'POST', { body: { name: 'test-tool' } }), res)
    expect(status()).toBe(200)
    const data = json() as { ok: boolean; result: { success: boolean; newRevision: string } }
    expect(data.ok).toBe(true)
    expect(data.result.success).toBe(true)
    expect(data.result.newRevision).toBe('rev2')
  })
})

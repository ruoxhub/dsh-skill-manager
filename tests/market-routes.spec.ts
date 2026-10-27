import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeRoutes, ROUTES } from '../src/routes.ts'

const TMP = mkdtempSync(join(tmpdir(), 'skill-market-routes-'))
const HOME = join(TMP, 'home')
const PROJ = join(TMP, 'proj')
mkdirSync(join(HOME, 'skills'), { recursive: true })
mkdirSync(join(PROJ, '.git'), { recursive: true })
mkdirSync(join(PROJ, '.dsh', 'skills'), { recursive: true })

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const registry = {
  snapshot: async () => ({ skills: [], complete: true }),
}

const deps = {
  dshHome: HOME,
  agentsHome: join(TMP, 'agents'),
  customSkillDirs: [],
  registry,
  activeSessionCwds: () => [PROJ],
  logger: { warn: () => {} },
}

const routes = makeRoutes({} as never, deps)
const find = (path: string) => routes.find(route => route.path === path)

function request(url: string, method = 'GET', options: { body?: unknown } = {}): IncomingMessage {
  const req = {
    url,
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: 'localhost:3080',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield Buffer.from(JSON.stringify(options.body))
    },
  }
  return req as unknown as IncomingMessage
}

function response(): { res: ServerResponse; status: () => number; json: () => any } {
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

describe('market routes registration', () => {
  it('registers market routes in ROUTES constant', () => {
    expect(ROUTES.marketSearch).toBe('/api/dsh-skill-explorer/market/search')
    expect(ROUTES.marketDetail).toBe('/api/dsh-skill-explorer/market/detail')
    expect(ROUTES.marketInstall).toBe('/api/dsh-skill-explorer/market/install')
  })

  it('exposes handlers for market routes', () => {
    expect(find(ROUTES.marketSearch)).toBeDefined()
    expect(find(ROUTES.marketDetail)).toBeDefined()
    expect(find(ROUTES.marketInstall)).toBeDefined()
  })

  it('marketDetail rejects missing slug with 400', async () => {
    const handler = find(ROUTES.marketDetail)!.handler
    const { res, status, json } = response()
    await handler(request(ROUTES.marketDetail, 'GET'), res)
    expect(status()).toBe(400)
    expect(json().error).toContain('slug')
  })

  it('marketInstall rejects missing slug or target with 400', async () => {
    const handler = find(ROUTES.marketInstall)!.handler
    const { res, status, json } = response()
    await handler(request(ROUTES.marketInstall, 'POST', { body: {} }), res)
    expect(status()).toBe(400)
    expect(json().error).toContain('slug')
  })
})

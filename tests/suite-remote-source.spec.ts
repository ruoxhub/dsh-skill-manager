import { it, expect } from 'vitest'
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTES, makeRoutes } from '../src/routes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

function request(url: string, method = 'GET', body?: unknown): IncomingMessage {
  return {
    url, method, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:3080', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  } as unknown as IncomingMessage
}
function response() {
  const s = { status: 0, body: '' }
  return { res: { writeHead(n: number) { s.status = n }, end(b: string) { s.body = b } } as unknown as ServerResponse, status: () => s.status, body: () => s.body }
}

it('object-source marketplace routes answer actionable errors, not 500 type crashes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inst-'))
  const agentsHome = join(root, 'agents')
  const mpDir = join(agentsHome, 'plugins', 'marketplaces', 'sp-marketplace')
  mkdirSync(join(mpDir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(mpDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'sp-marketplace',
    plugins: [{ name: 'superpowers', source: { source: 'url', url: 'https://github.com/obra/superpowers.git' } }],
  }), 'utf8')
  writeFileSync(join(agentsHome, 'plugins', 'known_marketplaces.json'), JSON.stringify({
    'sp-marketplace': { name: 'sp-marketplace', manifestName: 'sp-marketplace', type: 'git', installLocation: mpDir },
  }), 'utf8')

  const routes = makeRoutes({} as never, {
    dshHome: join(root, 'dsh'), agentsHome,
    customSkillDirs: [], registry: { snapshot: async () => ({ skills: [], complete: true }) },
    activeSessionCwds: () => [], logger: { warn: () => {} },
  })
  const hit = async (p: string, method = 'GET', body?: unknown) => {
    const path = p.split('?')[0]
    const r = response()
    await routes.find(x => x.path === path)!.handler(request(p, method, body), r.res)
    return { status: r.status(), body: r.body() }
  }

  const plugins = await hit(`${ROUTES.suitesPlugins}?marketplace=sp-marketplace&root=user`)
  const pj = JSON.parse(plugins.body)
  expect(plugins.status).toBe(200)
  expect(pj.plugins[0].source).toBe('https://github.com/obra/superpowers.git')

  const install = await hit(ROUTES.suitesInstall, 'POST', { marketplace: 'sp-marketplace', plugin: 'superpowers', root: 'user' })
  expect(install.status).toBe(500)
  expect(install.body).toContain('not available locally')
  expect(install.body).not.toContain('paths[1]')
})

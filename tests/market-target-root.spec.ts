import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeRoutes, ROUTES } from '../src/routes.ts'
import { marketIdentities } from '../src/skillhub/installed.ts'

const TMP = mkdtempSync(join(tmpdir(), 'skill-market-identity-'))
const AGENTS = join(TMP, 'agents')
const DSH = join(TMP, 'dsh')
const PROJ = join(TMP, 'proj')
mkdirSync(join(AGENTS, 'skills', 'pdf-master'), { recursive: true })
mkdirSync(join(PROJ, '.git'), { recursive: true })
mkdirSync(join(DSH), { recursive: true })

// The installed directory name (the market slug) and the skill's declared name
// deliberately differ: that is the case the old name-only check got wrong.
writeFileSync(
  join(AGENTS, 'skills', 'pdf-master', 'SKILL.md'),
  '---\nname: document-ninja\ndescription: Builds PDFs\n---\n\nBody\n',
)

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const deps = {
  dshHome: DSH,
  agentsHome: AGENTS,
  customSkillDirs: [],
  registry: { snapshot: async () => ({ skills: [], complete: true }) },
  activeSessionCwds: () => [PROJ],
  logger: { warn: () => {} },
}

const routes = makeRoutes({} as never, deps)

function request(url: string, method = 'GET', body?: unknown): IncomingMessage {
  return {
    url,
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: 'localhost:3080',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  } as unknown as IncomingMessage
}

function makeResponse(): { res: ServerResponse; status: () => number; json: () => unknown } {
  const state = { status: 0, body: '' }
  return {
    res: {
      writeHead(status: number) { state.status = status },
      end(body: string) { state.body = body },
    } as unknown as ServerResponse,
    status: () => state.status,
    json: () => JSON.parse(state.body || '{}'),
  }
}

describe('market install target root', () => {
  it('refuses a target root outside the plugin-owned skill roots', async () => {
    const route = routes.find(candidate => candidate.path === ROUTES.marketInstall)!
    const { res, status, json } = makeResponse()
    await route.handler(
      request(ROUTES.marketInstall, 'POST', { slug: 'anything', targetRoot: '/etc' }),
      res,
    )
    expect(status()).toBe(400)
    expect(String((json() as { error: string }).error)).toContain('targetRoot must be one of')
  })

  it('rejects a target root that only looks like a skill root by prefix', async () => {
    const route = routes.find(candidate => candidate.path === ROUTES.marketInstall)!
    const { res, status } = makeResponse()
    await route.handler(
      request(ROUTES.marketInstall, 'POST', {
        slug: 'anything',
        targetRoot: join(AGENTS, 'skills-evil'),
      }),
      res,
    )
    expect(status()).toBe(400)
  })

  it('accepts the user skill root and the project skill root', async () => {
    const route = routes.find(candidate => candidate.path === ROUTES.marketInstall)!
    // Only the validation is under test: reaching the download proves the root
    // passed, and the network failure is what stops it here.
    for (const targetRoot of [join(AGENTS, 'skills'), join(PROJ, '.dsh', 'skills')]) {
      const { res, status, json } = makeResponse()
      await route.handler(request(ROUTES.marketInstall, 'POST', { slug: 'anything', targetRoot }), res)
      expect(status()).toBe(500)
      expect(String((json() as { error: string }).error)).not.toContain('targetRoot must be one of')
    }
  })
})

describe('market installed identity', () => {
  it('counts the install directory slug as an installed identity', () => {
    const identities = marketIdentities([{ name: 'document-ninja', path: '/home/u/.agents/skills/pdf-master/SKILL.md' }])
    expect(identities.has('pdf-master')).toBe(true)
    expect(identities.has('document-ninja')).toBe(true)
  })

  it('counts a single-file skill by its file stem', () => {
    const identities = marketIdentities([{ name: 'Document Ninja', path: '/home/u/.agents/skills/pdf-master.md' }])
    expect(identities.has('pdf-master')).toBe(true)
    expect(identities.has('document ninja')).toBe(true)
  })

  it('does not invent a "skill" identity for a bare SKILL.md at a root', () => {
    const identities = marketIdentities([{ name: 'solo', path: '/home/u/.agents/skills/SKILL.md' }])
    expect(identities.has('skill')).toBe(false)
    expect(identities.has('solo')).toBe(true)
  })

  it('ignores a skill with no path', () => {
    expect([...marketIdentities([{ name: 'virtual' }])]).toEqual(['virtual'])
  })
})

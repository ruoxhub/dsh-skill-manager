import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CentralSkillStore } from '../src/central-store.ts'
import { PresetStore } from '../src/presets.ts'
import { makeRoutes, ROUTES } from '../src/routes.ts'

const TMP = mkdtempSync(join(tmpdir(), 'skill-preset-routes-'))
const DSH = join(TMP, 'dsh')
const AGENTS = join(TMP, 'agents')
const PROJ = join(TMP, 'proj')
const LIBRARY = join(TMP, 'library')

mkdirSync(join(PROJ, '.git'), { recursive: true })
for (const name of ['alpha', 'beta']) {
  const dir = join(LIBRARY, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`)
}

const central = new CentralSkillStore(join(TMP, 'skills-manager.db'), true)
for (const name of ['alpha', 'beta']) {
  central.upsertSkill({
    name,
    sourceType: 'local',
    sourceRef: LIBRARY,
    centralPath: join(LIBRARY, name),
  })
}

const presets = new PresetStore(':memory:')
const routes = makeRoutes({} as never, {
  dshHome: DSH,
  agentsHome: AGENTS,
  customSkillDirs: [],
  registry: { snapshot: async () => ({ skills: [], complete: true }) },
  activeSessionCwds: () => [PROJ],
  logger: { warn: () => {} },
  centralStore: central,
  presetStore: presets,
})

const find = (path: string) => routes.find((route) => route.path === path)!

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

function makeResponse(): { res: ServerResponse; status: () => number; json: () => any } {
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

afterAll(() => {
  central.close()
  presets.close()
  rmSync(TMP, { recursive: true, force: true })
})

describe('preset routes', () => {
  let presetId = ''

  it('saves a preset and lists it back', async () => {
    const save = makeResponse()
    await find(ROUTES.presetSave).handler(
      request(ROUTES.presetSave, 'POST', { name: '写作', skillNames: ['alpha', 'beta'] }),
      save.res,
    )
    expect(save.status()).toBe(200)
    presetId = save.json().preset.id
    expect(save.json().preset.skillNames).toEqual(['alpha', 'beta'])

    const list = makeResponse()
    await find(ROUTES.presetList).handler(request(ROUTES.presetList), list.res)
    expect(list.status()).toBe(200)
    expect(list.json().presets).toHaveLength(1)
    expect(list.json().roots).toEqual(['user-dsh', 'user-agents', 'project-dsh', 'project-agents'])
  })

  it('rejects a duplicate name with 409 rather than silently renaming', async () => {
    const second = makeResponse()
    await find(ROUTES.presetSave).handler(
      request(ROUTES.presetSave, 'POST', { name: '写作', skillNames: [] }),
      second.res,
    )
    expect(second.status()).toBe(409)
  })

  it('activates a preset by deploying its members into the chosen root', async () => {
    const apply = makeResponse()
    await find(ROUTES.presetApply).handler(
      request(ROUTES.presetApply, 'POST', { id: presetId, roots: ['user-agents'], cwd: PROJ }),
      apply.res,
    )
    expect(apply.status()).toBe(200)
    const body = apply.json()
    expect(body.deployed.filter((entry: { deployed: boolean }) => entry.deployed)).toHaveLength(2)
    expect(existsSync(join(AGENTS, 'skills', 'alpha', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(AGENTS, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('name: alpha')
    expect(presets.activePresetId()).toBe(presetId)
  })

  it('shrinking the preset takes the dropped member back out', async () => {
    await find(ROUTES.presetSave).handler(
      request(ROUTES.presetSave, 'POST', { id: presetId, name: '写作', skillNames: ['alpha'] }),
      makeResponse().res,
    )
    const apply = makeResponse()
    await find(ROUTES.presetApply).handler(
      request(ROUTES.presetApply, 'POST', { id: presetId, roots: ['user-agents'], cwd: PROJ }),
      apply.res,
    )
    expect(apply.json().removed.map((entry: { skillName: string }) => entry.skillName)).toContain('beta')
    expect(existsSync(join(AGENTS, 'skills', 'beta'))).toBe(false)
    expect(existsSync(join(AGENTS, 'skills', 'alpha'))).toBe(true)
  })

  it('rejects a root that is not a harness root', async () => {
    const apply = makeResponse()
    await find(ROUTES.presetApply).handler(
      request(ROUTES.presetApply, 'POST', { id: presetId, roots: ['/etc'] }),
      apply.res,
    )
    expect(apply.status()).toBe(400)
    expect(String(apply.json().error)).toContain('roots must be a subset of')
  })

  it('answers 404 for an unknown preset', async () => {
    const apply = makeResponse()
    await find(ROUTES.presetApply).handler(
      request(ROUTES.presetApply, 'POST', { id: 'nope' }),
      apply.res,
    )
    expect(apply.status()).toBe(404)
  })

  it('rejects a non-POST activation', async () => {
    const apply = makeResponse()
    await find(ROUTES.presetApply).handler(request(ROUTES.presetApply, 'GET'), apply.res)
    expect(apply.status()).toBe(405)
  })

  it('deletes a preset and clears the active marker', async () => {
    const remove = makeResponse()
    await find(ROUTES.presetDelete).handler(
      request(ROUTES.presetDelete, 'POST', { id: presetId }),
      remove.res,
    )
    expect(remove.status()).toBe(200)
    expect(presets.listPresets()).toEqual([])
    expect(presets.activePresetId()).toBeNull()
  })
})

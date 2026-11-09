import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeRoutes, ROUTES } from '../src/routes.ts'

const TMP = mkdtempSync(join(tmpdir(), 'skill-backup-routes-'))
const LIBRARY = join(TMP, 'library')
mkdirSync(join(LIBRARY, 'alpha'), { recursive: true })
writeFileSync(join(LIBRARY, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: a\n---\n')

const routes = makeRoutes({} as never, {
  dshHome: join(TMP, 'dsh'),
  agentsHome: join(TMP, 'agents'),
  customSkillDirs: [],
  registry: { snapshot: async () => ({ skills: [], complete: true }) },
  activeSessionCwds: () => [],
  logger: { warn: () => {} },
  centralSkillsDir: LIBRARY,
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
  rmSync(TMP, { recursive: true, force: true })
})

describe('backup routes', () => {
  it('reports no_repo before a repository exists', async () => {
    const status = makeResponse()
    await find(ROUTES.backupStatus).handler(request(ROUTES.backupStatus), status.res)
    expect(status.status()).toBe(200)
    expect(status.json().health).toBe('no_repo')
  })

  it('initializes the library repository', async () => {
    const init = makeResponse()
    await find(ROUTES.backupInit).handler(request(ROUTES.backupInit, 'POST'), init.res)
    expect(init.status()).toBe(200)
    expect(init.json().isRepo).toBe(true)
    expect(existsSync(join(LIBRARY, '.git'))).toBe(true)
  })

  it('commits a snapshot and lists it back', async () => {
    const commit = makeResponse()
    await find(ROUTES.backupCommit).handler(
      request(ROUTES.backupCommit, 'POST', { message: 'manual backup', snapshot: true }),
      commit.res,
    )
    expect(commit.status()).toBe(200)
    expect(commit.json().committed).toBe(true)
    expect(commit.json().tag).toMatch(/^dsh-skills-/u)

    const snapshots = makeResponse()
    await find(ROUTES.backupSnapshots).handler(request(ROUTES.backupSnapshots), snapshots.res)
    expect(snapshots.status()).toBe(200)
    expect(snapshots.json().snapshots).toHaveLength(1)
  })

  it('restores a snapshot and reports the safety commit', async () => {
    const commit = makeResponse()
    await find(ROUTES.backupCommit).handler(
      request(ROUTES.backupCommit, 'POST', { message: 'baseline', snapshot: true }),
      commit.res,
    )
    const tag = commit.json().tag as string

    writeFileSync(join(LIBRARY, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: edited\n---\n')
    mkdirSync(join(LIBRARY, 'beta'), { recursive: true })
    writeFileSync(join(LIBRARY, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: b\n---\n')
    await find(ROUTES.backupCommit).handler(
      request(ROUTES.backupCommit, 'POST', { message: 'edit', snapshot: false }),
      makeResponse().res,
    )

    const restore = makeResponse()
    await find(ROUTES.backupRestore).handler(
      request(ROUTES.backupRestore, 'POST', { tag }),
      restore.res,
    )
    expect(restore.status()).toBe(200)
    expect(restore.json().safetyCommit).toMatch(/^[0-9a-f]{40}$/u)
    expect(readFileSync(join(LIBRARY, 'alpha', 'SKILL.md'), 'utf8')).toContain('description: a')
    expect(existsSync(join(LIBRARY, 'beta'))).toBe(false)
  })

  it('rejects a restore without a tag', async () => {
    const restore = makeResponse()
    await find(ROUTES.backupRestore).handler(request(ROUTES.backupRestore, 'POST', {}), restore.res)
    expect(restore.status()).toBe(400)
  })

  it('rejects a remote URL that instructs git to run a command', async () => {
    const remote = makeResponse()
    await find(ROUTES.backupRemote).handler(
      request(ROUTES.backupRemote, 'POST', { url: 'ext::sh -c touch% /tmp/pwn' }),
      remote.res,
    )
    expect(remote.status()).toBe(400)
    expect(String(remote.json().error)).toContain('command transport')
  })

  it('rejects a non-POST commit', async () => {
    const commit = makeResponse()
    await find(ROUTES.backupCommit).handler(request(ROUTES.backupCommit, 'GET'), commit.res)
    expect(commit.status()).toBe(405)
  })
})

import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gitInstaller from '../src/git-installer.ts'
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

describe('git install routes', () => {
  let routes: ReturnType<typeof makeRoutes>
  const find = (path: string) => routes.find((r) => r.path === path)

  beforeEach(() => {
    routes = makeRoutes({} as never, {
      dshHome: 'C:/Users/test/.dsh',
      agentsHome: 'C:/Users/test/.agents',
      customSkillDirs: [],
      registry: { snapshot: async () => ({ skills: [], complete: true }) },
      activeSessionCwds: () => [],
      logger: { warn: () => {} },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('handles git preview route with success', async () => {
    vi.spyOn(gitInstaller, 'previewGitInstall').mockResolvedValue({
      tempDir: 'C:/temp/dsh-git-skill-123',
      skills: [{ relPath: 'skill-alpha', name: 'skill-alpha', description: 'Alpha description' }],
    })

    const route = find(ROUTES.gitPreview)!
    const { res, status, json } = response()
    await route.handler(
      request(ROUTES.gitPreview, 'POST', { body: { repoUrl: 'https://github.com/example/repo' } }),
      res,
    )

    expect(status()).toBe(200)
    expect(json()).toEqual({
      ok: true,
      tempDir: 'C:/temp/dsh-git-skill-123',
      skills: [{ relPath: 'skill-alpha', name: 'skill-alpha', description: 'Alpha description' }],
    })
  })

  it('rejects git preview route when repoUrl is missing', async () => {
    const route = find(ROUTES.gitPreview)!
    const { res, status, json } = response()
    await route.handler(request(ROUTES.gitPreview, 'POST', { body: {} }), res)

    expect(status()).toBe(400)
    expect((json() as { error: string }).error).toContain('repoUrl is required')
  })

  it('handles git confirm install route with success', async () => {
    vi.spyOn(gitInstaller, 'confirmGitInstall').mockResolvedValue({
      ok: true,
      installed: [
        {
          name: 'skill-alpha',
          installedPath: 'C:/Users/test/.agents/skills/skill-alpha',
          centralPath: 'C:/Users/test/.skills-manager/skills/skill-alpha',
        },
      ],
    })

    const route = find(ROUTES.gitConfirm)!
    const { res, status, json } = response()
    await route.handler(
      request(ROUTES.gitConfirm, 'POST', {
        body: {
          repoUrl: 'https://github.com/example/repo',
          tempDir: 'C:/temp/dsh-git-skill-123',
          items: [{ relPath: 'skill-alpha', name: 'skill-alpha' }],
          target: 'user',
        },
      }),
      res,
    )

    expect(status()).toBe(200)
    expect(json()).toEqual({
      ok: true,
      installed: [
        {
          name: 'skill-alpha',
          installedPath: 'C:/Users/test/.agents/skills/skill-alpha',
          centralPath: 'C:/Users/test/.skills-manager/skills/skill-alpha',
        },
      ],
    })
  })

  it('rejects git confirm route when items array is empty', async () => {
    const route = find(ROUTES.gitConfirm)!
    const { res, status, json } = response()
    await route.handler(
      request(ROUTES.gitConfirm, 'POST', {
        body: {
          repoUrl: 'https://github.com/example/repo',
          tempDir: 'C:/temp/dsh-git-skill-123',
          items: [],
        },
      }),
      res,
    )

    expect(status()).toBe(400)
    expect((json() as { error: string }).error).toContain('items must be a non-empty array')
  })

  it('maps a rejected preview sandbox to 400 instead of 500', async () => {
    vi.spyOn(gitInstaller, 'confirmGitInstall').mockRejectedValue(
      new gitInstaller.GitInstallInputError('Invalid or expired temporary clone directory'),
    )

    const route = find(ROUTES.gitConfirm)!
    const { res, status, json } = response()
    await route.handler(
      request(ROUTES.gitConfirm, 'POST', {
        body: {
          repoUrl: 'https://github.com/example/repo',
          tempDir: 'C:/Windows/System32',
          items: [{ relPath: 'skill-alpha', name: 'skill-alpha' }],
        },
      }),
      res,
    )

    expect(status()).toBe(400)
    expect((json() as { error: string }).error).toContain('Invalid or expired temporary clone directory')
  })

  it('still maps an unexpected install failure to 500', async () => {
    vi.spyOn(gitInstaller, 'confirmGitInstall').mockRejectedValue(new Error('disk exploded'))

    const route = find(ROUTES.gitConfirm)!
    const { res, status } = response()
    await route.handler(
      request(ROUTES.gitConfirm, 'POST', {
        body: {
          repoUrl: 'https://github.com/example/repo',
          tempDir: 'C:/temp/dsh-git-skill-123',
          items: [{ relPath: 'skill-alpha', name: 'skill-alpha' }],
        },
      }),
      res,
    )

    expect(status()).toBe(500)
  })

  it('handles git cancel route', async () => {
    const cancelSpy = vi.spyOn(gitInstaller, 'cancelGitPreview').mockResolvedValue()

    const route = find(ROUTES.gitCancel)!
    const { res, status, json } = response()
    await route.handler(
      request(ROUTES.gitCancel, 'POST', {
        body: {
          tempDir: 'C:/temp/dsh-git-skill-123',
        },
      }),
      res,
    )

    expect(status()).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(cancelSpy).toHaveBeenCalledWith('C:/temp/dsh-git-skill-123')
  })
})

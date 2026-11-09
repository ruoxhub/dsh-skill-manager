/**
 * Contract tests: client route literals mirror the host ROUTES, and the host
 * entry exposes the cordis contract (name / inject) — the drift guard the
 * original local plugin smoke asserted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROUTES, name, inject } from '../src/index.ts'

describe('host plugin contract', () => {
  it('exposes the stable cordis name and inject list', () => {
    expect(name).toBe('skill-explorer')
    expect(inject).toEqual(['webServer', 'skills', 'sessions'])
  })

  it('client bundle api/ literals are a subset of host ROUTES (no drift)', () => {
    const clientSrc = readFileSync(join(process.cwd(), 'src/client/api.ts'), 'utf8')
    // The client writes DOCUMENT-RELATIVE routes (no leading slash) so a
    // sub-path deployment resolves them against the served `<base href>`
    // (issue #1707); the host registers them root-absolute. Normalizing here
    // keeps this drift guard exact about the path, not its spelling.
    const clientPaths = [...clientSrc.matchAll(/'(api\/dsh-skill-explorer\/[^']+)'/g)]
      .map((m) => '/' + m[1])
      .sort()
    const hostPaths = [...new Set(Object.values(ROUTES))].sort()
    // The client mirrors the business routes; health is host-only.
    expect(clientPaths).toEqual([
      '/api/dsh-skill-explorer/audit',
      '/api/dsh-skill-explorer/backup/commit',
      '/api/dsh-skill-explorer/backup/init',
      '/api/dsh-skill-explorer/backup/remote',
      '/api/dsh-skill-explorer/backup/restore',
      '/api/dsh-skill-explorer/backup/snapshots',
      '/api/dsh-skill-explorer/backup/status',
      '/api/dsh-skill-explorer/check-all',
      '/api/dsh-skill-explorer/check-one',
      '/api/dsh-skill-explorer/create',
      '/api/dsh-skill-explorer/delete',
      '/api/dsh-skill-explorer/git/cancel',
      '/api/dsh-skill-explorer/git/confirm',
      '/api/dsh-skill-explorer/git/preview',
      '/api/dsh-skill-explorer/import',
      '/api/dsh-skill-explorer/list',
      '/api/dsh-skill-explorer/market/detail',
      '/api/dsh-skill-explorer/market/install',
      '/api/dsh-skill-explorer/market/search',
      '/api/dsh-skill-explorer/presets',
      '/api/dsh-skill-explorer/presets/apply',
      '/api/dsh-skill-explorer/presets/delete',
      '/api/dsh-skill-explorer/presets/save',
      '/api/dsh-skill-explorer/read',
      '/api/dsh-skill-explorer/set-enabled',
      '/api/dsh-skill-explorer/set-provider-enabled',
      '/api/dsh-skill-explorer/tags',
      '/api/dsh-skill-explorer/tags/delete',
      '/api/dsh-skill-explorer/tags/rename',
      '/api/dsh-skill-explorer/tags/set',
      '/api/dsh-skill-explorer/trash',
      '/api/dsh-skill-explorer/trash/restore',
      '/api/dsh-skill-explorer/update',
      '/api/dsh-skill-explorer/update-all',
      '/api/dsh-skill-explorer/update-one',
    ])
    for (const path of clientPaths) expect(hostPaths).toContain(path)
    expect(hostPaths).toContain('/api/dsh-skill-explorer/health')
    // And the client never reintroduces a root-absolute route.
    expect(clientSrc).not.toMatch(/'\/api\//)
  })
})

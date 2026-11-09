/**
 * Repository cache: one checkout per repository, reused across operations.
 *
 * Every case drives real `git` against local repositories built in the test's
 * own temp tree, so the assertions are about observable effects (a second
 * materialization succeeds after the origin is gone, a broken slot recovers)
 * rather than about which git subcommand was invoked.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRepoCacheRoot, materializeRepoCheckout, repoCacheSlot } from '../src/repo-cache.ts'

const TMP = mkdtempSync(join(tmpdir(), 'skill-explorer-repo-cache-'))

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: join(TMP, 'gitconfig'),
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })
}

/** Build a repository whose only content is a skill file, and return its path. */
function makeRepo(name: string, body: string): string {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '--initial-branch=main'])
  writeFileSync(join(dir, 'SKILL.md'), body)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'init'])
  return dir
}

function commitTo(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', `add ${name}`])
}

describe('repository cache', () => {
  const savedRoot = process.env.SKILLS_MANAGER_ROOT

  beforeEach(() => {
    // Keep the cache inside this test's own tree: the real one lives under the
    // user's home and must not be read or evicted by a test run.
    process.env.SKILLS_MANAGER_ROOT = join(TMP, 'central')
  })

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.SKILLS_MANAGER_ROOT
    else process.env.SKILLS_MANAGER_ROOT = savedRoot
  })

  it('places slots under the central root and keys them by normalized identity', () => {
    // Given two spellings of the same repository
    const dotted = repoCacheSlot('https://github.com/owner/repo.git')
    const plain = repoCacheSlot('https://github.com/owner/repo')

    // Then they share one slot, and it lives under the cache root
    expect(dotted).toBe(plain)
    expect(dotted.startsWith(getRepoCacheRoot())).toBe(true)
    // A different repository gets a different slot
    expect(repoCacheSlot('https://github.com/owner/other')).not.toBe(dotted)
  })

  it('reuses the slot through an incremental fetch instead of re-cloning', async () => {
    // Given a repository materialized once
    const repo = makeRepo('reuse', '---\nname: alpha\n---\n')
    const first = join(TMP, 'reuse-first')
    await materializeRepoCheckout({ url: repo, destination: first })
    expect(readFileSync(join(first, 'SKILL.md'), 'utf8')).toContain('alpha')

    // When a second checkout is requested from the same repository
    const slot = repoCacheSlot(repo)
    expect(existsSync(join(slot, '.git'))).toBe(true)
    const second = join(TMP, 'reuse-second')
    await materializeRepoCheckout({ url: repo, destination: second })

    // Then it was served from the slot: a fetch ran there, which only happens
    // on the reuse path, so the whole repository was not downloaded again
    expect(existsSync(join(slot, '.git', 'FETCH_HEAD'))).toBe(true)
    expect(readFileSync(join(second, 'SKILL.md'), 'utf8')).toContain('alpha')
  })

  it('reports an unreachable origin instead of serving the stale cached tree', async () => {
    // Given a materialized repository whose origin then disappears
    const repo = makeRepo('gone', '---\nname: alpha\n---\n')
    await materializeRepoCheckout({ url: repo, destination: join(TMP, 'gone-first') })
    rmSync(repo, { recursive: true, force: true })

    // Then the next checkout fails rather than silently handing back what the
    // cache happened to hold: an update reporting success on a stale tree is
    // worse than an update that says it could not reach the remote
    await expect(
      materializeRepoCheckout({ url: repo, destination: join(TMP, 'gone-second') }),
    ).rejects.toThrow()
  })

  it('leaves the shared slot usable after a caller deletes its checkout', async () => {
    // Given one materialized checkout that its owner discards, as every route does
    const repo = makeRepo('discard', '---\nname: alpha\n---\n')
    const first = join(TMP, 'discard-first')
    await materializeRepoCheckout({ url: repo, destination: first })
    rmSync(first, { recursive: true, force: true })

    // Then the slot survives and still serves a checkout
    const second = join(TMP, 'discard-second')
    await materializeRepoCheckout({ url: repo, destination: second })
    expect(existsSync(join(second, 'SKILL.md'))).toBe(true)
  })

  it('picks up new upstream commits through the cached slot', async () => {
    // Given a repository materialized once
    const repo = makeRepo('refresh', '---\nname: alpha\n---\n')
    await materializeRepoCheckout({ url: repo, destination: join(TMP, 'refresh-first') })

    // When upstream gains a commit
    commitTo(repo, 'EXTRA.md', 'new content')
    const second = join(TMP, 'refresh-second')
    await materializeRepoCheckout({ url: repo, destination: second })

    // Then the refreshed checkout carries it
    expect(existsSync(join(second, 'EXTRA.md'))).toBe(true)
  })

  it('rebuilds a corrupt slot instead of failing the operation', async () => {
    // Given a slot whose git directory is unusable
    const repo = makeRepo('corrupt', '---\nname: alpha\n---\n')
    const slot = repoCacheSlot(repo)
    mkdirSync(slot, { recursive: true })
    writeFileSync(join(slot, '.git'), 'not a directory')

    // When a checkout is requested
    const destination = join(TMP, 'corrupt-checkout')
    await materializeRepoCheckout({ url: repo, destination })

    // Then it recovers by re-cloning rather than reporting the corrupt slot
    expect(readFileSync(join(destination, 'SKILL.md'), 'utf8')).toContain('alpha')
  })

  it('rejects a destination that is already populated, like git clone', async () => {
    // Given a non-empty destination
    const repo = makeRepo('occupied', '---\nname: alpha\n---\n')
    const destination = join(TMP, 'occupied-checkout')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'preexisting.txt'), 'keep me')

    // Then the call fails instead of silently mixing two trees
    await expect(materializeRepoCheckout({ url: repo, destination })).rejects.toThrow()
    expect(readFileSync(join(destination, 'preexisting.txt'), 'utf8')).toBe('keep me')
  })
})

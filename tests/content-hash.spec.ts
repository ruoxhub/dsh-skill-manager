import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discardPrevious, stagedPathFor, swapSkillDir } from '../src/atomic.ts'
import { hashSkillDir, removedPaths, summarizeRemovals } from '../src/content-hash.ts'

describe('content hash', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-hash-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeSkill(dir: string, files: Record<string, string>): string {
    const target = join(root, dir)
    mkdirSync(target, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      const path = join(target, name)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content)
    }
    return target
  }

  it('changes when a file content changes', () => {
    const dir = writeSkill('a', { 'SKILL.md': 'v1' })
    const before = hashSkillDir(dir)
    writeFileSync(join(dir, 'SKILL.md'), 'v2')
    expect(hashSkillDir(dir)).not.toBe(before)
  })

  it('changes when a file is added or renamed', () => {
    const dir = writeSkill('b', { 'SKILL.md': 'x' })
    const before = hashSkillDir(dir)
    writeFileSync(join(dir, 'extra.md'), 'y')
    const withExtra = hashSkillDir(dir)
    expect(withExtra).not.toBe(before)
    // Renaming the same bytes is still a change: the path is part of identity.
    writeFileSync(join(dir, 'renamed.md'), 'y')
    rmSync(join(dir, 'extra.md'))
    expect(hashSkillDir(dir)).not.toBe(withExtra)
  })

  it('ignores VCS bookkeeping, OS cruft and regenerable python artifacts', () => {
    const dir = writeSkill('c', { 'SKILL.md': 'x' })
    const before = hashSkillDir(dir)
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(dir, '.DS_Store'), 'junk')
    writeFileSync(join(dir, '.gitignore'), 'node_modules')
    writeFileSync(join(dir, 'cached.pyc'), 'bytecode')
    mkdirSync(join(dir, '__pycache__'))
    writeFileSync(join(dir, '__pycache__', 'x'), 'bytecode')
    expect(hashSkillDir(dir)).toBe(before)
  })

  it('returns null for a path that is not a readable directory', () => {
    expect(hashSkillDir(join(root, 'missing'))).toBeNull()
    writeFileSync(join(root, 'file.txt'), 'x')
    expect(hashSkillDir(join(root, 'file.txt'))).toBeNull()
  })

  it('hashes a symlink by its target text, not the content it points at', () => {
    const target = writeSkill('d', { 'SKILL.md': 'x' })
    const other = writeSkill('e', { 'SKILL.md': 'different' })
    symlinkSync(other, join(target, 'link'))
    const withLink = hashSkillDir(target)
    // Pointing the same link somewhere else changes the skill.
    rmSync(join(target, 'link'))
    symlinkSync(target, join(target, 'link'))
    expect(hashSkillDir(target)).not.toBe(withLink)
  })

  it('reports the files a replacement would remove, ignoring regenerable ones', () => {
    const current = writeSkill('f', {
      'SKILL.md': 'x',
      'templates/slides.pptx': 'user work',
      'templates/notes.md': 'user work',
      'cached.pyc': 'bytecode',
    })
    const replacement = writeSkill('g', { 'SKILL.md': 'x' })

    // `.pyc` is not part of what a skill owns, so it is neither hashed nor
    // reported as something the user would miss.
    expect(removedPaths(current, replacement).sort()).toEqual(['templates/notes.md', 'templates/slides.pptx'])
    // A whole vanished directory is one entry, not one per child.
    expect(summarizeRemovals(removedPaths(current, replacement), replacement)).toEqual(['templates'])
  })

  it('reports nothing when the replacement ships everything the current tree has', () => {
    const current = writeSkill('h', { 'SKILL.md': 'x', 'a.md': '1' })
    const replacement = writeSkill('i', { 'SKILL.md': 'y', 'a.md': '2', 'b.md': '3' })
    expect(summarizeRemovals(removedPaths(current, replacement), replacement)).toEqual([])
  })
})

describe('atomic directory swap', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-swap-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('replaces the target with the staged tree and keeps the old one aside', () => {
    const target = join(root, 'skill')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), 'old')
    const staged = stagedPathFor(target)
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'SKILL.md'), 'new')

    const previous = swapSkillDir(staged, target)
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new')
    expect(previous).not.toBeNull()
    expect(readFileSync(join(previous!, 'SKILL.md'), 'utf8')).toBe('old')

    discardPrevious(previous)
    expect(existsSync(previous!)).toBe(false)
  })

  it('creates the target when it is absent and reports nothing to discard', () => {
    const target = join(root, 'nested', 'skill')
    const staged = stagedPathFor(target)
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, 'SKILL.md'), 'new')

    expect(swapSkillDir(staged, target)).toBeNull()
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new')
  })

  it('leaves the old tree in place when the swap fails', () => {
    const target = join(root, 'skill')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), 'keep me')

    // A staged path that does not exist makes the second rename throw.
    expect(() => swapSkillDir(join(root, 'gone'), target)).toThrow()
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('keep me')
    // No `.old-*` leftover is left behind once the rollback ran.
    const leftovers = readdirSync(root).filter((name) => name.includes('.old-'))
    expect(leftovers).toEqual([])
  })

  it('stages beside the target so the final rename stays on one filesystem', () => {
    const target = join(root, 'skills', 'demo')
    expect(stagedPathFor(target).startsWith(join(root, 'skills'))).toBe(true)
    expect(stagedPathFor(target).includes('demo.staged-')).toBe(true)
  })
})

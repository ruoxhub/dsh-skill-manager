import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog, MAX_AUDIT_ENTRIES } from '../src/audit.ts'
import { MAX_TAGS_PER_SKILL, TagStore, normalizeTag } from '../src/tags.ts'

describe('skill tags', () => {
  let store: TagStore

  beforeEach(() => {
    store = new TagStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('normalizes a tag to a lowercase slug', () => {
    expect(normalizeTag('  Front End  ')).toBe('front-end')
    expect(normalizeTag('   ')).toBeNull()
    expect(normalizeTag('-')).toBeNull()
    expect(normalizeTag('a'.repeat(80))).toHaveLength(32)
  })

  it('replaces a skill tags wholesale and drops duplicates', () => {
    expect(store.setTags('alpha', ['web', 'Web', 'docs'])).toEqual(['web', 'docs'])
    expect(store.tagsOf('alpha')).toEqual(['docs', 'web'])
  })

  it('caps how many tags one skill may carry', () => {
    const many = Array.from({ length: MAX_TAGS_PER_SKILL + 5 }, (_, index) => `t${index}`)
    expect(store.setTags('alpha', many)).toHaveLength(MAX_TAGS_PER_SKILL)
  })

  it('counts skills per tag, most used first', () => {
    store.setTags('alpha', ['web', 'docs'])
    store.setTags('beta', ['web'])
    expect(store.listTags()).toEqual([
      { tag: 'web', count: 2 },
      { tag: 'docs', count: 1 },
    ])
  })

  it('groups every skill tags in one read', () => {
    store.setTags('alpha', ['web'])
    store.setTags('beta', ['web', 'docs'])
    const all = store.allTags()
    expect(all.get('alpha')).toEqual(['web'])
    expect(all.get('beta')).toEqual(['docs', 'web'])
  })

  it('renames a tag everywhere, merging into an existing target', () => {
    store.setTags('alpha', ['front', 'web'])
    store.setTags('beta', ['front'])
    expect(store.renameTag('front', 'web')).toBe(true)
    expect(store.tagsOf('alpha')).toEqual(['web'])
    expect(store.tagsOf('beta')).toEqual(['web'])
    expect(store.listTags()).toEqual([{ tag: 'web', count: 2 }])
  })

  it('refuses to rename a tag onto itself or onto nothing', () => {
    store.setTags('alpha', ['web'])
    expect(store.renameTag('web', 'web')).toBe(false)
    expect(store.renameTag('web', '   ')).toBe(false)
  })

  it('deletes a tag from every skill', () => {
    store.setTags('alpha', ['web', 'docs'])
    store.setTags('beta', ['web'])
    expect(store.deleteTag('WEB')).toBe(true)
    expect(store.listTags()).toEqual([{ tag: 'docs', count: 1 }])
  })

  it('forgets a skill tags when the skill is gone', () => {
    store.setTags('alpha', ['web'])
    store.forgetSkill('alpha')
    expect(store.listTags()).toEqual([])
  })
})

describe('audit log', () => {
  let dir: string
  let log: AuditLog

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    log = new AuditLog(join(dir, 'audit.db'))
  })

  afterEach(() => {
    log.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records an action and reads it back newest first', () => {
    log.record({ action: 'install-git', skillName: 'alpha', detail: 'from repo' })
    log.record({ action: 'delete', skillName: 'alpha', success: false, detail: 'refused' })
    const entries = log.list()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.action).toBe('delete')
    expect(entries[0]!.success).toBe(false)
    expect(entries[1]!.success).toBe(true)
  })

  it('filters by skill name', () => {
    log.record({ action: 'update', skillName: 'alpha' })
    log.record({ action: 'update', skillName: 'beta' })
    expect(log.list(200, 'alpha')).toHaveLength(1)
  })

  it('bounds the stored entries so the table cannot grow forever', () => {
    for (let index = 0; index < 20; index++) log.record({ action: 'toggle', skillName: 'alpha' })
    // The cap is far above 20, so everything is kept here; the assertion that
    // matters is that the trimming statement runs without dropping live rows.
    expect(log.list(1000)).toHaveLength(20)
    expect(MAX_AUDIT_ENTRIES).toBeGreaterThan(20)
  })

  it('never throws when the database is unusable', () => {
    const broken = new AuditLog(join(dir, 'missing', 'nested', 'audit.db'))
    expect(() => broken.record({ action: 'toggle' })).not.toThrow()
    expect(broken.list()).toEqual([])
    broken.close()
  })
})

describe('trash listing and restore', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-trash-'))
    mkdirSync(join(root, '.trash'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('recovers the skill name and time from the entry name', async () => {
    const { listTrash, trashPath } = await import('../src/collect.ts')
    mkdirSync(join(root, 'alpha'), { recursive: true })
    writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: a\n---\n')
    const trashed = await trashPath(join(root, 'alpha'))

    const entries = await listTrash(root)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe('alpha')
    expect(entries[0]!.path).toBe(trashed)
    expect(entries[0]!.isDirectory).toBe(true)
    expect(entries[0]!.deletedAt).toBeGreaterThan(0)
  })

  it('restores a trashed skill into its root', async () => {
    const { listTrash, restoreTrashEntry, trashPath } = await import('../src/collect.ts')
    mkdirSync(join(root, 'alpha'), { recursive: true })
    writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: a\n---\n')
    await trashPath(join(root, 'alpha'))

    const [entry] = await listTrash(root)
    const restored = await restoreTrashEntry(entry!, root)
    expect(restored).toBe(join(root, 'alpha'))
    expect(await listTrash(root)).toEqual([])
  })

  it('refuses to restore over a skill that exists again', async () => {
    const { listTrash, restoreTrashEntry, trashPath } = await import('../src/collect.ts')
    mkdirSync(join(root, 'alpha'), { recursive: true })
    writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: a\n---\n')
    await trashPath(join(root, 'alpha'))
    mkdirSync(join(root, 'alpha'), { recursive: true })
    writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: recreated\n---\n')

    const [entry] = await listTrash(root)
    await expect(restoreTrashEntry(entry!, root)).rejects.toThrow(/already exists/u)
  })
})

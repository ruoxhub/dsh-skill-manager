import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PresetStore, applyPreset, deploySkill, rootDir, undeploySkill, type RootKey } from '../src/presets.ts'

describe('preset store', () => {
  let store: PresetStore

  beforeEach(() => {
    store = new PresetStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('creates a preset with members in order', () => {
    const preset = store.createPreset('写作', ['b', 'a'])!
    expect(preset.name).toBe('写作')
    expect(preset.skillNames).toEqual(['b', 'a'])
    expect(store.listPresets()).toHaveLength(1)
  })

  it('de-duplicates members and ignores empty names', () => {
    const preset = store.createPreset('x', ['a', 'a', '', 'b'])!
    expect(preset.skillNames).toEqual(['a', 'b'])
  })

  it('refuses a blank name and a duplicate name', () => {
    expect(store.createPreset('   ')).toBeUndefined()
    store.createPreset('taken')
    expect(store.createPreset('taken')).toBeUndefined()
  })

  it('replaces members wholesale', () => {
    const preset = store.createPreset('p', ['a', 'b'])!
    store.setMembers(preset.id, ['c'])
    expect(store.getPreset(preset.id)!.skillNames).toEqual(['c'])
  })

  it('tracks the active preset and clears it on delete', () => {
    const preset = store.createPreset('p')!
    store.setActivePreset(preset.id)
    expect(store.activePresetId()).toBe(preset.id)
    store.deletePreset(preset.id)
    expect(store.activePresetId()).toBeNull()
    expect(store.listPresets()).toEqual([])
  })

  it('records a deployment once per (skill, root)', () => {
    store.recordDeployment({
      preset_id: null,
      skill_name: 'a',
      root_key: 'user-agents',
      target_path: '/tmp/a',
      mode: 'symlink',
      source_path: '/lib/a',
      source_hash: 'h1',
    })
    store.recordDeployment({
      preset_id: null,
      skill_name: 'a',
      root_key: 'user-agents',
      target_path: '/tmp/a',
      mode: 'copy',
      source_path: '/lib/a',
      source_hash: 'h2',
    })
    const records = store.deploymentsFor('a')
    expect(records).toHaveLength(1)
    expect(records[0]!.mode).toBe('copy')
    expect(records[0]!.source_hash).toBe('h2')
  })
})

describe('deploy and undeploy', () => {
  let tmp: string
  let library: string
  let root: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dsh-deploy-'))
    library = join(tmp, 'library', 'demo')
    root = join(tmp, 'agents', 'skills')
    mkdirSync(library, { recursive: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(join(library, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('links by default, and the link reads the library content', () => {
    const target = join(root, 'demo')
    const outcome = deploySkill('demo', library, target, 'user-agents', 'symlink', undefined)
    expect(outcome.deployed).toBe(true)
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('name: demo')
  })

  it('copies when asked, recording the content hash', () => {
    const target = join(root, 'demo')
    const outcome = deploySkill('demo', library, target, 'user-agents', 'copy', undefined)
    expect(outcome.deployed).toBe(true)
    expect(outcome.contentHash).not.toBeNull()
    // The copy is independent: editing the library afterwards does not change it.
    writeFileSync(join(library, 'SKILL.md'), 'changed')
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('name: demo')
  })

  it('refuses to overwrite a directory it did not deploy', () => {
    const target = join(root, 'demo')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), 'someone else')
    const outcome = deploySkill('demo', library, target, 'user-agents', 'copy', undefined)
    expect(outcome.deployed).toBe(false)
    expect(outcome.reason).toBe('foreign-target')
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('someone else')
  })

  it('refuses to overwrite a copy the user edited', () => {
    const target = join(root, 'demo')
    const first = deploySkill('demo', library, target, 'user-agents', 'copy', undefined)
    const record = {
      id: 'r1',
      preset_id: null,
      skill_name: 'demo',
      root_key: 'user-agents' as RootKey,
      target_path: target,
      mode: 'copy' as const,
      source_path: library,
      source_hash: first.contentHash,
      deployed_at: Date.now(),
    }
    writeFileSync(join(target, 'SKILL.md'), 'my edit')
    const second = deploySkill('demo', library, target, 'user-agents', 'copy', record)
    expect(second.deployed).toBe(false)
    expect(second.reason).toBe('local-changes')
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('my edit')
  })

  it('replaces a recorded deployment that is still ours', () => {
    const target = join(root, 'demo')
    const first = deploySkill('demo', library, target, 'user-agents', 'copy', undefined)
    const record = {
      id: 'r1',
      preset_id: null,
      skill_name: 'demo',
      root_key: 'user-agents' as RootKey,
      target_path: target,
      mode: 'copy' as const,
      source_path: library,
      source_hash: first.contentHash,
      deployed_at: Date.now(),
    }
    writeFileSync(join(library, 'SKILL.md'), '---\nname: demo\ndescription: changed\n---\n')
    const second = deploySkill('demo', library, target, 'user-agents', 'copy', record)
    expect(second.deployed).toBe(true)
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('changed')
  })

  it('only removes a link that still points at the library', () => {
    const target = join(root, 'demo')
    const outcome = deploySkill('demo', library, target, 'user-agents', 'symlink', undefined)
    const record = {
      id: 'r1',
      preset_id: null,
      skill_name: 'demo',
      root_key: 'user-agents' as RootKey,
      target_path: target,
      mode: 'symlink' as const,
      source_path: library,
      source_hash: outcome.contentHash,
      deployed_at: Date.now(),
    }
    rmSync(target, { force: true })
    symlinkSync(join(tmp, 'elsewhere'), target)
    expect(undeploySkill(target, record, library)).toBe(false)
    // A dangling link is invisible to existsSync (it follows the link); the
    // entry itself must still be there.
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
  })

  it('removes a recorded copy', () => {
    const target = join(root, 'demo')
    const outcome = deploySkill('demo', library, target, 'user-agents', 'copy', undefined)
    const record = {
      id: 'r1',
      preset_id: null,
      skill_name: 'demo',
      root_key: 'user-agents' as RootKey,
      target_path: target,
      mode: 'copy' as const,
      source_path: library,
      source_hash: outcome.contentHash,
      deployed_at: Date.now(),
    }
    expect(undeploySkill(target, record, library)).toBe(true)
    expect(existsSync(target)).toBe(false)
  })
})

describe('activating a preset deploys its members and reclaims the rest', () => {
  let tmp: string
  let store: PresetStore
  let library: Map<string, { name: string; dir: string }>

  function makeSkill(name: string): void {
    const dir = join(tmp, 'library', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`)
    library.set(name, { name, dir })
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dsh-apply-'))
    store = new PresetStore(':memory:')
    library = new Map()
    for (const name of ['alpha', 'beta', 'gamma']) makeSkill(name)
  })

  afterEach(() => {
    store.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const layout = (selected: RootKey[]) => ({
    dirs: {
      'user-dsh': join(tmp, 'dsh', 'skills'),
      'user-agents': join(tmp, 'agents', 'skills'),
      'project-dsh': join(tmp, 'proj', '.dsh', 'skills'),
      'project-agents': join(tmp, 'proj', '.agents', 'skills'),
    },
    selected,
    mode: 'symlink' as const,
  })

  it('deploys members into every selected root', () => {
    const preset = store.createPreset('p', ['alpha', 'beta'])!
    const result = applyPreset(store, preset, library, layout(['user-agents']))
    expect(result.deployed.filter((entry) => entry.deployed)).toHaveLength(2)
    expect(existsSync(join(tmp, 'agents', 'skills', 'alpha', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(tmp, 'agents', 'skills', 'beta', 'SKILL.md'))).toBe(true)
    expect(store.activePresetId()).toBe(preset.id)
  })

  it('removes a previously deployed skill the new preset does not own', () => {
    const wide = store.createPreset('wide', ['alpha', 'beta'])!
    applyPreset(store, wide, library, layout(['user-agents']))
    expect(existsSync(join(tmp, 'agents', 'skills', 'beta'))).toBe(true)

    const narrow = store.createPreset('narrow', ['alpha'])!
    const result = applyPreset(store, narrow, library, layout(['user-agents']))
    expect(result.removed.map((entry) => entry.skillName)).toContain('beta')
    expect(existsSync(join(tmp, 'agents', 'skills', 'beta'))).toBe(false)
    expect(existsSync(join(tmp, 'agents', 'skills', 'alpha'))).toBe(true)
    expect(store.deploymentsFor('beta')).toEqual([])
  })

  it('reports a member with no library copy instead of failing the activation', () => {
    const preset = store.createPreset('p', ['alpha', 'missing'])!
    const result = applyPreset(store, preset, library, layout(['user-agents']))
    const missing = result.deployed.find((entry) => entry.skillName === 'missing')
    expect(missing?.deployed).toBe(false)
    expect(missing?.reason).toBe('no-library-copy')
    expect(existsSync(join(tmp, 'agents', 'skills', 'alpha'))).toBe(true)
  })

  it('leaves a foreign directory in place and reports it', () => {
    const preset = store.createPreset('p', ['alpha'])!
    const foreign = join(tmp, 'agents', 'skills', 'alpha')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'SKILL.md'), 'not ours')
    const result = applyPreset(store, preset, library, layout(['user-agents']))
    expect(result.deployed[0]!.deployed).toBe(false)
    expect(result.deployed[0]!.reason).toBe('foreign-target')
    expect(readFileSync(join(foreign, 'SKILL.md'), 'utf8')).toBe('not ours')
  })

  it('does not reclaim deployments in roots this activation does not touch', () => {
    const wide = store.createPreset('wide', ['alpha', 'beta'])!
    applyPreset(store, wide, library, layout(['user-agents']))
    const narrow = store.createPreset('narrow', ['alpha'])!
    const result = applyPreset(store, narrow, library, layout(['project-dsh']))
    expect(result.removed).toEqual([])
    expect(existsSync(join(tmp, 'agents', 'skills', 'beta'))).toBe(true)
  })

  it('resolves the four harness roots', () => {
    const roots = { dshHome: join('/h', '.dsh'), agentsHome: join('/h', '.agents'), projectRoot: '/p' }
    expect(rootDir('user-dsh', roots)).toBe(join('/h', '.dsh', 'skills'))
    expect(rootDir('user-agents', roots)).toBe(join('/h', '.agents', 'skills'))
    expect(rootDir('project-dsh', roots)).toBe(join('/p', '.dsh', 'skills'))
    expect(rootDir('project-agents', roots)).toBe(join('/p', '.agents', 'skills'))
  })
})

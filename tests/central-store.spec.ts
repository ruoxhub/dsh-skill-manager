import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CentralSkillStore, getCentralDbPath, getCentralManagerRoot, getCentralSkillsDir } from '../src/central-store.ts'

describe('central store default location', () => {
  const savedRoot = process.env.SKILLS_MANAGER_ROOT

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.SKILLS_MANAGER_ROOT
    else process.env.SKILLS_MANAGER_ROOT = savedRoot
  })

  it('defaults the library to ~/.agents/skills-manager', () => {
    // Given no override in the environment
    delete process.env.SKILLS_MANAGER_ROOT

    // Then database and skill folders both land under the agents home
    const root = getCentralManagerRoot()
    expect(root).toBe(join(homedir(), '.agents', 'skills-manager'))
    expect(getCentralDbPath()).toBe(join(root, 'skills-manager.db'))
    expect(getCentralSkillsDir()).toBe(join(root, 'skills'))
  })

  it('lets SKILLS_MANAGER_ROOT override the default', () => {
    // Given an explicit root, as a test or a relocated library would set
    process.env.SKILLS_MANAGER_ROOT = '/tmp/custom-library'

    // Then every derived path follows it instead of the default
    expect(getCentralManagerRoot()).toBe('/tmp/custom-library')
    expect(getCentralDbPath()).toBe(join('/tmp/custom-library', 'skills-manager.db'))
    expect(getCentralSkillsDir()).toBe(join('/tmp/custom-library', 'skills'))
  })
})

describe('CentralSkillStore (node:sqlite)', () => {
  let store: CentralSkillStore

  beforeEach(() => {
    store = new CentralSkillStore(':memory:', true)
    // Seed test data matching real schema
    const db = (store as unknown as { db: { exec: (sql: string) => void } }).db
    db.exec(`
      INSERT INTO skills (id, name, description, source_type, source_ref, central_path, source_revision, remote_revision, source_branch, update_status, created_at, updated_at)
      VALUES 
        ('s1', 'caveman', 'Terse voice', 'git', 'https://github.com/JuliusBrussee/caveman', 'C:/Users/test/.skills-manager/skills/caveman', 'rev1', 'rev1', 'main', 'up_to_date', 1700000000000, 1700000000000),
        ('s2', 'test-tool', 'Another tool', 'git', 'https://github.com/example/repo', 'C:/Users/test/.skills-manager/skills/test-tool', 'rev1', 'rev2', 'main', 'update_available', 1700000000000, 1700000000000);
      INSERT INTO skill_targets (id, skill_id, tool, target_path, mode, synced_at)
      VALUES ('t1', 's2', 'pi', 'C:/Users/test/.agents/skills/test-tool', 'symlink', 1700000000000);
    `)
  })

  afterEach(() => {
    store.close()
  })

  it('reads all skills and maps update status correctly', () => {
    const skills = store.getAllSkills()
    expect(skills.length).toBe(2)

    const caveman = store.getSkillByName('caveman')
    expect(caveman?.name).toBe('caveman')
    expect(caveman?.update_status).toBe('up_to_date')

    const count = store.getAvailableUpdateCount()
    expect(count).toBe(1)

    const statusMap = store.getNameToStatusMap()
    expect(statusMap.get('test-tool')?.updateStatus).toBe('update_available')
  })

  it('updates check state and records remote revision', () => {
    store.updateCheckState('s1', 'rev_new', 'update_available', null, Date.now())

    const updated = store.getSkillById('s1')
    expect(updated?.update_status).toBe('update_available')
    expect(updated?.remote_revision).toBe('rev_new')
    expect(store.getAvailableUpdateCount()).toBe(2)
  })

  it('marks skill as updated and synchronizes revisions', () => {
    store.markSkillUpdated('s2', 'rev2')

    const updated = store.getSkillByName('test-tool')
    expect(updated?.source_revision).toBe('rev2')
    expect(updated?.remote_revision).toBe('rev2')
    expect(updated?.update_status).toBe('up_to_date')
    expect(store.getAvailableUpdateCount()).toBe(0)

    const targets = store.getSkillTargets('s2')
    expect(targets.length).toBe(1)
    expect(targets[0].tool).toBe('pi')
  })

  it('deletes a skill together with its deployed-target rows', () => {
    // When the tracked skill is removed
    store.deleteSkill('s2')

    // Then its row and its targets are gone, so the panel cannot keep listing
    // or offering updates for a skill that no longer exists
    expect(store.getSkillByName('test-tool')).toBeUndefined()
    expect(store.getSkillTargets('s2')).toEqual([])
    expect(store.getSkillById('s1')).toBeDefined()
  })
})

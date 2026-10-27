/**
 * Unit tests for Skill Presets persistence in panel-prefs:
 * verifies saving a preset, deleting a preset, loading stored presets,
 * and graceful fallback on malformed preset data.
 */
import { describe, expect, it } from 'vitest'
import {
  defaultListPrefs,
  deletePreset,
  loadListPrefs,
  saveListPrefs,
  savePreset,
  type ListViewPrefs,
  type SkillPreset,
  type StorageLike,
} from '../src/client/panel-prefs.ts'

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

describe('Skill Presets in panel-prefs', () => {
  it('saves and deletes a preset in ListViewPrefs', () => {
    const initial = defaultListPrefs()
    expect(initial.presets ?? []).toEqual([])

    const updated = savePreset(initial, 'Development', ['git-master', 'code-reviewer'])
    expect(updated.presets?.length).toBe(1)
    expect(updated.presets?.[0]?.name).toBe('Development')
    expect(updated.presets?.[0]?.enabledSkills).toEqual(['git-master', 'code-reviewer'])

    const presetId = updated.presets![0]!.id
    const afterDelete = deletePreset(updated, presetId)
    expect(afterDelete.presets).toEqual([])
  })

  it('persists and reloads presets via StorageLike', () => {
    const storage = new MemoryStorage()
    const prefs: ListViewPrefs = {
      ...defaultListPrefs(),
      presets: [
        { id: 'p1', name: 'Frontend', enabledSkills: ['react-patterns', 'tailwind'] },
      ],
    }

    saveListPrefs(storage, prefs)
    const loaded = loadListPrefs(storage)
    expect(loaded.presets).toEqual([
      { id: 'p1', name: 'Frontend', enabledSkills: ['react-patterns', 'tailwind'] },
    ])
  })

  it('gracefully filters corrupted presets in storage', () => {
    const storage = new MemoryStorage()
    const malformed = {
      levels: [],
      status: 'all',
      marks: [],
      collapsed: {},
      presets: [
        null,
        { id: 'p1', name: 'Valid', enabledSkills: ['valid-skill'] },
        { id: 123, name: '' },
        'not an object',
      ],
    }
    storage.setItem('dsh-skill-explorer:list-view:v1', JSON.stringify(malformed))

    const loaded = loadListPrefs(storage)
    expect(loaded.presets).toEqual([
      { id: 'p1', name: 'Valid', enabledSkills: ['valid-skill'] },
    ])
  })
})

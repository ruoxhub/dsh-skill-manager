/**
 * Persisted list-view preferences (#1881): the skills tab's facets and its
 * per-group collapse decisions survive a panel remount and a refresh, and a
 * damaged stored document degrades instead of breaking the tab.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPANDED_LEVELS,
  LIST_VIEW_STORAGE_KEY,
  defaultListPrefs,
  isGroupExpanded,
  loadListPrefs,
  saveListPrefs,
  toggleGroupCollapsed,
  type ListViewPrefs,
  type StorageLike,
} from '../src/client/panel-prefs.ts'

/** A storage that refuses writes, the way a full quota or private mode does. */
function refusingStorage(): StorageLike {
  return {
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded') },
  }
}

/** A storage that refuses even to be read. */
function unreadableStorage(): StorageLike {
  return {
    getItem: () => { throw new Error('storage disabled') },
    setItem: () => {},
  }
}

describe('list view preferences: defaults', () => {
  it('user opening the panel for the first time sees no facet applied', () => {
    // Given a browser that has never stored a view
    const prefs = loadListPrefs(localStorage)
    // When the tab starts from those preferences
    // Then every facet is wide open
    expect(prefs).toEqual(defaultListPrefs())
    expect(prefs.levels).toEqual([])
    expect(prefs.status).toBe('all')
    expect(prefs.marks).toEqual([])
  })

  it('user opening the panel for the first time sees the workspace roots open and the global sources folded', () => {
    // Given a browser that has never stored a view
    const prefs = loadListPrefs(localStorage)
    // When the groups render
    // Then the roots the user is actively working in are visible
    for (const key of DEFAULT_EXPANDED_LEVELS) {
      expect(isGroupExpanded(key, prefs.collapsed)).toBe(true)
    }
    // And the machine-level sources stay folded so a wide catalog is not painted at once
    expect(isGroupExpanded('bundled', prefs.collapsed)).toBe(false)
    expect(isGroupExpanded('runtime', prefs.collapsed)).toBe(false)
    expect(isGroupExpanded('custom', prefs.collapsed)).toBe(false)
    // A source group this build has never heard of also starts folded
    expect(isGroupExpanded('other:mystery-plugin', prefs.collapsed)).toBe(false)
  })
})

describe('list view preferences: round trip', () => {
  it('user who narrowed the list gets the same facets back after a refresh', () => {
    // Given a user who ticked one source, one status and one mark, and folded a group
    const prefs: ListViewPrefs = {
      levels: ['user-dsh'],
      status: 'disabled',
      marks: ['linked'],
      collapsed: { 'user-dsh': true },
    }
    // When the view is stored and the tab starts again
    const stored = saveListPrefs(localStorage, prefs)
    const restored = loadListPrefs(localStorage)
    // Then the write reported success and every axis came back exactly as set
    expect(stored).toBe(true)
    expect(restored).toEqual(prefs)
    expect(isGroupExpanded('user-dsh', restored.collapsed)).toBe(false)
  })
})

describe('list view preferences: damaged documents', () => {
  afterEach(() => { localStorage.clear() })

  it('user whose stored document is not JSON sees the default view', () => {
    // Given a stored value that is not JSON
    localStorage.setItem(LIST_VIEW_STORAGE_KEY, '{not json at all')
    // When the tab starts
    const prefs = loadListPrefs(localStorage)
    // Then it falls back to the defaults instead of throwing
    expect(prefs).toEqual(defaultListPrefs())
  })

  it('user whose stored document holds one bad field keeps the rest of the view', () => {
    // Given a document where the status and one mark are unreadable, but the
    // source and a collapse decision are fine
    localStorage.setItem(LIST_VIEW_STORAGE_KEY, JSON.stringify({
      levels: ['user-dsh', 7, '', 'user-dsh'],
      status: 'bogus',
      marks: ['linked', 'nope'],
      collapsed: { runtime: true, bundled: 'yes' },
    }))
    // When the tab starts
    const prefs = loadListPrefs(localStorage)
    // Then each field is validated on its own: the good halves survive
    expect(prefs.levels).toEqual(['user-dsh'])
    expect(prefs.marks).toEqual(['linked'])
    expect(prefs.collapsed).toEqual({ runtime: true })
    // And the unreadable status falls back to showing both
    expect(prefs.status).toBe('all')
  })

  it('user whose stored document is oversized sees the default view', () => {
    // Given a document larger than the reader accepts
    localStorage.setItem(LIST_VIEW_STORAGE_KEY, JSON.stringify({ levels: ['user-dsh'], pad: 'x'.repeat(9 * 1024) }))
    // When the tab starts
    const prefs = loadListPrefs(localStorage)
    // Then the oversized value is ignored rather than parsed
    expect(prefs).toEqual(defaultListPrefs())
  })

  it('user whose stored value is a JSON array sees the default view', () => {
    // Given a stored document of the wrong shape
    localStorage.setItem(LIST_VIEW_STORAGE_KEY, JSON.stringify(['user-dsh']))
    // When the tab starts
    const prefs = loadListPrefs(localStorage)
    // Then the shape check falls back to the defaults
    expect(prefs).toEqual(defaultListPrefs())
  })
})

describe('list view preferences: unavailable storage', () => {
  it('user whose browser refuses storage still browses the list', () => {
    // Given a browser that throws on write and one that throws on read
    const refusing = refusingStorage()
    const unreadable = unreadableStorage()
    // When the view is saved and read back
    const stored = saveListPrefs(refusing, { levels: ['user-dsh'], status: 'all', marks: [], collapsed: {} })
    const read = loadListPrefs(unreadable)
    // Then neither throws: the write reports that nothing persisted and the
    // read hands back the defaults
    expect(stored).toBe(false)
    expect(read).toEqual(defaultListPrefs())
  })

  it('user in a context with no storage at all still gets the defaults', () => {
    // Given no storage to read or write
    // When the view is loaded and saved
    // Then the read yields the defaults and the write reports nothing persisted
    expect(loadListPrefs(undefined)).toEqual(defaultListPrefs())
    expect(saveListPrefs(undefined, defaultListPrefs())).toBe(false)
  })
})

describe('list view preferences: group collapse decisions', () => {
  it('user collapsing an open group records the decision', () => {
    // Given a group that starts open
    const before = defaultListPrefs()
    // When the user collapses it
    const after = toggleGroupCollapsed('user-dsh', before.collapsed)
    // Then the group is folded and the decision is stored explicitly
    expect(isGroupExpanded('user-dsh', after)).toBe(false)
    expect(after['user-dsh']).toBe(true)
    // And toggling again opens it rather than stacking a second decision
    const reopened = toggleGroupCollapsed('user-dsh', after)
    expect(isGroupExpanded('user-dsh', reopened)).toBe(true)
  })

  it('user opening a folded group records the decision', () => {
    // Given a group that starts folded
    const before = defaultListPrefs()
    // When the user opens it
    const after = toggleGroupCollapsed('bundled', before.collapsed)
    // Then it is visible and the decision overrides the default
    expect(isGroupExpanded('bundled', after)).toBe(true)
    expect(after.bundled).toBe(false)
  })
})

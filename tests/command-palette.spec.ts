import { describe, expect, it } from 'vitest'
import { normalizeQuery, rankCommands, type PaletteCommand } from '../src/client/panel/CommandPalette.tsx'

/** A command that records whether it ran. */
function command(id: string, label: string, keywords?: string): PaletteCommand {
  return { id, label, group: 'skills', ...(keywords === undefined ? {} : { keywords }), run: () => {} }
}

describe('command palette ranking', () => {
  it('treats dashes, underscores and spaces as the same separator', () => {
    expect(normalizeQuery('  Wrap-Up  ')).toBe('wrap up')
    expect(normalizeQuery('wrap_up')).toBe('wrap up')
  })

  it('returns everything for an empty query, in the given order', () => {
    const all = [command('a', 'alpha'), command('b', 'beta')]
    expect(rankCommands(all, '   ').map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('ranks a label prefix above a mid-label hit above a keyword hit', () => {
    const rows = [
      command('keyword', 'something else', 'alpha mentioned here'),
      command('middle', 'my alpha thing'),
      command('prefix', 'alpha-skill'),
    ]
    expect(rankCommands(rows, 'alpha').map((entry) => entry.id)).toEqual(['prefix', 'middle', 'keyword'])
  })

  it('moves a skill above an action that merely shares its words', () => {
    const rows: PaletteCommand[] = [
      { id: 'action:update-all', label: 'Update all available', group: 'actions', run: () => {} },
      { id: 'skill:update', label: 'update', group: 'skills', run: () => {} },
    ]
    expect(rankCommands(rows, 'update').map((entry) => entry.id)).toEqual(['skill:update', 'action:update-all'])
  })

  it('matches a skill by its description', () => {
    const rows = [command('a', 'unrelated', 'builds powerpoints from markdown')]
    expect(rankCommands(rows, 'powerpoint').map((entry) => entry.id)).toEqual(['a'])
  })

  it('returns nothing when nothing matches', () => {
    expect(rankCommands([command('a', 'alpha')], 'zzz')).toEqual([])
  })

  it('matches across a separator difference', () => {
    const rows = [command('a', 'wrap-up')]
    expect(rankCommands(rows, 'wrap up').map((entry) => entry.id)).toEqual(['a'])
  })
})

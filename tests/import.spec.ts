/**
 * Import rules (#1881): archive decoding, directory scanning, candidate
 * validation, the source-rank conflict rule, and the write pass.
 *
 * The archives here are built in the test rather than checked in as binary
 * fixtures, so the reader is exercised against the exact byte layout it has to
 * accept (and against the layouts it has to refuse) with no opaque file in the
 * repository.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SkillEntry } from '../src/collect.ts'
import {
  candidatesFromArchive,
  candidatesFromDirectory,
  executeImport,
  importSkills,
  parseCandidate,
  planImport,
  readZipEntries,
  type ImportCandidate,
} from '../src/import.ts'
import { buildZip } from './zip-builder.ts'

// The whole fixture tree, removed in afterAll. It is a directory this test
// created with mkdtempSync: no links, no user data, and nothing outside it —
// the recursive remove is scoped to exactly that freshly created path.
const TMP = mkdtempSync(join(tmpdir(), 'skill-explorer-import-'))

afterAll(() => { rmSync(TMP, { recursive: true, force: true }) })

/** Create (or reuse) a directory under the fixture root. */
function dir(name: string): string {
  const path = join(TMP, name)
  mkdirSync(path, { recursive: true })
  return path
}

/** Write a file inside the fixture root. */
function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

// Symlink support is environment-dependent (Windows needs Developer Mode, some
// sandboxed runners disallow it) — probe once, as the route spec does.
let CAN_SYMLINK = false
try {
  const target = dir('symlink-probe/target')
  symlinkSync(target, join(TMP, 'symlink-probe', 'link'), 'dir')
  CAN_SYMLINK = true
} catch {
  CAN_SYMLINK = false
}

/** The SKILL.md text of a well-formed skill. */
function skillFile(name: string, description = 'demo skill'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# body\n`
}

/** A collected entry, as the list route would serve it. */
function existingSkill(name: string, level: string): SkillEntry {
  return { name, description: 'existing', level, fileState: 'virtual', modelInvocable: true, userInvocable: true }
}

/** A validated candidate whose only interesting part is its name. */
function candidate(name: string, content = skillFile(name)): ImportCandidate {
  return { name, content, origin: `${name}/SKILL.md` }
}

describe('Skill import: archive decoding', () => {
  it('operator importing a stored-method archive gets every SKILL.md decoded', () => {
    // Given an archive holding two skills and one readme
    const archive = buildZip([
      { path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill') },
      { path: 'nested/beta-skill/SKILL.md', content: skillFile('beta-skill') },
      { path: 'README.md', content: 'not a skill' },
    ])
    // When the archive is decoded
    const candidates = candidatesFromArchive(readZipEntries(archive))
    // Then only the SKILL.md entries survive, with their text intact
    expect(candidates.map(entry => entry.origin)).toEqual([
      'alpha-skill/SKILL.md',
      'nested/beta-skill/SKILL.md',
    ])
    expect(candidates[0].content).toBe(skillFile('alpha-skill'))
  })

  it('operator importing a deflated archive gets the same text back', () => {
    // Given an archive whose entries use deflate
    const archive = buildZip([{ path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill') }], { method: 8 })
    // When it is decoded
    const candidates = candidatesFromArchive(readZipEntries(archive))
    // Then the inflated text matches the source text exactly
    expect(candidates).toHaveLength(1)
    expect(candidates[0].content).toBe(skillFile('alpha-skill'))
  })

  it('operator importing bytes that are not an archive reads a clear refusal', () => {
    // Given bytes with no end-of-central-directory record
    const archive = Buffer.from('this is not a zip file at all', 'utf8')
    // When the import tries to decode them
    const attempt = (): unknown => readZipEntries(archive)
    // Then the failure names the archive, not an internal offset
    expect(attempt).toThrow(/not a zip archive/u)
  })

  it('operator importing an archive with an encrypted entry is refused by name', () => {
    // Given an archive whose entry carries the encryption flag
    const archive = buildZip([{ path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill') }], { flags: 1 })
    // When it is decoded
    const attempt = (): unknown => readZipEntries(archive)
    // Then the refusal names the offending entry
    expect(attempt).toThrow(/encrypted.*alpha-skill\/SKILL\.md/u)
  })

  it('operator importing an archive with an unknown compression method is refused', () => {
    // Given an entry compressed with a method nothing here implements
    const archive = buildZip([{ path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill') }], { method: 99 })
    // When it is decoded
    const attempt = (): unknown => readZipEntries(archive)
    // Then the refusal reports the method so the user knows what to re-export
    expect(attempt).toThrow(/compression method 99/u)
  })

  it('operator importing a zip64 archive is refused instead of half read', () => {
    // Given an archive written with the zip64 escape count
    const archive = buildZip([{ path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill') }], { zip64: true })
    // When it is decoded
    const attempt = (): unknown => readZipEntries(archive)
    // Then the unsupported layout is stated plainly
    expect(attempt).toThrow(/zip64/u)
  })

  it('operator importing an archive with an escaping entry path gets no candidate from it', () => {
    // Given an entry whose path climbs out of the archive
    const archive = buildZip([
      { path: '../escape/SKILL.md', content: skillFile('escape-skill') },
      { path: 'safe-skill/SKILL.md', content: skillFile('safe-skill') },
    ])
    // When the entries are decoded
    const candidates = candidatesFromArchive(readZipEntries(archive))
    // Then only the in-archive path is kept
    expect(candidates.map(entry => entry.origin)).toEqual(['safe-skill/SKILL.md'])
  })
})

describe('Skill import: directory scanning', () => {
  it('operator importing a directory reads both skill shapes and ignores the rest', async () => {
    // Given a directory with a skill folder, a flattened skill and noise
    const source = dir('shapes')
    write(join(source, 'alpha-skill', 'SKILL.md'), skillFile('alpha-skill'))
    write(join(source, 'beta-skill.md'), skillFile('beta-skill'))
    write(join(source, 'notes.txt'), 'noise')
    write(join(source, '.hidden', 'SKILL.md'), skillFile('hidden-skill'))
    // When the directory is scanned
    const candidates = await candidatesFromDirectory(source)
    // Then the two skill shapes are found and the noise is not
    expect(candidates.map(entry => entry.origin).sort()).toEqual([
      join(source, 'alpha-skill', 'SKILL.md'),
      join(source, 'beta-skill.md'),
    ].sort())
  })

  it('operator naming a path that is not a directory reads a clear refusal', async () => {
    // Given a file where a directory was expected
    const source = join(dir('not-a-dir'), 'file.md')
    write(source, skillFile('alpha-skill'))
    // When the import scans it
    // Then the failure says the source is not a directory
    await expect(candidatesFromDirectory(source)).rejects.toThrow(/not a directory/u)
    // And a path that does not exist fails the same way rather than silently
    await expect(candidatesFromDirectory(join(TMP, 'missing'))).rejects.toThrow(/not a readable directory/u)
  })

  it('operator importing a directory does not follow a planted symlink', async () => {
    // Given a skill reachable only through a symlink inside the source
    if (!CAN_SYMLINK) return
    const source = dir('symlink-source')
    const target = dir('symlink-target')
    write(join(target, 'linked-skill', 'SKILL.md'), skillFile('linked-skill'))
    symlinkSync(join(target, 'linked-skill'), join(source, 'linked-skill'), 'dir')
    // When the source directory is scanned
    const candidates = await candidatesFromDirectory(source)
    // Then the link is skipped, so an import copies only what the user put there
    expect(candidates).toEqual([])
  })
})

describe('Skill import: candidate validation', () => {
  it('operator importing a file without a name or description is told which field is missing', () => {
    // Given a SKILL.md whose frontmatter omits the description
    const raw = { origin: '/src/alpha-skill/SKILL.md', content: '---\nname: alpha-skill\n---\nbody\n' }
    // When it is validated
    const parsed = parseCandidate(raw)
    // Then it is refused for the frontmatter, naming what the file claimed
    expect(parsed.reason).toBe('invalid-frontmatter')
    expect(parsed.candidate).toBeUndefined()
    expect(parsed.name).toBe('alpha-skill')
  })

  it('operator importing a name outside the official grammar is refused', () => {
    // Given a skill whose frontmatter name is not kebab-case
    const raw = { origin: '/src/Bad_Name/SKILL.md', content: '---\nname: Bad_Name\ndescription: demo\n---\n' }
    // When it is validated
    const parsed = parseCandidate(raw)
    // Then the official name rule rejects it
    expect(parsed.reason).toBe('invalid-name')
    expect(parsed.candidate).toBeUndefined()
    expect(parsed.name).toBe('Bad_Name')
  })

  it('operator importing content past the size cap is refused', () => {
    // Given a SKILL.md larger than the create/edit cap
    const raw = { origin: '/src/huge-skill/SKILL.md', content: `---\nname: huge-skill\ndescription: ${'x'.repeat(70 * 1024)}\n---\n` }
    // When it is validated
    const parsed = parseCandidate(raw)
    // Then the size cap is the stated reason
    expect(parsed.reason).toBe('too-large')
    expect(parsed.candidate).toBeUndefined()
  })

  it('operator importing a well-formed file gets its frontmatter name as the skill identity', () => {
    // Given a folder name that disagrees with the frontmatter name
    const raw = { origin: '/src/renamed-folder/SKILL.md', content: skillFile('actual-skill') }
    // When it is validated
    const parsed = parseCandidate(raw)
    // Then the registry name wins, because that is what the model receives
    expect(parsed.candidate?.name).toBe('actual-skill')
    expect(parsed.candidate?.content).toBe(skillFile('actual-skill'))
  })
})

describe('Skill import: source-rank conflict rule', () => {
  it('operator importing into an empty root plans every candidate for writing', () => {
    // Given a target root with no same-name skill anywhere
    // When the plan is built
    const plan = planImport([candidate('alpha-skill')], [], 'user-dsh')
    // Then the candidate is written
    expect(plan.map(item => item.decision)).toEqual(['import'])
  })

  it('operator importing a name a stronger source provides is skipped as shadowed', () => {
    // Given a project skill (rank 100) that already owns the name
    const existing = [existingSkill('alpha-skill', 'project-dsh')]
    // When the user imports it into the user root (rank 400)
    const plan = planImport([candidate('alpha-skill')], existing, 'user-dsh')
    // Then nothing is written, because the model would never receive the copy
    expect(plan.map(item => item.reason)).toEqual(['shadowed'])
  })

  it('operator importing a name the same source already has is skipped as existing', () => {
    // Given a user skill that already owns the name
    const existing = [existingSkill('alpha-skill', 'user-dsh')]
    // When the same name is imported into the user root again
    const plan = planImport([candidate('alpha-skill')], existing, 'user-dsh')
    // Then it is reported as already present rather than overwritten
    expect(plan.map(item => item.reason)).toEqual(['exists'])
  })

  it('operator importing a name only a weaker source has still writes the import', () => {
    // Given only a bundled skill (rank 600) owns the name
    const existing = [existingSkill('alpha-skill', 'bundled')]
    // When it is imported into the project root (rank 100)
    const plan = planImport([candidate('alpha-skill')], existing, 'project-dsh')
    // Then the import wins the rank comparison and is written
    expect(plan.map(item => item.decision)).toEqual(['import'])
  })

  it('operator importing the same name twice from one source keeps only the first', () => {
    // Given two candidates that resolve to the same skill name
    // When the plan is built
    const plan = planImport([candidate('alpha-skill'), candidate('alpha-skill')], [], 'user-dsh')
    // Then the later duplicate is dropped with its own reason
    expect(plan.map(item => item.decision)).toEqual(['import', 'skip'])
    expect(plan[1].reason).toBe('duplicate')
  })
})

describe('Skill import: write pass', () => {
  it('operator importing one archive writes each skill under the chosen root', async () => {
    // Given a user root and an archive with two skills
    const baseDir = join(dir('write-root'), 'skills')
    const archive = buildZip([
      { path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill') },
      { path: 'beta-skill/SKILL.md', content: skillFile('beta-skill') },
    ])
    // When the archive is imported
    const report = await importSkills({ baseDir, targetLevel: 'user-dsh', source: { kind: 'archive', data: archive }, existing: [] })
    // Then both files exist with the source text and the report says so
    expect(report.imported).toBe(2)
    expect(report.skipped).toBe(0)
    expect(readFileSync(join(baseDir, 'alpha-skill', 'SKILL.md'), 'utf8')).toBe(skillFile('alpha-skill'))
    expect(readFileSync(join(baseDir, 'beta-skill', 'SKILL.md'), 'utf8')).toBe(skillFile('beta-skill'))
  })

  it('operator importing the same archive twice keeps the first copy untouched', async () => {
    // Given a root that already received one import
    const baseDir = join(dir('twice-root'), 'skills')
    const archive = buildZip([{ path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill', 'first version') }])
    await importSkills({ baseDir, targetLevel: 'user-dsh', source: { kind: 'archive', data: archive }, existing: [] })
    // When a second import carries different content for the same name
    const second = buildZip([{ path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill', 'second version') }])
    const report = await importSkills({ baseDir, targetLevel: 'user-dsh', source: { kind: 'archive', data: second }, existing: [] })
    // Then the second run is refused and the original text survives
    expect(report.skipped).toBe(1)
    expect(report.outcomes[0].reason).toBe('exists')
    expect(readFileSync(join(baseDir, 'alpha-skill', 'SKILL.md'), 'utf8')).toBe(skillFile('alpha-skill', 'first version'))
  })

  it('operator importing a mixed archive gets one outcome per candidate in source order', async () => {
    // Given an archive with a valid skill, an invalid one and another valid one
    const baseDir = join(dir('order-root'), 'skills')
    const archive = buildZip([
      { path: 'alpha-skill/SKILL.md', content: skillFile('alpha-skill') },
      { path: 'broken/SKILL.md', content: 'no frontmatter here' },
      { path: 'gamma-skill/SKILL.md', content: skillFile('gamma-skill') },
    ])
    // When it is imported
    const report = await importSkills({ baseDir, targetLevel: 'user-dsh', source: { kind: 'archive', data: archive }, existing: [] })
    // Then the report follows the archive order and the bad file did not stop
    // the good ones
    expect(report.outcomes.map(outcome => outcome.origin)).toEqual([
      'alpha-skill/SKILL.md',
      'broken/SKILL.md',
      'gamma-skill/SKILL.md',
    ])
    expect(report.outcomes.map(outcome => outcome.status)).toEqual(['imported', 'skipped', 'imported'])
    expect(report.imported).toBe(2)
    expect(existsSync(join(baseDir, 'gamma-skill', 'SKILL.md'))).toBe(true)
  })

  it('operator importing a plan whose target file appeared meanwhile is not overwritten', async () => {
    // Given a plan built while the name looked free
    const baseDir = join(dir('race-root'), 'skills')
    const plan = planImport([candidate('alpha-skill')], [], 'user-dsh')
    // When the file is created before the write pass runs
    write(join(baseDir, 'alpha-skill', 'SKILL.md'), skillFile('alpha-skill', 'already here'))
    const outcomes = await executeImport(plan, baseDir)
    // Then the write pass refuses and the existing text is intact
    expect(outcomes[0].status).toBe('skipped')
    expect(outcomes[0].reason).toBe('exists')
    expect(readFileSync(join(baseDir, 'alpha-skill', 'SKILL.md'), 'utf8')).toBe(skillFile('alpha-skill', 'already here'))
  })
})
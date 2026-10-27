import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installMarketSkill, safeRelPath } from '../src/skillhub/installer.ts'
import { buildZip } from './zip-builder.ts'

describe('skillhub installer', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-skillhub-test-'))
  })

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('safeRelPath validates clean relative paths and rejects traversals', () => {
    expect(safeRelPath('SKILL.md')).toBe('SKILL.md')
    expect(safeRelPath('sub/dir/file.txt')).toBe('sub/dir/file.txt')
    expect(safeRelPath('sub\\win\\file.txt')).toBe('sub/win/file.txt')

    expect(() => safeRelPath('')).toThrow()
    expect(() => safeRelPath('/root/file')).toThrow()
    expect(() => safeRelPath('../file')).toThrow()
    expect(() => safeRelPath('foo/../bar')).toThrow()
  })

  it('installs a valid skill zip into target root', async () => {
    const zipBuf = buildZip([
      {
        path: 'SKILL.md',
        content: '---\nname: my-skill\ndescription: demo skill\n---\n# My Skill\nContent',
      },
      {
        path: 'references/guide.md',
        content: '# Guide',
      },
    ])

    const mockFetchBytes = async () => ({
      body: zipBuf,
      contentType: 'application/zip',
    })

    const result = await installMarketSkill('my-skill', {
      targetRoot: tempDir,
      version: '1.2.0',
      fetchBytesImpl: mockFetchBytes,
    })

    expect(result.slug).toBe('my-skill')
    expect(result.name).toBe('my-skill')
    expect(result.version).toBe('1.2.0')
    expect(result.files).toBe(2)

    const skillMd = await readFile(join(result.path, 'SKILL.md'), 'utf8')
    expect(skillMd).toContain('name: my-skill')
    const guideMd = await readFile(join(result.path, 'references', 'guide.md'), 'utf8')
    expect(guideMd).toBe('# Guide')
  })

  it('rejects zip missing SKILL.md', async () => {
    const zipBuf = buildZip([
      {
        path: 'README.md',
        content: 'No skill md here',
      },
    ])

    const mockFetchBytes = async () => ({
      body: zipBuf,
      contentType: 'application/zip',
    })

    await expect(
      installMarketSkill('no-skill', {
        targetRoot: tempDir,
        fetchBytesImpl: mockFetchBytes,
      }),
    ).rejects.toThrow('缺少 SKILL.md')
  })

  it('rejects zip with directory traversal entry', async () => {
    const zipBuf = buildZip([
      {
        path: 'SKILL.md',
        content: 'name: foo',
      },
      {
        path: '../evil.sh',
        content: 'rm -rf /',
      },
    ])

    const mockFetchBytes = async () => ({
      body: zipBuf,
      contentType: 'application/zip',
    })

    await expect(
      installMarketSkill('slip-skill', {
        targetRoot: tempDir,
        fetchBytesImpl: mockFetchBytes,
      }),
    ).rejects.toThrow(/拒绝路径穿越|不安全路径/)
  })
})

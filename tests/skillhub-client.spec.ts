import { describe, expect, it } from 'vitest'
import {
  CATEGORIES,
  CATEGORY_KEYS,
  categoryLabel,
  parseCategory,
} from '../src/skillhub/categories.ts'
import {
  dimScore,
  fetchSkillDetail,
  overallScore,
  parseSlug,
  searchSkills,
  TRACE_DIMS,
} from '../src/skillhub/client.ts'
import type { SkillHubListResponse, SkillHubDetailRaw } from '../src/skillhub/types.ts'

describe('skillhub categories', () => {
  it('maps category keys to Chinese labels', () => {
    expect(categoryLabel('dev-programming')).toBe('开发编程')
    expect(categoryLabel('office-efficiency')).toBe('办公效率')
    expect(categoryLabel('unknown-category')).toBe('unknown-category')
    expect(categoryLabel(undefined)).toBe('')
  })

  it('validates and parses category keys', () => {
    expect(parseCategory('dev-programming')).toBe('dev-programming')
    expect(parseCategory('pay-skill')).toBe('pay-skill')
    expect(parseCategory('invalid')).toBeUndefined()
    expect(parseCategory('')).toBeUndefined()
  })
})

describe('skillhub slug parsing', () => {
  it('parses valid slugs', () => {
    expect(parseSlug('find-skill-skillhub')).toBe('find-skill-skillhub')
    expect(parseSlug('@owner/my-skill')).toBe('my-skill')
    expect(parseSlug('  FOO_BAR  ')).toBe('foo_bar')
  })

  it('rejects malicious or invalid slugs', () => {
    expect(() => parseSlug('')).toThrow()
    expect(() => parseSlug('../foo')).toThrow()
    expect(() => parseSlug('a\\b')).toThrow()
    expect(() => parseSlug('invalid slug!')).toThrow()
  })
})

describe('skillhub TRACE scoring', () => {
  it('computes dimension and overall scores', () => {
    const dim = {
      items: {
        a: { score: 4.5 },
        b: { score: 3.5 },
      },
    }
    expect(dimScore(dim)).toBe(4)

    const dimensions = {
      trust: { items: { s: { score: 5 } } },
      reliability: { items: { s: { score: 4 } } },
      adaptability: { items: { s: { score: 4 } } },
      convention: { items: { s: { score: 5 } } },
      effectiveness: { items: { s: { score: 4 } } },
    }
    expect(overallScore(dimensions)).toBe(4.4)
  })

  it('returns null for empty or invalid dimensions', () => {
    expect(dimScore(null)).toBeNull()
    expect(overallScore({})).toBeNull()
  })
})

describe('skillhub searchSkills', () => {
  it('searches skills and formats skill cards', async () => {
    const mockResponse: SkillHubListResponse = {
      code: 0,
      message: 'success',
      data: {
        total: 1,
        skills: [
          {
            slug: 'test-skill',
            name: '测试技能',
            description_zh: '中文简介',
            category: 'dev-programming',
            downloads: 1234,
            stars: 56,
            version: '1.0.0',
            iconUrl: 'https://example.com/icon.png',
            publisher: { verified: true, name: 'Tencent' },
          },
        ],
      },
    }

    const mockFetch = async () => mockResponse

    const result = await searchSkills('test', {
      cfg: {
        apiBase: 'https://api.skillhub.cn',
        webBase: 'https://skillhub.cn',
        timeoutMs: 5000,
        userAgent: 'test-agent',
        maxResults: 20,
        sortBy: 'downloads',
      },
      fetchJsonImpl: mockFetch as any,
      installed: new Set(['test-skill']),
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0].slug).toBe('test-skill')
    expect(result.items[0].name).toBe('测试技能')
    expect(result.items[0].categoryLabel).toBe('开发编程')
    expect(result.items[0].installed).toBe(true)
    expect(result.items[0].verified).toBe(true)
    expect(result.items[0].publisherName).toBe('Tencent')
  })
})

describe('skillhub fetchSkillDetail', () => {
  it('fetches detail, versions, evaluation, and readme', async () => {
    const mockDetail: SkillHubDetailRaw = {
      skill: {
        slug: 'test-skill',
        displayName: '测试技能',
        summary_zh: '中文简介',
        category: 'dev-programming',
        stats: { downloads: 100, stars: 10 },
      },
      latestVersion: {
        version: '1.0.1',
        changelog: '更新日志',
      },
      owner: { handle: 'alice' },
    }

    const mockEval = {
      userSummary: '质量良好',
      dimensions: {
        trust: { userReason: '可信', items: { a: { score: 5, userReason: '安全' } } },
        reliability: { userReason: '稳定', items: { b: { score: 4.5, userReason: '稳定' } } },
      },
    }

    const mockVersions = {
      versions: [{ version: '1.0.1', changelog: '初始版本', createdAt: 1700000000000 }],
    }

    const mockFetchJson = async (url: string) => {
      if (url.includes('/evaluation')) return mockEval
      if (url.includes('/versions')) return mockVersions
      return mockDetail
    }

    const detail = await fetchSkillDetail('test-skill', {
      cfg: {
        apiBase: 'https://api.skillhub.cn',
        webBase: 'https://skillhub.cn',
        timeoutMs: 5000,
        userAgent: 'test-agent',
        maxResults: 20,
        sortBy: 'score',
      },
      fetchJsonImpl: mockFetchJson as any,
      installed: new Set(),
    })

    expect(detail.card.slug).toBe('test-skill')
    expect(detail.versions).toHaveLength(1)
    expect(detail.evaluation?.score).toBe(4.8)
    expect(detail.evaluation?.userSummary).toBe('质量良好')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { SkillApi } from '../src/client/api.ts'
import { PanelController } from '../src/client/panel/controller.ts'

describe('market controller and api', () => {
  it('supports market tab in PanelController', () => {
    const controller = new PanelController()
    expect(controller.getSnapshot().activeTab).toBe('skills')

    const listener = vi.fn()
    controller.subscribe(listener)

    controller.setActiveTab('market')
    expect(controller.getSnapshot().activeTab).toBe('market')
    expect(listener).toHaveBeenCalled()
  })

  it('SkillApi searchMarket calls market search endpoint', async () => {
    const api = new SkillApi()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        query: 'pdf',
        items: [],
        total: 0,
        offset: 0,
        hasMore: false,
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await api.searchMarket({ q: 'pdf', category: 'office-efficiency', sortBy: 'downloads' })
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api/dsh-skill-explorer/market/search?q=pdf&category=office-efficiency&sortBy=downloads'),
      expect.any(Object),
    )
    expect(result.query).toBe('pdf')

    vi.unstubAllGlobals()
  })

  it('SkillApi getMarketDetail calls market detail endpoint', async () => {
    const api = new SkillApi()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        card: { slug: 'test-slug', name: 'Test' },
        versions: [],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const detail = await api.getMarketDetail('test-slug')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api/dsh-skill-explorer/market/detail?slug=test-slug'),
      expect.any(Object),
    )
    expect(detail.card.slug).toBe('test-slug')

    vi.unstubAllGlobals()
  })

  it('SkillApi installMarket posts to market install endpoint', async () => {
    const api = new SkillApi()
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        slug: 'test-slug',
        name: 'Test',
        version: '1.0.0',
        path: '/path/to/skill',
        files: 2,
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await api.installMarket({ slug: 'test-slug', root: 'user' })
    expect(mockFetch).toHaveBeenCalledWith(
      'api/dsh-skill-explorer/market/install',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ slug: 'test-slug', root: 'user' }),
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.slug).toBe('test-slug')

    vi.unstubAllGlobals()
  })
})

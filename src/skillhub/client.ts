import { categoryLabel, parseCategory } from './categories.ts'
import type {
  FetchOptions,
  MarketSkillDetail,
  SearchResult,
  SkillCard,
  SkillHubConfig,
  SkillHubDetailRaw,
  SkillHubListResponse,
  SkillHubSkillRaw,
  SkillVersionItem,
  SortBy,
  TraceDimensionScore,
  TraceEvaluation,
} from './types.ts'

export const DEFAULT_CONFIG: SkillHubConfig = {
  apiBase: 'https://api.skillhub.cn',
  webBase: 'https://skillhub.cn',
  timeoutMs: 15000,
  userAgent: 'Mozilla/5.0 (compatible; dsh-skill-explorer/1.0)',
  maxResults: 20,
  sortBy: 'score',
}

export const TRACE_DIMS = [
  { key: 'trust', letter: 'T', name: '可信任度' },
  { key: 'reliability', letter: 'R', name: '可靠性' },
  { key: 'adaptability', letter: 'A', name: '适用性' },
  { key: 'convention', letter: 'C', name: '规范性' },
  { key: 'effectiveness', letter: 'E', name: '有效性' },
] as const

export function parseSlug(raw: string): string {
  const trimmed = String(raw || '').trim()
  if (!trimmed || trimmed.includes('..') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error('无效 slug')
  }
  const s = trimmed.replace(/^@/, '')
  const slug = s.includes('/') ? s.split('/').filter(Boolean).pop() || '' : s
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(slug)) {
    throw new Error('无效 slug')
  }
  return slug.toLowerCase()
}

export function fetchOpts(cfg: SkillHubConfig): FetchOptions {
  return { timeoutMs: cfg.timeoutMs, userAgent: cfg.userAgent }
}

export async function defaultFetchJson<T>(url: string, opts: FetchOptions, signal?: AbortSignal): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': opts.userAgent, accept: 'application/json' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function defaultFetchText(url: string, opts: FetchOptions, signal?: AbortSignal): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': opts.userAgent, accept: '*/*' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export function dimScore(dim: unknown): number | null {
  if (!dim || typeof dim !== 'object') return null
  const items = (dim as { items?: Record<string, { score?: unknown }> }).items
  const scores = Object.values(items || {}).map(it => Number(it?.score)).filter(n => Number.isFinite(n))
  if (!scores.length) return null
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
}

export function overallScore(dimensions: Record<string, unknown> | undefined): number | null {
  if (!dimensions) return null
  const scores = TRACE_DIMS.map(d => dimScore(dimensions[d.key])).filter((n): n is number => n != null)
  if (!scores.length) return null
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
}

export function mapSkill(raw: SkillHubSkillRaw, webBase: string, installed?: Set<string>): SkillCard | null {
  const slug = String(raw.slug || raw.namespace?.publicSlug || '').trim()
  if (!slug) return null
  const name = String(raw.name || raw.displayName || slug).trim()
  const description = String(raw.description_zh || raw.description || '').trim()
  const category = String(raw.category || '').trim()
  const id = String(raw.namespace?.canonicalName || `@${raw.ownerName || 'skill'}/${slug}`)
  const downloads = Number(raw.downloads ?? raw.stats?.downloads) || 0
  const stars = Number(raw.stars ?? raw.stats?.stars) || 0
  const installs = Number(raw.installs ?? raw.stats?.installs) || 0
  const card: SkillCard = {
    id,
    slug,
    name,
    description,
    category,
    categoryLabel: categoryLabel(category),
    version: String(raw.version || '').trim(),
    downloads,
    stars,
    installs,
    pageUrl: `${webBase.replace(/\/$/, '')}/skills/${encodeURIComponent(slug)}`,
    owner: raw.ownerName || raw.namespace?.handle,
    installed: installed?.has(slug) || false,
    isPaid: raw.labels?.pricing_type === 'paid' || raw.labels?.pricing_type === 'alipay' || Boolean(raw.channelPricing) || raw.category === 'pay-skill',
  }
  if (raw.iconUrl) card.iconUrl = String(raw.iconUrl)
  if (raw.publisher?.verified) {
    card.verified = true
    if (raw.publisher.name) card.publisherName = String(raw.publisher.name).trim()
  }
  if (raw.securityReports) {
    card.security = raw.securityReports
  }
  return card
}

export interface SearchOptions {
  cfg?: Partial<SkillHubConfig>
  category?: string
  sortBy?: SortBy
  limit?: number
  offset?: number
  page?: number
  pageSize?: number
  installed?: Set<string>
  signal?: AbortSignal
  fetchJsonImpl?: <T>(url: string, opts: FetchOptions, signal?: AbortSignal) => Promise<T>
}

export async function searchSkills(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const cfg: SkillHubConfig = { ...DEFAULT_CONFIG, ...(options.cfg || {}) }
  const fetchImpl = options.fetchJsonImpl || defaultFetchJson
  const category = parseCategory(options.category)
  const sortBy: SortBy = options.sortBy || (query ? 'score' : 'downloads')
  const page = options.page || (options.offset ? Math.floor(options.offset / (options.limit || cfg.maxResults)) + 1 : 1)
  const pageSize = options.pageSize || options.limit || cfg.maxResults

  const params = new URLSearchParams()
  if (query.trim()) params.set('keyword', query.trim())
  if (category) params.set('category', category)
  params.set('sortBy', sortBy)
  params.set('order', 'desc')
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))

  const url = `${cfg.apiBase.replace(/\/$/, '')}/api/skills?${params.toString()}`
  const body = await fetchImpl<SkillHubListResponse>(url, fetchOpts(cfg), options.signal)

  if (body.code !== 0 || !body.data) {
    throw new Error(body.message || 'SkillHub API 返回错误')
  }

  const items: SkillCard[] = []
  for (const raw of body.data.skills || []) {
    const card = mapSkill(raw, cfg.webBase, options.installed)
    if (card) items.push(card)
  }

  const total = Number(body.data.total) || items.length
  const offset = (page - 1) * pageSize

  return {
    query,
    category,
    sortBy,
    items,
    total,
    offset,
    hasMore: offset + items.length < total,
  }
}

export interface DetailOptions {
  cfg?: Partial<SkillHubConfig>
  installed?: Set<string>
  signal?: AbortSignal
  fetchJsonImpl?: <T>(url: string, opts: FetchOptions, signal?: AbortSignal) => Promise<T>
  fetchTextImpl?: (url: string, opts: FetchOptions, signal?: AbortSignal) => Promise<string>
}

export async function fetchSkillDetail(slug: string, options: DetailOptions = {}): Promise<MarketSkillDetail> {
  const id = parseSlug(slug)
  const cfg: SkillHubConfig = { ...DEFAULT_CONFIG, ...(options.cfg || {}) }
  const fetchJson = options.fetchJsonImpl || defaultFetchJson
  const fetchText = options.fetchTextImpl || defaultFetchText
  const opts = fetchOpts(cfg)

  const detailUrl = `${cfg.apiBase.replace(/\/$/, '')}/api/v1/skills/${encodeURIComponent(id)}`
  const rawDetail = await fetchJson<SkillHubDetailRaw>(detailUrl, opts, options.signal)

  const rawSkill: SkillHubSkillRaw = {
    ...(rawDetail.skill || {}),
    slug: rawDetail.slug || rawDetail.skill?.slug || id,
    version: rawDetail.latestVersion?.version || rawDetail.skill?.version,
    ownerName: rawDetail.owner?.handle || rawDetail.skill?.ownerName,
    publisher: rawDetail.publisher || rawDetail.skill?.publisher,
  }

  const card = mapSkill(rawSkill, cfg.webBase, options.installed) || {
    id: `@skill/${id}`,
    slug: id,
    name: id,
    description: '',
    category: '',
    categoryLabel: '',
    version: '',
    downloads: 0,
    stars: 0,
    installs: 0,
    pageUrl: `${cfg.webBase}/skills/${id}`,
  }

  // 并行获取 versions, evaluation, readme
  const versionsPromise = (async (): Promise<SkillVersionItem[]> => {
    try {
      const vUrl = `${cfg.apiBase.replace(/\/$/, '')}/api/v1/skills/${encodeURIComponent(id)}/versions`
      const data = await fetchJson<{ versions?: Array<{ version?: string; changelog?: string; createdAt?: number }> }>(vUrl, opts, options.signal)
      return (data.versions || []).slice(0, 30).map(v => ({
        version: String(v.version || ''),
        changelog: String(v.changelog || '').slice(0, 500),
        createdAt: Number(v.createdAt) || 0,
      }))
    } catch {
      return []
    }
  })()

  const evalPromise = (async (): Promise<TraceEvaluation | null> => {
    try {
      const eUrl = `${cfg.apiBase.replace(/\/$/, '')}/api/v1/skills/${encodeURIComponent(id)}/evaluation`
      const data = await fetchJson<{
        summary?: string
        userSummary?: string
        dimensions?: Record<string, { userReason?: string; items?: Record<string, { score?: number; userReason?: string }> }>
      }>(eUrl, opts, options.signal)

      const dimensions: Record<string, TraceDimensionScore> = {}
      for (const d of TRACE_DIMS) {
        const src = data.dimensions?.[d.key]
        if (!src) continue
        const items: Record<string, { score: number; userReason: string }> = {}
        for (const [k, it] of Object.entries(src.items || {})) {
          items[k] = { score: Number(it?.score) || 0, userReason: String(it?.userReason || '').slice(0, 300) }
        }
        dimensions[d.key] = {
          score: dimScore(src),
          userReason: String(src.userReason || '').slice(0, 1000),
          items,
        }
      }
      return {
        score: overallScore(data.dimensions),
        userSummary: String(data.userSummary || data.summary || '').slice(0, 1000),
        dimensions,
      }
    } catch {
      return null
    }
  })()

  const readmePromise = (async (): Promise<string | undefined> => {
    try {
      const rUrl = `${cfg.apiBase.replace(/\/$/, '')}/api/v1/skills/${encodeURIComponent(id)}/file?path=SKILL.md`
      return await fetchText(rUrl, opts, options.signal)
    } catch {
      return undefined
    }
  })()

  const [versions, evaluation, readme] = await Promise.all([versionsPromise, evalPromise, readmePromise])

  return {
    card,
    versions,
    evaluation,
    readme,
  }
}

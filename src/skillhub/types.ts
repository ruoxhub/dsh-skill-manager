export type SortBy = 'score' | 'downloads' | 'stars' | 'installs' | 'updated_at'

export interface FetchOptions {
  timeoutMs: number
  userAgent: string
}

export interface SkillHubConfig {
  apiBase: string
  webBase: string
  timeoutMs: number
  userAgent: string
  maxResults: number
  sortBy: SortBy
}

export type SecurityStatus = 'benign' | 'scanning' | 'suspicious' | 'malicious'

export interface SecurityReport {
  status: SecurityStatus
  statusText: string
  reportUrl?: string
}

export interface SecurityReports {
  keen?: SecurityReport
  sanbu?: SecurityReport
}

export interface SkillCard {
  id: string
  slug: string
  name: string
  description: string
  category: string
  categoryLabel: string
  version: string
  downloads: number
  stars: number
  installs: number
  iconUrl?: string
  pageUrl: string
  owner?: string
  installed?: boolean
  isPaid?: boolean
  rating?: number
  verified?: boolean
  publisherName?: string
  security?: SecurityReports
}

export interface SearchResult {
  query: string
  category?: string
  sortBy: SortBy
  items: SkillCard[]
  total: number
  offset: number
  hasMore: boolean
  fallback?: boolean
}

export interface SkillHubSkillRaw {
  slug?: string
  name?: string
  displayName?: string
  description?: string
  description_zh?: string
  summary?: string
  summary_zh?: string
  category?: string
  downloads?: number
  stars?: number
  installs?: number
  version?: string
  iconUrl?: string
  ownerName?: string
  publisher?: { verified?: boolean; name?: string }
  namespace?: { handle?: string; publicSlug?: string; canonicalName?: string }
  securityReports?: SecurityReports
  labels?: Record<string, string>
  channelPricing?: Record<string, unknown>
  stats?: { downloads?: number; stars?: number; installs?: number; versions?: number }
}

export interface SkillHubDetailRaw {
  slug?: string
  skill?: SkillHubSkillRaw
  latestVersion?: {
    version?: string
    changelog?: string
    createdAt?: number
  }
  owner?: {
    handle?: string
    displayName?: string
    image?: string | null
  }
  publisher?: { verified?: boolean; name?: string }
  namespace?: { handle?: string; publicSlug?: string; canonicalName?: string }
  securityReports?: SecurityReports
}

export interface SkillHubListResponse {
  code: number
  message?: string
  data?: {
    total: number
    skills?: SkillHubSkillRaw[]
  }
}

export interface TraceDimensionScore {
  score: number | null
  userReason: string
  items?: Record<string, { score: number; userReason: string }>
}

export interface TraceEvaluation {
  score: number | null
  userSummary: string
  dimensions: Record<string, TraceDimensionScore>
}

export interface SkillVersionItem {
  version: string
  changelog: string
  createdAt: number
}

export interface MarketSkillDetail {
  card: SkillCard
  readme?: string
  evaluation?: TraceEvaluation | null
  versions: SkillVersionItem[]
}

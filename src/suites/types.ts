export interface MarketplaceSourceConfig {
  name: string
  manifestName?: string
  source: string | { source?: string; path?: string; url?: string }
  type?: 'github' | 'git' | 'zip' | 'directory'
  installLocation: string
  description?: string
  isBuiltIn?: boolean
  lastUpdated?: string
  autoUpdate?: boolean
  manifest?: any
}

export type KnownMarketplacesConfig = Record<string, MarketplaceSourceConfig>

export interface SuitePluginAuthor {
  name?: string
  url?: string
  email?: string
}

export interface SuitePluginItem {
  name: string
  description?: string
  description_en?: string
  version?: string
  source?: string
  category?: string
  author?: SuitePluginAuthor
  homepage?: string
  repository?: string
  license?: string
  skills?: string[]
  installed?: boolean
  installedPath?: string
}

export interface SuiteMarketplaceDetail {
  name: string
  description?: string
  description_en?: string
  plugins: SuitePluginItem[]
  /**
   * Why this marketplace could not be listed (missing directory or manifest).
   * Present only on an empty, explained listing so the panel can tell the user
   * what to fix instead of showing a bare "no plugins" state.
   */
  unavailableReason?: string
}

export interface SuiteCommandItem {
  name: string
  description?: string
  argumentHint?: string
}

export interface SuiteSkillDetailItem {
  name: string
  description?: string
  whenToUse?: string
  path?: string
  content?: string
  modelInvocable?: boolean
  userInvocable?: boolean
}

export interface SuitePluginDetail extends SuitePluginItem {
  marketplaceName: string
  commands?: SuiteCommandItem[]
  skillItems?: SuiteSkillDetailItem[]
  mcpServers?: string[]
  hooks?: string[]
}

export interface GetSuitePluginDetailOptions {
  marketplaceName: string
  pluginName: string
  agentsHome: string
}

export interface InstallSuitePluginOptions {
  marketplaceName: string
  pluginName: string
  targetRoot?: 'user' | 'project'
  workspacePath?: string
  agentsHome: string
}

export interface InstallSuitePluginResult {
  ok: true
  name: string
  installedSkills: string[]
  targetDir: string
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureInitialized,
  getMarketplacesJsonPath,
  getMarketplacesDirPath,
  getUserSkillsDirPath,
  getProjectSkillsDirPath,
  listMarketplaces,
  getMarketplaceDetail,
  getSuitePluginDetail,
  addMarketplace,
  installSuitePlugin,
  refreshMarketplace,
  removeMarketplace,
} from '../src/suites/manager.ts'
import { makeRoutes, ROUTES } from '../src/routes.ts'
import { buildZip } from './zip-builder.ts'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

describe('suites manager', () => {
  let tempDir: string
  let agentsHome: string
  let workspaceDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-suites-test-'))
    agentsHome = join(tempDir, '.agents')
    workspaceDir = join(tempDir, 'project')
    mkdirSync(agentsHome, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('computes correct paths', () => {
    expect(getMarketplacesJsonPath(agentsHome)).toBe(join(agentsHome, 'plugins', 'known_marketplaces.json'))
    expect(getMarketplacesDirPath(agentsHome)).toBe(join(agentsHome, 'plugins', 'marketplaces'))
    expect(getUserSkillsDirPath(agentsHome)).toBe(join(agentsHome, 'skills'))
    expect(getProjectSkillsDirPath(workspaceDir)).toBe(join(workspaceDir, '.agents', 'skills'))
  })

  it('initializes marketplaces.json when not present', () => {
    const config = ensureInitialized(agentsHome)
    expect(existsSync(getMarketplacesJsonPath(agentsHome))).toBe(true)
    expect(existsSync(getMarketplacesDirPath(agentsHome))).toBe(true)
    expect(typeof config).toBe('object')
  })

  it('lists marketplaces and gets marketplace detail', async () => {
    // Setup a dummy marketplace
    const mpDir = join(getMarketplacesDirPath(agentsHome), 'test-mp')
    mkdirSync(join(mpDir, '.codebuddy-plugin'), { recursive: true })

    const pluginDir = join(mpDir, 'plugins', 'sample-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'SKILL.md'), '# Sample Plugin Skill\n', 'utf8')

    const manifest = {
      name: 'test-mp',
      description: 'Test marketplace description',
      plugins: [
        {
          name: 'sample-plugin',
          description: 'A great sample plugin',
          version: '1.0.0',
          source: './plugins/sample-plugin',
        },
        {
          name: 'other-plugin',
          description: 'Other description',
          version: '0.1.0',
        },
      ],
    }
    writeFileSync(join(mpDir, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify(manifest, null, 2), 'utf8')

    // Add into config
    const configPath = getMarketplacesJsonPath(agentsHome)
    mkdirSync(join(agentsHome, 'plugins'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        'test-mp': {
          name: 'test-mp',
          source: './test-mp',
          installLocation: mpDir,
          description: 'Test marketplace description',
        },
      }),
      'utf8',
    )

    const list = listMarketplaces(agentsHome)
    expect(list.length).toBe(1)
    expect(list[0].name).toBe('test-mp')

    const detail = getMarketplaceDetail(agentsHome, 'test-mp')
    expect(detail.name).toBe('test-mp')
    expect(detail.plugins.length).toBe(2)
    expect(detail.plugins[0].name).toBe('sample-plugin')
    expect(detail.plugins[0].installed).toBe(false)

    // Filter by query
    const filtered = getMarketplaceDetail(agentsHome, 'test-mp', { query: 'great' })
    expect(filtered.plugins.length).toBe(1)
    expect(filtered.plugins[0].name).toBe('sample-plugin')
  })

  it('installs suite plugin into user skills directory (~/.agents/skills)', () => {
    const mpDir = join(getMarketplacesDirPath(agentsHome), 'test-mp')
    const pluginDir = join(mpDir, 'plugins', 'sample-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'SKILL.md'), '# Sample Plugin Skill\n', 'utf8')

    const manifest = {
      name: 'test-mp',
      plugins: [
        {
          name: 'sample-plugin',
          source: './plugins/sample-plugin',
        },
      ],
    }
    mkdirSync(join(mpDir, '.codebuddy-plugin'), { recursive: true })
    writeFileSync(join(mpDir, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify(manifest), 'utf8')

    const res = installSuitePlugin({
      agentsHome,
      marketplaceName: 'test-mp',
      pluginName: 'sample-plugin',
      targetRoot: 'user',
    })

    expect(res.ok).toBe(true)
    expect(res.installedSkills).toContain('sample-plugin')
    const userSkillPath = join(agentsHome, 'skills', 'sample-plugin', 'SKILL.md')
    expect(existsSync(userSkillPath)).toBe(true)
    expect(readFileSync(userSkillPath, 'utf8')).toContain('# Sample Plugin Skill')

    // Checking detail should now show installed: true
    const detail = getMarketplaceDetail(agentsHome, 'test-mp')
    expect(detail.plugins[0].installed).toBe(true)
  })

  it('installs suite plugin into project skills directory (<project>/.agents/skills)', () => {
    const mpDir = join(getMarketplacesDirPath(agentsHome), 'test-mp')
    const pluginDir = join(mpDir, 'plugins', 'sample-plugin')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'SKILL.md'), '# Project Scope Skill\n', 'utf8')

    const manifest = {
      name: 'test-mp',
      plugins: [
        {
          name: 'sample-plugin',
          source: './plugins/sample-plugin',
        },
      ],
    }
    mkdirSync(join(mpDir, '.codebuddy-plugin'), { recursive: true })
    writeFileSync(join(mpDir, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify(manifest), 'utf8')

    const res = installSuitePlugin({
      agentsHome,
      marketplaceName: 'test-mp',
      pluginName: 'sample-plugin',
      targetRoot: 'project',
      workspacePath: workspaceDir,
    })

    expect(res.ok).toBe(true)
    const projectSkillPath = join(workspaceDir, '.agents', 'skills', 'sample-plugin', 'SKILL.md')
    expect(existsSync(projectSkillPath)).toBe(true)
    expect(readFileSync(projectSkillPath, 'utf8')).toContain('# Project Scope Skill')
  })

  it('adds a local directory as a marketplace', async () => {
    const localMp = join(tempDir, 'my-local-mp')
    mkdirSync(localMp, { recursive: true })
    writeFileSync(
      join(localMp, 'marketplace.json'),
      JSON.stringify({
        name: 'my-custom-marketplace',
        description: 'Custom local description',
        plugins: [],
      }),
      'utf8',
    )

    const added = await addMarketplace(agentsHome, localMp)
    expect(added.name).toBe('my-custom-marketplace')
    expect(added.type).toBe('directory')

    const list = listMarketplaces(agentsHome)
    expect(list.some(m => m.name === 'my-custom-marketplace')).toBe(true)
  })

  it('handles suites routes correctly', async () => {
    const deps = {
      dshHome: join(tempDir, 'dsh'),
      agentsHome,
      customSkillDirs: [],
      registry: { snapshot: async () => ({ skills: [], complete: true }) },
      activeSessionCwds: () => [workspaceDir],
      logger: { warn: () => {} },
    }
    const routes = makeRoutes({} as never, deps)

    const routeList = routes.find(r => r.path === ROUTES.suitesMarketplaces)
    expect(routeList).toBeDefined()

    const state = { status: 0, body: '' }
    const res = {
      writeHead(status: number) { state.status = status },
      end(body: string) { state.body = body },
    } as unknown as ServerResponse

    const req = {
      url: ROUTES.suitesMarketplaces,
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:3080' },
    } as unknown as IncomingMessage

    await routeList!.handler(req, res)
    expect(state.status).toBe(200)
    const json = JSON.parse(state.body)
    expect(json.ok).toBe(true)
    expect(Array.isArray(json.marketplaces)).toBe(true)
  })

  it('gets suite plugin detail with commands, skills, mcpServers and hooks', () => {
    const mpDir = join(getMarketplacesDirPath(agentsHome), 'test-mp')
    mkdirSync(join(mpDir, '.codebuddy-plugin'), { recursive: true })

    const pluginDir = join(mpDir, 'plugins', 'my-rich-plugin')
    mkdirSync(join(pluginDir, 'commands'), { recursive: true })
    mkdirSync(join(pluginDir, 'skills', 'skill-alpha'), { recursive: true })
    mkdirSync(join(pluginDir, '.codebuddy-plugin'), { recursive: true })

    // Command
    writeFileSync(
      join(pluginDir, 'commands', 'deploy.md'),
      '---\ndescription: "Deploy the service"\n---\n# Deploy\n',
      'utf8',
    )
    // Skill
    writeFileSync(
      join(pluginDir, 'skills', 'skill-alpha', 'SKILL.md'),
      '---\nname: skill-alpha\ndescription: "Alpha skill description"\n---\n# Alpha\n',
      'utf8',
    )
    // plugin.json with MCP and Hooks
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'sample-server': {} } }),
      'utf8',
    )
    writeFileSync(
      join(pluginDir, '.codebuddy-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'my-rich-plugin',
        mcpServers: './.mcp.json',
        hooks: './hooks/hooks.json',
      }),
      'utf8',
    )

    // Marketplace manifest
    writeFileSync(
      join(mpDir, '.codebuddy-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test-mp',
        plugins: [
          {
            name: 'my-rich-plugin',
            description: 'A rich plugin with commands and skills',
            source: './plugins/my-rich-plugin',
          },
        ],
      }),
      'utf8',
    )

    const detail = getSuitePluginDetail({
      marketplaceName: 'test-mp',
      pluginName: 'my-rich-plugin',
      agentsHome,
    })

    expect(detail.name).toBe('my-rich-plugin')
    expect(detail.commands).toHaveLength(1)
    expect(detail.commands![0].name).toBe('/deploy')
    expect(detail.commands![0].description).toBe('Deploy the service')

    expect(detail.skillItems).toHaveLength(1)
    expect(detail.skillItems![0].name).toBe('skill-alpha')
    expect(detail.skillItems![0].description).toBe('Alpha skill description')
    expect(detail.skillItems![0].content).toBe('# Alpha')
    expect(detail.skillItems![0].path).toBeDefined()
    expect(detail.skillItems![0].modelInvocable).toBe(true)
    expect(detail.skillItems![0].userInvocable).toBe(true)

    expect(detail.mcpServers).toEqual(['sample-server'])
    expect(detail.hooks).toEqual(['hooks.json'])
  })

  /**
   * CodeBuddy / WorkBuddy / Claude write a known_marketplaces.json whose
   * entries carry `manifestName` but no `name`. The panel serves those records
   * to the browser and then addresses them again by the served name, so a
   * missing `name` made the client post `marketplace: undefined` and the
   * install route answered 400 (surfaced as installation failed, HTTP 404).
   * These cases pin the whole round trip: list -> detail -> install.
   */
  describe('known_marketplaces.json written by an external tool', () => {
    const MP_NAME = 'codebuddy-plugins-official'

    beforeEach(() => {
      const mpDir = join(getMarketplacesDirPath(agentsHome), MP_NAME)
      mkdirSync(join(mpDir, '.codebuddy-plugin'), { recursive: true })
      const skillDir = join(mpDir, 'plugins', 'find-skills', 'skills', 'find-skills')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: find-skills\n---\n# find-skills\n', 'utf8')
      writeFileSync(
        join(mpDir, '.codebuddy-plugin', 'marketplace.json'),
        JSON.stringify({
          name: MP_NAME,
          description: 'CodeBuddy official marketplace',
          plugins: [{ name: 'find-skills', source: './plugins/find-skills' }],
        }),
        'utf8',
      )
      writeFileSync(
        join(getMarketplacesJsonPath(agentsHome)),
        JSON.stringify({
          [MP_NAME]: {
            manifestName: MP_NAME,
            type: 'zip',
            source: { source: 'zip', url: 'https://example.invalid/marketplace.zip' },
            installLocation: mpDir,
            autoUpdate: true,
            isBuiltIn: true,
          },
        }),
        'utf8',
      )
    })

    it('lists every marketplace with a usable name and manifestName', () => {
      const list = listMarketplaces(agentsHome)
      expect(list).toHaveLength(1)
      expect(list[0].name).toBe(MP_NAME)
      expect(list[0].manifestName).toBe(MP_NAME)
    })

    it('resolves detail by the name the list route served', () => {
      const servedName = listMarketplaces(agentsHome)[0].name
      const detail = getMarketplaceDetail(agentsHome, servedName)
      expect(detail.plugins.map(p => p.name)).toEqual(['find-skills'])
    })

    it('resolves detail by the manifestName alias too', () => {
      const detail = getMarketplaceDetail(agentsHome, MP_NAME)
      expect(detail.plugins).toHaveLength(1)
    })

    it('installs through the route using the served marketplace name', async () => {
      const routes = makeRoutes({ get: () => undefined } as never, {
        dshHome: join(tempDir, 'dsh'),
        agentsHome,
        customSkillDirs: [],
        registry: { snapshot: async () => ({ skills: [], complete: true }) },
        activeSessionCwds: () => [],
        logger: { warn: () => {} },
      })
      const listState = { status: 0, body: '' }
      await routes.find(r => r.path === ROUTES.suitesMarketplaces)!.handler(
        {
          url: ROUTES.suitesMarketplaces,
          method: 'GET',
          socket: { remoteAddress: '127.0.0.1' },
          headers: { host: 'localhost:3080' },
        } as unknown as IncomingMessage,
        {
          writeHead(status: number) { listState.status = status },
          end(body: string) { listState.body = body },
        } as unknown as ServerResponse,
      )
      expect(listState.status).toBe(200)
      const servedName = JSON.parse(listState.body).marketplaces[0].name
      expect(servedName).toBe(MP_NAME)

      const result = installSuitePlugin({
        agentsHome,
        marketplaceName: servedName,
        pluginName: 'find-skills',
        targetRoot: 'user',
      })
      expect(result.installedSkills).toEqual(['find-skills'])
      expect(existsSync(join(agentsHome, 'skills', 'find-skills', 'SKILL.md'))).toBe(true)
    })

    it('removes and refreshes by the served name without touching other keys', async () => {
      await refreshMarketplace(agentsHome, MP_NAME)
      expect(listMarketplaces(agentsHome)).toHaveLength(1)

      removeMarketplace(agentsHome, MP_NAME)
      expect(listMarketplaces(agentsHome)).toEqual([])
    })
  })
})

/**
 * Regression tests for the suite-marketplace "add" and "install" features.
 *
 * Three defects were reported against the panel's 套件 (suite) tab, all
 * reproduced with real marketplace manifests:
 *
 * 1. A plugin whose manifest `source` is an OBJECT (`{source:'url',url:...}`,
 *    what the real superpowers-marketplace ships) crashed install with
 *    `The "paths[1]" argument must be of type string`.
 * 2. Adding a `.zip` marketplace shelled out to `powershell`, which is absent
 *    from PATH on hosts that only ship PowerShell 7 (`pwsh`), so the add route
 *    answered 500 `spawn powershell ENOENT`.
 * 3. A marketplace record whose `installLocation` is missing made the plugins
 *    route answer 500 instead of an actionable, empty listing.
 */
describe('suites: object-shaped plugin source', () => {
  let tempDir: string
  let agentsHome: string
  let mpDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-suites-srcobj-'))
    agentsHome = join(tempDir, '.agents')
    mpDir = join(agentsHome, 'plugins', 'marketplaces', 'sp-marketplace')
    mkdirSync(join(mpDir, '.claude-plugin'), { recursive: true })
    // The real superpowers-marketplace shape: `source` is an object, and the
    // plugin content is NOT vendored under the marketplace directory.
    writeFileSync(join(mpDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'sp-marketplace',
      plugins: [
        {
          name: 'superpowers',
          description: 'Core skills library',
          version: '7.0.1',
          source: { source: 'url', url: 'https://github.com/obra/superpowers.git' },
        },
      ],
    }), 'utf8')
    writeFileSync(join(agentsHome, 'plugins', 'known_marketplaces.json'), JSON.stringify({
      'sp-marketplace': { name: 'sp-marketplace', manifestName: 'sp-marketplace', type: 'git', installLocation: mpDir },
    }), 'utf8')
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* Ignore */ }
  })

  it('lists the plugin without stringifying the source object into "[object Object]"', () => {
    const detail = getMarketplaceDetail(agentsHome, 'sp-marketplace', { targetRoot: 'user' })
    expect(detail.plugins).toHaveLength(1)
    expect(detail.plugins[0].name).toBe('superpowers')
    // A remote plugin has no local directory; `source` must stay a URL, never
    // the "[object Object]" a bare String() coercion produced.
    expect(detail.plugins[0].source).toBe('https://github.com/obra/superpowers.git')
  })

  it('reports a plugin whose content is not vendored locally instead of crashing on resolve()', () => {
    expect(() => installSuitePlugin({
      agentsHome,
      marketplaceName: 'sp-marketplace',
      pluginName: 'superpowers',
      targetRoot: 'user',
    })).toThrow(/not available locally/i)
  })

  it('reports the plugin detail without a String(object) source', () => {
    const detail = getSuitePluginDetail({
      agentsHome,
      marketplaceName: 'sp-marketplace',
      pluginName: 'superpowers',
    })
    expect(detail.source).toBe('https://github.com/obra/superpowers.git')
  })
})

describe('suites: real-world object-source manifest (superpowers-marketplace shape)', () => {
  let tempDir: string
  let agentsHome: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-suites-realsp-'))
    agentsHome = join(tempDir, '.agents')
    const mpDir = join(agentsHome, 'plugins', 'marketplaces', 'superpowers-marketplace')
    mkdirSync(join(mpDir, '.claude-plugin'), { recursive: true })
    // Trimmed copy of the published manifest: plugins are remote repos, not
    // vendored folders, and `source` is an object.
    writeFileSync(join(mpDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'superpowers-marketplace',
      metadata: { description: 'Skills, workflows, and productivity tools', version: '1.0.13' },
      plugins: [
        {
          name: 'superpowers',
          source: { source: 'url', url: 'https://github.com/obra/superpowers.git' },
          description: 'Core skills library',
          version: '7.0.1',
        },
        {
          name: 'elements-of-style',
          source: { source: 'url', url: 'https://github.com/obra/elements-of-style.git' },
          description: 'Writing style guide',
        },
      ],
    }), 'utf8')
    writeFileSync(join(agentsHome, 'plugins', 'known_marketplaces.json'), JSON.stringify({
      'superpowers-marketplace': {
        name: 'superpowers-marketplace',
        manifestName: 'superpowers-marketplace',
        type: 'zip',
        installLocation: mpDir,
      },
    }), 'utf8')
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* Ignore */ }
  })

  it('lists every plugin with a real URL source and never "[object Object]"', () => {
    const detail = getMarketplaceDetail(agentsHome, 'superpowers-marketplace', { targetRoot: 'user' })
    expect(detail.plugins.map(p => p.name)).toEqual(['superpowers', 'elements-of-style'])
    for (const plugin of detail.plugins) {
      expect(plugin.source).toBeDefined()
      expect(plugin.source).not.toContain('object Object')
      expect(plugin.source).toMatch(/^https:\/\/github\.com\//)
    }
  })

  it('names the remote source when a plugin cannot be installed locally', () => {
    expect(() => installSuitePlugin({
      agentsHome,
      marketplaceName: 'superpowers-marketplace',
      pluginName: 'superpowers',
      targetRoot: 'user',
    })).toThrow(/not available locally.*https:\/\/github\.com\/obra\/superpowers\.git/)
  })
})

describe('suites: marketplace with a missing installLocation', () => {
  let tempDir: string
  let agentsHome: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-suites-missing-'))
    agentsHome = join(tempDir, '.agents')
    mkdirSync(join(agentsHome, 'plugins', 'marketplaces'), { recursive: true })
    // A record another tool left behind whose directory was never materialized.
    writeFileSync(join(agentsHome, 'plugins', 'known_marketplaces.json'), JSON.stringify({
      'gone-marketplace': {
        name: 'gone-marketplace',
        manifestName: 'gone-marketplace',
        type: 'directory',
        installLocation: join(agentsHome, 'plugins', 'marketplaces', 'gone-marketplace'),
      },
    }), 'utf8')
  })

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* Ignore */ }
  })

  it('answers the plugins route with an empty listing and a reason, not a 500', async () => {
    const routes = makeRoutes({} as never, {
      dshHome: join(tempDir, 'dsh'),
      agentsHome,
      customSkillDirs: [],
      registry: { snapshot: async () => ({ skills: [], complete: true }) },
      activeSessionCwds: () => [],
      logger: { warn: () => {} },
    })
    const route = routes.find(r => r.path === ROUTES.suitesPlugins)!
    const state = { status: 0, body: '' }
    await route.handler(
      {
        url: `${ROUTES.suitesPlugins}?marketplace=gone-marketplace&root=user`,
        method: 'GET',
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:3080' },
      } as unknown as IncomingMessage,
      {
        writeHead(status: number) { state.status = status },
        end(body: string) { state.body = body },
      } as unknown as ServerResponse,
    )
    expect(state.status).toBe(200)
    const payload = JSON.parse(state.body)
    expect(payload.plugins).toEqual([])
    // The panel can surface this to the user instead of an opaque spinner.
    expect(payload.unavailableReason).toMatch(/not found/i)
  })
})

describe('suites: adding a .zip marketplace without a system unzip binary', () => {
  let tempDir: string
  let agentsHome: string
  let server: import('node:http').Server
  let baseUrl: string

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-suites-zip-'))
    agentsHome = join(tempDir, '.agents')
    mkdirSync(join(agentsHome, 'plugins'), { recursive: true })

    // A release-style archive: content wrapped in one top-level folder.
    const archive = buildZip([
      { path: 'demo-main/.claude-plugin/marketplace.json', content: JSON.stringify({ name: 'zip-demo', plugins: [{ name: 'zip-plugin' }] }) },
      { path: 'demo-main/plugins/zip-plugin/SKILL.md', content: '---\nname: zip-plugin\ndescription: from a zip\n---\n' },
    ])
    server = createServer((req, res) => {
      if (req.url === '/demo.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' })
        res.end(archive)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', () => done()))
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(() => {
    server.close()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* Ignore */ }
  })

  it('extracts in-process, strips the wrapper folder and lists the plugins', async () => {
    const added = await addMarketplace(agentsHome, `${baseUrl}/demo.zip`)
    expect(added.name).toBe('zip-demo')

    // The manifest must land where findMarketplaceManifestPath looks.
    expect(existsSync(join(added.installLocation, '.claude-plugin', 'marketplace.json'))).toBe(true)

    const detail = getMarketplaceDetail(agentsHome, 'zip-demo', { targetRoot: 'user' })
    expect(detail.plugins.map(p => p.name)).toEqual(['zip-plugin'])
  })

  it('never writes an archive entry outside the marketplace directory', async () => {
    const hostile = buildZip([
      { path: 'demo/.claude-plugin/marketplace.json', content: '{"name":"evil","plugins":[]}' },
      { path: '../../escaped.txt', content: 'pwned' },
      { path: '/abs-escaped.txt', content: 'pwned' },
    ])
    server.close()
    const hostileServer = createServer((_req, res) => { res.writeHead(200); res.end(hostile) })
    await new Promise<void>(done => hostileServer.listen(0, '127.0.0.1', () => done()))
    const port = (hostileServer.address() as { port: number }).port
    try {
      // The reader drops traversal entries rather than rejecting the archive,
      // so the add still succeeds — but nothing may land outside the target.
      await addMarketplace(agentsHome, `http://127.0.0.1:${port}/evil.zip`)
      expect(existsSync(join(tempDir, 'escaped.txt'))).toBe(false)
      expect(existsSync(join(agentsHome, 'plugins', 'marketplaces', 'escaped.txt'))).toBe(false)
    } finally {
      hostileServer.close()
    }
  })
})

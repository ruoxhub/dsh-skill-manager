import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { DEFAULT_CONFIG, fetchOpts, parseSlug } from './client.ts'
import type { FetchOptions, SkillHubConfig } from './types.ts'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

export interface MarketInstallResult {
  slug: string
  name: string
  version: string
  path: string
  files: number
}

export interface InstallMarketOptions {
  targetRoot: string
  version?: string
  cfg?: Partial<SkillHubConfig>
  signal?: AbortSignal
  fetchBytesImpl?: (url: string, opts: FetchOptions, signal?: AbortSignal) => Promise<{ body: Buffer; contentType: string }>
}

export function safeRelPath(raw: string): string {
  const path = String(raw || '').replace(/\\/g, '/')
  if (!path) throw new Error('空路径')
  if (path.startsWith('/') || /(?:^|\/)\.\.(?:\/|$)/.test(path) || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`拒绝路径穿越: 不安全路径 ${raw}`)
  }
  return path
}

export function resolveSkillTargetDir(skillsDir: string, slug: string): string {
  const root = resolve(skillsDir)
  const target = resolve(root, parseSlug(slug))
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('拒绝路径穿越')
  }
  return target
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

function readEntry(buf: Buffer, localOff: number, method: number, compSize: number, name: string): Buffer {
  if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL_SIG) {
    throw new Error(`损坏的 zip 条目: ${name}`)
  }
  const nLen = buf.readUInt16LE(localOff + 26)
  const exLen = buf.readUInt16LE(localOff + 28)
  const dataOff = localOff + 30 + nLen + exLen
  if (dataOff + compSize > buf.length) throw new Error(`截断的 zip 数据: ${name}`)
  const raw = buf.subarray(dataOff, dataOff + compSize)
  if (method === 0) return raw
  if (method === 8) return inflateRawSync(raw)
  throw new Error(`不支持的压缩方式: ${method}`)
}

export function unzipToFiles(buf: Buffer): Record<string, Buffer> {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip 包: 缺少 EOCD 记录')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out: Record<string, Buffer> = {}
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('不是有效的 zip 包: 损坏的 Central Directory')
    }
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOff = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
    if (!name || name.endsWith('/')) continue
    out[name] = readEntry(buf, localOff, method, compSize, name)
  }
  return out
}

export async function defaultFetchBytes(url: string, opts: FetchOptions, signal?: AbortSignal): Promise<{ body: Buffer; contentType: string }> {
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
    const arrayBuffer = await res.arrayBuffer()
    return {
      body: Buffer.from(arrayBuffer),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function installMarketSkill(slug: string, options: InstallMarketOptions): Promise<MarketInstallResult> {
  const id = parseSlug(slug)
  const cfg: SkillHubConfig = { ...DEFAULT_CONFIG, ...(options.cfg || {}) }
  const fetchBytes = options.fetchBytesImpl || defaultFetchBytes
  const ver = options.version?.trim() || ''

  const zipUrl = `${cfg.apiBase.replace(/\/$/, '')}/api/v1/download?slug=${encodeURIComponent(id)}${ver ? `&version=${encodeURIComponent(ver)}` : ''}&source=dsh`
  const { body } = await fetchBytes(zipUrl, fetchOpts(cfg), options.signal)

  if (body.subarray(0, 2).toString() !== 'PK') {
    throw new Error(`SkillHub download 不是 zip 包: ${id}`)
  }

  const rawFiles = unzipToFiles(body)
  const cleanFiles: Record<string, Buffer> = {}

  // 规范化文件相对路径并防范路径穿越
  for (const [rawPath, content] of Object.entries(rawFiles)) {
    const clean = safeRelPath(rawPath)
    cleanFiles[clean] = content
  }

  // 检查根目录或顶层目录是否包含 SKILL.md
  // 有些 zip 会有一层顶层目录，如 my-skill/SKILL.md
  let skillMdPath = 'SKILL.md'
  if (!cleanFiles[skillMdPath]) {
    const found = Object.keys(cleanFiles).find(p => p.endsWith('/SKILL.md') && p.split('/').length === 2)
    if (found) {
      // 去除顶层目录前缀
      const prefix = found.split('/')[0] + '/'
      const unwrapped: Record<string, Buffer> = {}
      for (const [k, v] of Object.entries(cleanFiles)) {
        if (k.startsWith(prefix)) {
          unwrapped[k.slice(prefix.length)] = v
        }
      }
      Object.assign(cleanFiles, unwrapped)
    }
  }

  if (!cleanFiles['SKILL.md']) {
    throw new Error(`技能 ${id} 缺少 SKILL.md`)
  }

  // 提取 SKILL.md 中的 name 字段作为展示名称，回退到 id
  const skillMdContent = cleanFiles['SKILL.md'].toString('utf8')
  const nameMatch = skillMdContent.match(/^[ \t]*name:[ \t]*([^\r\n]+)/im)
  const skillName = nameMatch ? nameMatch[1].trim() : id

  const targetDir = resolveSkillTargetDir(options.targetRoot, id)
  await mkdir(targetDir, { recursive: true })

  let fileCount = 0
  for (const [relPath, content] of Object.entries(cleanFiles)) {
    if (!relPath || relPath.endsWith('/')) continue
    const fullPath = join(targetDir, relPath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content)
    fileCount++
  }

  return {
    slug: id,
    name: skillName,
    version: ver || 'latest',
    path: targetDir,
    files: fileCount,
  }
}

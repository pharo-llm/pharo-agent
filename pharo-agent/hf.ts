import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { AgentConfig } from './types.ts'
import { ensureDir, pathExists } from './platform.ts'
import { modelCacheDir } from './config.ts'

export type GgufFile = {
  repoId: string
  filename: string
  size?: number
  quant?: string
}

const preferredQuants = ['Q4_K_M', 'Q4_0', 'Q5_K_M', 'Q4_K_S', 'Q6_K', 'Q8_0', 'Q3_K_M', 'Q2_K']

export class HuggingFaceError extends Error {}

export function hfToken(): string | undefined {
  return process.env.HF_TOKEN ?? process.env.HUGGINGFACE_HUB_TOKEN
}

export async function listGgufFiles(repoId: string, token = hfToken()): Promise<GgufFile[]> {
  const response = await hfFetch(`https://huggingface.co/api/models/${encodeRepo(repoId)}`, token)
  const data = await response.json() as { siblings?: { rfilename?: string; size?: number; lfs?: { size?: number } }[] }
  const siblings = Array.isArray(data.siblings) ? data.siblings : []
  return siblings
    .filter(item => typeof item.rfilename === 'string' && item.rfilename.toLowerCase().endsWith('.gguf'))
    .map(item => ({
      repoId,
      filename: item.rfilename!,
      size: item.size ?? item.lfs?.size,
      quant: detectQuant(item.rfilename!),
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename))
}

export async function listOrgModels(org: string, token = hfToken()): Promise<string[]> {
  const response = await hfFetch(`https://huggingface.co/api/models?author=${encodeURIComponent(org)}&limit=100&full=false`, token)
  const data = await response.json() as { id?: string }[]
  return data.filter(item => typeof item.id === 'string').map(item => item.id!)
}

export function resolveModelRef(ref: string | undefined, defaultRepo: string): { repoId: string; selector?: string } {
  if (!ref) return { repoId: defaultRepo }
  const normalized = ref.startsWith('hf:') ? ref.slice(3) : ref
  const splitIndex = normalized.indexOf(':')
  if (splitIndex >= 0) {
    return { repoId: normalized.slice(0, splitIndex), selector: normalized.slice(splitIndex + 1) }
  }
  if (normalized.endsWith('.gguf') || preferredQuants.includes(normalized.toUpperCase())) {
    return { repoId: defaultRepo, selector: normalized }
  }
  if (normalized.includes('/')) return { repoId: normalized }
  return { repoId: defaultRepo, selector: normalized }
}

export async function selectGguf(repoId: string, selector?: string): Promise<GgufFile> {
  const files = await listGgufFiles(repoId)
  if (files.length === 0) throw new HuggingFaceError(`No .gguf files found in ${repoId}`)
  if (selector) {
    const exact = files.find(file => file.filename === selector)
    if (exact) return exact
    const upper = selector.toUpperCase()
    const quant = files.find(file => file.filename.toUpperCase().includes(upper))
    if (quant) return quant
    throw new HuggingFaceError(`No GGUF file matching ${selector} found in ${repoId}`)
  }
  return choosePreferred(files)
}

export function choosePreferred(files: GgufFile[]): GgufFile {
  for (const quant of preferredQuants) {
    const match = files.find(file => file.filename.toUpperCase().includes(quant))
    if (match) return match
  }
  return [...files].sort((a, b) => (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER))[0]!
}

export async function downloadGguf(file: GgufFile, config: AgentConfig, options: { force?: boolean } = {}): Promise<string> {
  const target = cachePath(file, config)
  if (!options.force && await pathExists(target)) return target
  await ensureDir(path.dirname(target))
  const tmp = `${target}.part`
  const url = `https://huggingface.co/${encodeRepo(file.repoId)}/resolve/main/${encodeFilename(file.filename)}?download=true`
  const response = await hfFetch(url)
  if (!response.body) throw new HuggingFaceError(`Download response for ${file.filename} had no body`)
  await pipeline(response.body, createWriteStream(tmp))
  await import('node:fs/promises').then(fs => fs.rename(tmp, target))
  return target
}

export type GgufDownloadSet = {
  primary: string
  files: { file: GgufFile; path: string }[]
}

export async function downloadGgufSet(file: GgufFile, config: AgentConfig, options: { force?: boolean } = {}): Promise<GgufDownloadSet> {
  const files = await resolveGgufShardSet(file)
  const downloaded: { file: GgufFile; path: string }[] = []
  for (const shard of files) {
    downloaded.push({ file: shard, path: await downloadGguf(shard, config, options) })
  }
  return { primary: downloaded[0]!.path, files: downloaded }
}

export async function resolveGgufShardSet(file: GgufFile): Promise<GgufFile[]> {
  const split = splitGgufFilename(file.filename)
  if (!split || split.total <= 1) return [file]
  const files = await listGgufFiles(file.repoId)
  const shards: GgufFile[] = []
  for (let index = 1; index <= split.total; index += 1) {
    const filename = `${split.prefix}${String(index).padStart(split.indexWidth, '0')}-of-${split.totalText}.gguf`
    const shard = files.find(candidate => candidate.filename === filename)
    if (!shard) throw new HuggingFaceError(`Missing GGUF shard ${filename} in ${file.repoId}`)
    shards.push(shard)
  }
  return shards
}

export function splitGgufFilename(filename: string): { prefix: string; index: number; indexWidth: number; total: number; totalText: string } | undefined {
  const match = filename.match(/^(.*-)(\d+)-of-(\d+)\.gguf$/i)
  if (!match) return undefined
  return {
    prefix: match[1]!,
    index: Number(match[2]),
    indexWidth: match[2]!.length,
    total: Number(match[3]),
    totalText: match[3]!,
  }
}

export function cachePath(file: GgufFile, config: AgentConfig): string {
  return path.join(modelCacheDir(config), file.repoId.replaceAll('/', '--'), file.filename)
}

export function formatBytes(value?: number): string {
  if (value === undefined) return 'unknown'
  let amount = value
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (amount < 1024 || unit === 'TB') return unit === 'B' ? `${amount} B` : `${amount.toFixed(1)} ${unit}`
    amount /= 1024
  }
  return `${amount.toFixed(1)} TB`
}

function detectQuant(filename: string): string | undefined {
  const upper = filename.toUpperCase()
  return preferredQuants.find(quant => upper.includes(quant)) ?? upper.match(/(?:^|[.-])(IQ\d_[A-Z0-9_]+|Q\d(?:_[A-Z0-9_]+)?)(?:[.-]|$)/)?.[1]
}

function encodeRepo(repoId: string): string {
  return repoId.split('/').map(encodeURIComponent).join('/')
}

function encodeFilename(filename: string): string {
  return filename.split('/').map(encodeURIComponent).join('/')
}

async function hfFetch(url: string, token = hfToken()): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        'user-agent': 'pharo-agent/0.1',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code ? `${cause.code}: ${cause.message ?? 'network error'}` : (error as Error).message
    throw new HuggingFaceError(`Could not reach Hugging Face at ${url}: ${detail}`)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new HuggingFaceError(`Hugging Face returned HTTP ${response.status} for ${url}: ${body.slice(0, 300)}`)
  }
  return response
}

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonFile, xdgConfigDir } from './platform.ts'

export type ModelPreset = {
  id: string
  name: string
  repoId: string
  filename: string
  shards?: string[]
  publishRepo?: string
  description?: string
  tags?: string[]
  aliases?: string[]
}

export const defaultModelPresetId = 'qwen-coder-7b'
export const defaultPublishRepo = 'pharo-llm/pharo-agent'
export const bundledModelPresetFile = fileURLToPath(new URL('./model-presets.json', import.meta.url))

export const builtInModelPresets: ModelPreset[] = [
  {
    id: defaultModelPresetId,
    name: 'Qwen Coder 7B',
    repoId: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    filename: 'qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf',
    shards: [
      'qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf',
      'qwen2.5-coder-7b-instruct-q4_0-00002-of-00002.gguf',
    ],
    publishRepo: defaultPublishRepo,
    description: 'Qwen2.5-Coder 7B Instruct Q4_0 split GGUF, selected as the default Pharo Agent model.',
    tags: ['default', 'coding', 'qwen', '7b', 'gguf'],
    aliases: ['qwen2.5-coder-7b', 'qwen-coder', 'default'],
  },
]

export function defaultModelPreset(): ModelPreset {
  return builtInModelPresets.find(preset => preset.id === defaultModelPresetId) ?? builtInModelPresets[0]!
}

export async function loadModelPresets(cwd = process.cwd()): Promise<ModelPreset[]> {
  const bundled = await readModelPresetFile(bundledModelPresetFile)
  const custom = [
    ...await readModelPresetFile(path.join(xdgConfigDir(), 'models.json')),
    ...await readModelPresetFile(path.join(cwd, '.pharo-agent.models.json')),
  ]
  return mergePresets([...(bundled.length ? bundled : builtInModelPresets), ...custom])
}

export function findModelPreset(value: string | undefined, presets: ModelPreset[]): ModelPreset | undefined {
  if (!value) return undefined
  const normalized = normalizeModelName(value)
  return presets.find(preset => [
    preset.id,
    preset.name,
    ...(preset.aliases ?? []),
  ].some(candidate => normalizeModelName(candidate) === normalized))
}

export function modelReference(preset: ModelPreset): string {
  return `${preset.repoId}:${preset.filename}`
}

export function modelShardFiles(preset: ModelPreset): { repoId: string; filename: string }[] {
  return (preset.shards?.length ? preset.shards : [preset.filename]).map(filename => ({
    repoId: preset.repoId,
    filename,
  }))
}

export function formatModelPreset(preset: ModelPreset): string {
  const tags = preset.tags?.length ? ` [${preset.tags.join(', ')}]` : ''
  return `${preset.id.padEnd(16)} ${preset.name}${tags}\n  ${modelReference(preset)}\n  ${preset.description ?? ''}`.trimEnd()
}

export function isLikelyModelReference(value: string): boolean {
  return value.includes('/') || value.includes(':') || value.endsWith('.gguf')
}

async function readModelPresetFile(file: string): Promise<ModelPreset[]> {
  const data = await readJsonFile<{ models?: unknown[] } | unknown[]>(file, [])
  const items = Array.isArray(data) ? data : Array.isArray(data.models) ? data.models : []
  return items.flatMap(normalizePreset)
}

function normalizePreset(value: unknown): ModelPreset[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.repoId !== 'string' || typeof record.filename !== 'string') return []
  return [{
    id: record.id,
    name: record.name,
    repoId: record.repoId,
    filename: record.filename,
    shards: stringArray(record.shards),
    publishRepo: typeof record.publishRepo === 'string' ? record.publishRepo : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    tags: stringArray(record.tags),
    aliases: stringArray(record.aliases),
  }]
}

function mergePresets(presets: ModelPreset[]): ModelPreset[] {
  const seen = new Set<string>()
  const result: ModelPreset[] = []
  for (const preset of presets) {
    const key = normalizeModelName(preset.id)
    if (seen.has(key)) {
      const index = result.findIndex(existing => normalizeModelName(existing.id) === key)
      result[index] = preset
    } else {
      seen.add(key)
      result.push(preset)
    }
  }
  return result
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.filter(item => typeof item === 'string') as string[]
  return result.length ? result : undefined
}

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

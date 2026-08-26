import path from 'node:path'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import type { AgentConfig } from './types.ts'
import { ensureDir, xdgStateDir } from './platform.ts'

export function memoryPath(config: AgentConfig, cwd = process.cwd()): string {
  return config.memoryFile ?? path.join(cwd, 'PHARO_AGENT.md')
}

export async function readMemory(config: AgentConfig, cwd = process.cwd()): Promise<string> {
  try {
    return await readFile(memoryPath(config, cwd), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function appendMemory(config: AgentConfig, text: string, cwd = process.cwd()): Promise<void> {
  const file = memoryPath(config, cwd)
  await ensureDir(path.dirname(file))
  await appendFile(file, `${text.trim()}\n`, 'utf8')
}

export async function clearMemory(config: AgentConfig, cwd = process.cwd()): Promise<void> {
  const file = memoryPath(config, cwd)
  await ensureDir(path.dirname(file))
  await writeFile(file, '', 'utf8')
}

export function globalMemoryPath(): string {
  return path.join(xdgStateDir(), 'MEMORY.md')
}

import os from 'node:os'
import path from 'node:path'
import { readdir } from 'node:fs/promises'
import type { AgentConfig } from './types.ts'
import { effectiveLlamaServer } from './config.ts'
import { pathExists, which } from './platform.ts'
import { launcherLocations, listVms } from './launcher.ts'

export type SetupDiscovery = {
  pharoVms: string[]
  images: string[]
  llamaServers: string[]
}

export async function discoverSetup(cwd: string, config: AgentConfig): Promise<SetupDiscovery> {
  const [pharoVms, images, llamaServers] = await Promise.all([
    findPharoVmCandidates(config),
    findPharoImageCandidates(cwd),
    findLlamaServerCandidates(config),
  ])
  return { pharoVms, images, llamaServers }
}

export async function findPharoVmCandidates(config: AgentConfig): Promise<string[]> {
  const candidates = [
    config.pharoVm,
    await which('pharo'),
    await which('Pharo'),
    '/Applications/Pharo.app/Contents/MacOS/Pharo',
  ].filter(Boolean) as string[]
  // Pharo Launcher's VMs, newest first (wherever its settings put them).
  const vms = await listVms(await launcherLocations())
  candidates.push(...vms.filter(vm => vm.executable).sort((a, b) => Number(/^\d+/.exec(b.id)?.[0] ?? 0) - Number(/^\d+/.exec(a.id)?.[0] ?? 0)).map(vm => vm.executable!))
  return uniqueExisting(candidates)
}

export async function findPharoImageCandidates(cwd: string): Promise<string[]> {
  const roots = [
    cwd,
    (await launcherLocations()).imagesDir,
    path.join(os.homedir(), 'Documents', 'Pharo', 'images'),
    path.join(os.homedir(), 'Documents', 'Pharo'),
    path.join(os.homedir(), 'Downloads'),
  ]
  const found: string[] = []
  for (const root of roots) {
    found.push(...await walkForExtension(root, '.image', root === cwd ? 4 : 5, 30))
  }
  return uniqueExisting(found)
}

export async function findLlamaServerCandidates(config: AgentConfig): Promise<string[]> {
  return uniqueExisting([
    config.llamaServer,
    await effectiveLlamaServer(config),
    await which('llama-server'),
    await which('llama'),
  ].filter(Boolean) as string[])
}

async function uniqueExisting(values: string[]): Promise<string[]> {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const resolved = path.resolve(value)
    if (seen.has(resolved)) continue
    if (await pathExists(resolved)) {
      seen.add(resolved)
      result.push(resolved)
    }
  }
  return result
}

async function walkForExtension(root: string, extension: string, maxDepth: number, maxResults: number): Promise<string[]> {
  const result: string[] = []
  await walk(root, maxDepth, async entry => {
    if (entry.endsWith(extension)) result.push(entry)
    return result.length < maxResults
  })
  return result
}

async function walk(root: string, maxDepth: number, visit: (entry: string) => Promise<boolean>): Promise<boolean> {
  if (maxDepth < 0) return true
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue
    const full = path.join(root, entry.name)
    if (!await visit(full)) return false
    if (entry.isDirectory() && !await walk(full, maxDepth - 1, visit)) return false
  }
  return true
}

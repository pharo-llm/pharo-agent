import path from 'node:path'
import type { AgentConfig } from './types.ts'
import { effectiveLlamaServer, effectivePharoVm } from './config.ts'
import { listGgufFiles } from './hf.ts'
import { pathExists } from './platform.ts'
import { liveHealth } from './live.ts'

export type DiagnosticCheck = {
  name: string
  ok: boolean
  required: boolean
  detail: string
}

export async function collectDiagnostics(config: AgentConfig, cwd: string, options: { online?: boolean } = {}): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = []
  checks.push({ name: 'node', ok: nodeSupportsTypeScript(), required: true, detail: process.version })

  // A connected live image is enough on its own; the VM and image file are only
  // needed for headless runs (or to launch one with `pharo-agent live start`).
  const live = config.pharoMode === 'headless' ? undefined : await liveHealth(config)
  const liveOk = Boolean(live?.ok)
  checks.push({
    name: 'pharo.live',
    ok: liveOk,
    required: config.pharoMode === 'live',
    detail: liveOk
      ? `${live!.pharo ?? 'Pharo'} at ${live!.url} (${live!.image ?? ''})`
      : config.pharoMode === 'headless' ? 'disabled (--pharo-mode headless)' : `${live?.error ?? 'not running'}; run pharo-agent live start or pharo-agent live snippet`,
  })
  const { launcherLocations, listLauncherImages } = await import('./launcher.ts')
  const locations = await launcherLocations()
  const launcherImages = await listLauncherImages(locations)
  checks.push({ name: 'pharo.images', ok: launcherImages.length > 0, required: false, detail: `${launcherImages.length} in ${locations.imagesDir} (${locations.origin.imagesDir})` })
  const pharo = await effectivePharoVm(config)
  const needHeadless = !liveOk
  checks.push({ name: 'pharo.vm', ok: Boolean(pharo), required: needHeadless, detail: pharo ?? (config.image ? 'no VM for this image: pharo-agent images vm download <version>' : 'chosen per image once one is selected') })
  checks.push({
    name: 'pharo.image',
    ok: Boolean(config.image && await pathExists(path.resolve(cwd, config.image))),
    required: needHeadless,
    detail: config.image ?? 'none selected: pharo-agent images use <#> (see pharo-agent images)',
  })

  const llama = await effectiveLlamaServer(config)
  checks.push({ name: 'llama.cpp', ok: Boolean(llama), required: false, detail: llama ?? 'install llama.cpp or set PHARO_AGENT_LLAMA_SERVER' })
  checks.push({
    name: 'model.path',
    ok: Boolean(config.modelPath && await pathExists(path.resolve(cwd, config.modelPath))),
    required: false,
    detail: config.modelPath ?? 'not configured',
  })

  const api = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`)
    .then(response => response.ok ? 'reachable' : `HTTP ${response.status}`)
    .catch(error => describeFetchError(error))
  checks.push({ name: 'llm.api', ok: api === 'reachable', required: false, detail: `${config.baseUrl}: ${api}` })

  if (options.online) {
    try {
      const files = await listGgufFiles(config.modelRepo)
      checks.push({ name: 'huggingface.repo', ok: true, required: false, detail: `${config.modelRepo}: ${files.length} GGUF files` })
    } catch (error) {
      checks.push({ name: 'huggingface.repo', ok: false, required: false, detail: (error as Error).message })
    }
  }

  return checks
}

export function diagnosticsOk(checks: DiagnosticCheck[]): boolean {
  return checks.every(check => check.ok || !check.required)
}

export function nodeSupportsTypeScript(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major! > 22 || (major === 22 && minor! >= 6)
}

export function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  if (cause?.code === 'ECONNREFUSED') return 'connection refused; no model server is listening'
  if (cause?.code === 'ENOTFOUND') return 'host not found'
  if (cause?.code) return `${cause.code}: ${cause.message ?? 'network error'}`
  return (error as Error).message
}


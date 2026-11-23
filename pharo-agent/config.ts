import path from 'node:path'
import { existsSync } from 'node:fs'
import type { AgentConfig, PermissionMode, PharoMode } from './types.ts'
import { readJsonFile, which, writeJsonFile, xdgCacheDir, xdgConfigDir } from './platform.ts'
import { defaultModelPreset, defaultPublishRepo } from './models.ts'

export const defaultModelRepo = defaultModelPreset().repoId
export const defaultModelFile = defaultModelPreset().filename
export const defaultBaseUrl = 'http://127.0.0.1:8080/v1'

export function defaultConfig(): AgentConfig {
  return {
    headless: true,
    pharoMode: 'auto',
    livePort: 4044,
    timeoutSeconds: 120,
    modelRepo: defaultModelRepo,
    publishRepo: defaultPublishRepo,
    modelFile: defaultModelFile,
    baseUrl: defaultBaseUrl,
    llamaPort: 8080,
    maxIterations: 12,
    temperature: 0.2,
    permissionMode: 'ask',
    allowOutsideWorkspace: false,
    allowPrivateNetwork: false,
    autoStartModel: true,
  }
}

export function globalConfigPath(): string {
  return process.env.PHARO_AGENT_CONFIG ?? path.join(xdgConfigDir(), 'config.json')
}

export function projectConfigPath(cwd = process.cwd()): string | undefined {
  let current = path.resolve(cwd)
  while (true) {
    const candidate = path.join(current, '.pharo-agent.json')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function modelCacheDir(config: AgentConfig): string {
  return config.modelCacheDir ?? path.join(xdgCacheDir(), 'models')
}

/** Keys a project's .pharo-agent.json may not set: trust is the user's call. */
const globalOnlyKeys: (keyof AgentConfig)[] = ['trustedFolders', 'onboarded']
let warnedUntrusted = false

export async function loadConfig(options: { configPath?: string; cwd?: string } = {}): Promise<AgentConfig> {
  const globalFile = options.configPath ?? globalConfigPath()
  const globalValues = await readJsonFile<Partial<AgentConfig>>(globalFile, {})
  let config = mergeConfig(defaultConfig(), globalValues)
  const local = projectConfigPath(options.cwd)
  if (local && local !== globalFile) {
    // A cloned repository could otherwise switch permissions to dangerous or add
    // MCP commands: its config only applies once the user trusted the folder.
    if (isTrustedFolder(path.dirname(local), globalValues.trustedFolders)) {
      const values = await readJsonFile<Partial<AgentConfig>>(local, {})
      for (const key of globalOnlyKeys) delete values[key]
      config = mergeConfig(config, values)
    } else if (!warnedUntrusted) {
      warnedUntrusted = true
      process.stderr.write(`pharo-agent: ignoring ${local} until you trust this folder (run pharo-agent here).\n`)
    }
  }
  config = mergeConfig(config, envConfig())
  return config
}

export function isTrustedFolder(folder: string, trusted: string[] = []): boolean {
  const target = path.resolve(folder)
  return trusted.some(entry => {
    const root = path.resolve(entry)
    return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  })
}

export async function trustFolder(folder: string, configPath = globalConfigPath()): Promise<void> {
  const current = await readJsonFile<Partial<AgentConfig>>(configPath, {})
  const list = new Set(current.trustedFolders ?? [])
  list.add(path.resolve(folder))
  await updateConfigFile(configPath, { trustedFolders: [...list] })
}

export async function loadConfigFile(file: string): Promise<AgentConfig> {
  return mergeConfig(defaultConfig(), await readJsonFile<Partial<AgentConfig>>(file, {}))
}

export type ConfigUpdates = {
  [K in keyof AgentConfig]?: AgentConfig[K] | null
}

export async function updateConfigFile(file: string, updates: ConfigUpdates): Promise<AgentConfig> {
  const current = await loadConfigFile(file)
  for (const [key, value] of Object.entries(updates) as [keyof AgentConfig, AgentConfig[keyof AgentConfig] | null][]) {
    if (value === null) delete (current as Record<string, unknown>)[key]
  }
  const nonNullUpdates = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== null)) as Partial<AgentConfig>
  const next = mergeConfig(current, nonNullUpdates)
  await writeJsonFile(file, compactConfig(next))
  return next
}

export function mergeConfig(base: AgentConfig, updates: Partial<AgentConfig>): AgentConfig {
  const next = { ...base }
  for (const [key, value] of Object.entries(updates) as [keyof AgentConfig, AgentConfig[keyof AgentConfig]][]) {
    if (value !== undefined && value !== null && value !== '') {
      ;(next as Record<string, unknown>)[key] = value
    }
  }
  return next
}

function envConfig(): Partial<AgentConfig> {
  const env: Partial<AgentConfig> = {}
  mapEnv(env, 'PHARO_VM', 'pharoVm')
  mapEnv(env, 'PHARO_IMAGE', 'image')
  mapEnv(env, 'PHARO_AGENT_MODEL_REPO', 'modelRepo')
  mapEnv(env, 'PHARO_AGENT_PUBLISH_REPO', 'publishRepo')
  mapEnv(env, 'PHARO_AGENT_MODEL', 'model')
  mapEnv(env, 'PHARO_AGENT_MODEL_FILE', 'modelFile')
  mapEnv(env, 'PHARO_AGENT_MODEL_PATH', 'modelPath')
  mapEnv(env, 'PHARO_AGENT_BASE_URL', 'baseUrl')
  mapEnv(env, 'PHARO_AGENT_API_KEY', 'apiKey')
  mapEnv(env, 'PHARO_AGENT_LLAMA_SERVER', 'llamaServer')
  mapEnv(env, 'PHARO_AGENT_MODEL_CACHE', 'modelCacheDir')
  mapEnv(env, 'PHARO_AGENT_MCP_CONFIG', 'mcpConfig')
  mapEnv(env, 'PHARO_AGENT_MEMORY', 'memoryFile')
  mapEnv(env, 'PHARO_AGENT_LIVE_URL', 'liveUrl')
  mapEnv(env, 'PHARO_AGENT_LIVE_TOKEN', 'liveToken')
  mapEnv(env, 'PHARO_AGENT_LIVE_FILE', 'liveFile')
  if (process.env.PHARO_AGENT_PHARO_MODE) env.pharoMode = pharoModeValue(process.env.PHARO_AGENT_PHARO_MODE)
  if (process.env.PHARO_AGENT_LIVE_PORT) env.livePort = Number(process.env.PHARO_AGENT_LIVE_PORT)
  if (process.env.PHARO_AGENT_TIMEOUT) env.timeoutSeconds = Number(process.env.PHARO_AGENT_TIMEOUT)
  if (process.env.PHARO_AGENT_MAX_ITERATIONS) env.maxIterations = Number(process.env.PHARO_AGENT_MAX_ITERATIONS)
  if (process.env.PHARO_AGENT_LLAMA_PORT) env.llamaPort = Number(process.env.PHARO_AGENT_LLAMA_PORT)
  if (process.env.PHARO_AGENT_TEMPERATURE) env.temperature = Number(process.env.PHARO_AGENT_TEMPERATURE)
  if (process.env.PHARO_AGENT_PERMISSION_MODE) env.permissionMode = process.env.PHARO_AGENT_PERMISSION_MODE as PermissionMode
  if (process.env.PHARO_AGENT_HEADLESS) env.headless = !['0', 'false', 'no'].includes(process.env.PHARO_AGENT_HEADLESS.toLowerCase())
  if (process.env.PHARO_AGENT_ALLOW_OUTSIDE_WORKSPACE) env.allowOutsideWorkspace = envBool(process.env.PHARO_AGENT_ALLOW_OUTSIDE_WORKSPACE)
  if (process.env.PHARO_AGENT_ALLOW_PRIVATE_NETWORK) env.allowPrivateNetwork = envBool(process.env.PHARO_AGENT_ALLOW_PRIVATE_NETWORK)
  return env
}

function mapEnv<T extends keyof AgentConfig>(target: Partial<AgentConfig>, envName: string, key: T): void {
  if (process.env[envName]) target[key] = process.env[envName] as AgentConfig[T]
}

export function compactConfig(config: AgentConfig): Partial<AgentConfig> {
  const defaults = defaultConfig()
  const result: Partial<AgentConfig> = {}
  for (const [key, value] of Object.entries(config) as [keyof AgentConfig, AgentConfig[keyof AgentConfig]][]) {
    if (value !== undefined && value !== defaults[key]) {
      ;(result as Record<string, unknown>)[key] = value
    }
  }
  return result
}

/**
 * The VM to run the selected image with: an explicit pharoVm; else the one
 * Pharo Launcher would use for that image (recorded VM, then its version's);
 * else a `pharo` on PATH.
 */
export async function effectivePharoVm(config: AgentConfig, options: { gui?: boolean } = {}): Promise<string | undefined> {
  if (config.pharoVm) return config.pharoVm
  if (config.image) {
    const { describeImage, launcherLocations, readImageDirectory, resolveVm } = await import('./launcher.ts')
    const imagePath = path.resolve(config.image)
    if (existsSync(imagePath)) {
      const fromDir = await readImageDirectory(path.dirname(imagePath))
      const image = fromDir?.imagePath === imagePath ? fromDir : await describeImage(imagePath, 'found')
      const resolved = await resolveVm(await launcherLocations(), image)
      const vm = options.gui ? resolved.guiExecutable ?? resolved.executable : resolved.executable
      if (vm) return vm
    }
  }
  return (await which('pharo')) ?? (await which('Pharo'))
}

export async function effectiveLlamaServer(config: AgentConfig): Promise<string | undefined> {
  return config.llamaServer ?? (await which('llama-server')) ?? (await which('llama'))
}

export function pharoModeValue(value: string): PharoMode {
  if (value === 'auto' || value === 'live' || value === 'headless') return value
  throw new Error(`Invalid Pharo mode: ${value}. Use auto, live, or headless.`)
}

function envBool(value: string): boolean {
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

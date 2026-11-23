import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, mkdir, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { AgentConfig } from './types.ts'
import { effectivePharoVm } from './config.ts'
import { pathExists, resolvePath } from './platform.ts'
import { describeImage, freePort, launcherLocations, readImageDirectory, resolveVm } from './launcher.ts'
import type { PharoImage } from './launcher.ts'

export class LiveError extends Error {}

export type LiveEndpoint = {
  url: string
  token: string
  source: 'config' | 'file'
}

export type LiveHealth = {
  ok: boolean
  url: string
  pharo?: string
  image?: string
  requests?: number
  error?: string
}

/** Same shape for the live server and the headless runner. */
export type EvalOutcome = {
  ok: boolean
  result?: string
  resultClass?: string
  error?: string
  errorClass?: string
  stack?: string[]
  warnings?: string[]
  durationMs: number
}

export function liveDir(): string {
  return path.join(os.homedir(), '.pharo-agent')
}

export function liveInfoFile(config: AgentConfig): string {
  return config.liveFile ? resolvePath(config.liveFile) : path.join(liveDir(), 'live.json')
}

export function liveServerScriptPath(): string {
  return fileURLToPath(new URL('./smalltalk/live-server.st', import.meta.url))
}

/** The token file grants code execution in the image: keep its directory private. */
export async function ensurePrivateLiveDir(dir = liveDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    const mode = (await stat(dir)).mode & 0o777
    if (mode !== 0o700) await chmod(dir, 0o700)
  }
}

export type EndpointFile = { url: string; token: string; image?: string; pharo?: string; port?: number; file: string; mtimeMs: number }

async function readEndpointFile(file: string): Promise<EndpointFile | undefined> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as { url?: unknown; port?: unknown; token?: unknown; image?: unknown; pharo?: unknown }
    const url = typeof data.url === 'string' ? data.url : typeof data.port === 'number' ? `http://127.0.0.1:${data.port}` : undefined
    if (!url || typeof data.token !== 'string') return undefined
    return {
      url: url.replace(/\/$/, ''),
      token: data.token,
      image: typeof data.image === 'string' ? data.image : undefined,
      pharo: typeof data.pharo === 'string' ? data.pharo : undefined,
      port: typeof data.port === 'number' ? data.port : undefined,
      file,
      mtimeMs: (await stat(file)).mtimeMs,
    }
  } catch {
    return undefined
  }
}

/** Every endpoint a live server has published, newest first (some may be stale). */
export async function listEndpointFiles(dir = liveDir()): Promise<EndpointFile[]> {
  const files = await readdir(path.join(dir, 'endpoints')).catch(() => [] as string[])
  const endpoints: EndpointFile[] = []
  for (const file of files.filter(name => name.endsWith('.json'))) {
    const endpoint = await readEndpointFile(path.join(dir, 'endpoints', file))
    if (endpoint) endpoints.push(endpoint)
  }
  return endpoints.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export async function samePath(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  const [ra, rb] = await Promise.all([realpath(a).catch(() => path.resolve(a)), realpath(b).catch(() => path.resolve(b))])
  return ra === rb
}

/** The newest published endpoint of the server running inside `imagePath`. */
export async function endpointForImage(imagePath: string, endpoints?: EndpointFile[]): Promise<EndpointFile | undefined> {
  for (const endpoint of endpoints ?? await listEndpointFiles()) {
    if (endpoint.image && await samePath(endpoint.image, imagePath)) return endpoint
  }
  return undefined
}

/**
 * Which live server to talk to: an explicit liveUrl; else the server of the
 * selected image (config.image); else, with no image selected, the latest
 * server started anywhere (live.json).
 */
export async function liveEndpoint(config: AgentConfig): Promise<LiveEndpoint | undefined> {
  if (config.liveUrl) return { url: config.liveUrl.replace(/\/$/, ''), token: config.liveToken ?? '', source: 'config' }
  if (config.liveFile) {
    const endpoint = await readEndpointFile(resolvePath(config.liveFile))
    return endpoint ? { url: endpoint.url, token: endpoint.token, source: 'file' } : undefined
  }
  await ensurePrivateLiveDir().catch(() => undefined)
  if (config.image) {
    const endpoint = await endpointForImage(resolvePath(config.image))
    return endpoint ? { url: endpoint.url, token: endpoint.token, source: 'file' } : undefined
  }
  const latest = await readEndpointFile(path.join(liveDir(), 'live.json'))
  return latest ? { url: latest.url, token: latest.token, source: 'file' } : undefined
}

export async function liveHealth(config: AgentConfig, timeoutMs = 1_500): Promise<LiveHealth | undefined> {
  const endpoint = await liveEndpoint(config)
  if (!endpoint) return undefined
  try {
    const data = await liveRequest<{ ok?: boolean; pharo?: string; image?: string; requests?: number; error?: string }>(endpoint, '/health', undefined, { timeoutMs })
    return { ok: data.ok === true, url: endpoint.url, pharo: data.pharo, image: data.image, requests: data.requests, error: data.error }
  } catch (error) {
    return { ok: false, url: endpoint.url, error: (error as Error).message }
  }
}

export async function liveEval(
  endpoint: LiveEndpoint,
  code: string,
  options: { timeoutMs: number; ui?: boolean; signal?: AbortSignal },
): Promise<EvalOutcome> {
  const data = await liveRequest<Partial<EvalOutcome>>(endpoint, '/eval', { code, timeoutMs: options.timeoutMs, ui: Boolean(options.ui) }, {
    // The image enforces timeoutMs itself; give the HTTP round-trip some slack on top.
    timeoutMs: options.timeoutMs + 10_000,
    signal: options.signal,
  })
  return normalizeOutcome(data)
}

export async function liveSave(endpoint: LiveEndpoint): Promise<{ ok: boolean; image?: string; error?: string }> {
  return await liveRequest(endpoint, '/save', {}, { timeoutMs: 10_000 })
}

/** Pharo strings use CR line endings. */
function lf(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

export function normalizeOutcome(data: Partial<EvalOutcome> | undefined): EvalOutcome {
  return {
    ok: data?.ok === true,
    result: typeof data?.result === 'string' ? lf(data.result) : undefined,
    resultClass: typeof data?.resultClass === 'string' ? data.resultClass : undefined,
    error: typeof data?.error === 'string' ? lf(data.error) : data?.ok === true ? undefined : 'Pharo returned no result',
    errorClass: typeof data?.errorClass === 'string' ? data.errorClass : undefined,
    stack: Array.isArray(data?.stack) ? data.stack.map(item => lf(String(item))) : undefined,
    warnings: Array.isArray(data?.warnings) ? data.warnings.map(item => lf(String(item))) : undefined,
    durationMs: typeof data?.durationMs === 'number' ? data.durationMs : 0,
  }
}

async function liveRequest<T>(
  endpoint: LiveEndpoint,
  route: string,
  body: unknown,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(`${endpoint.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pharo-agent-token': endpoint.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw new LiveError('Interrupted')
    if (timeout.aborted) throw new LiveError(`Live image at ${endpoint.url} did not answer within ${Math.round(options.timeoutMs / 1000)}s`)
    const cause = (error as { cause?: { code?: string } }).cause
    if (cause?.code === 'ECONNREFUSED') throw new LiveError(`No live image is listening at ${endpoint.url}`)
    throw new LiveError(`Could not reach live image at ${endpoint.url}: ${(error as Error).message}`)
  }
  const text = await response.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new LiveError(`Live image returned HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  if (response.status === 401) throw new LiveError('Live image rejected the token. Restart the live server, or check ~/.pharo-agent/live.json.')
  if (!response.ok) throw new LiveError(`Live image returned HTTP ${response.status}: ${(data as { error?: string }).error ?? text.slice(0, 300)}`)
  return data as T
}

export type StartedLiveImage = {
  pid?: number
  url: string
  logPath: string
  health: LiveHealth
}

/**
 * Launch an image with the live server loaded, on a free port. With a window
 * by default, as Pharo Launcher would; the image keeps running after the CLI
 * exits (it is the user's image session).
 */
export async function startImage(
  image: PharoImage,
  options: { headless?: boolean; port?: number; waitSeconds?: number; vm?: string; agent?: boolean } = {},
): Promise<StartedLiveImage> {
  const locations = await launcherLocations()
  let vm = options.vm
  if (!vm) {
    const resolved = await resolveVm(locations, image)
    vm = options.headless ? resolved.executable : resolved.guiExecutable ?? resolved.executable
    if (!vm) throw new LiveError(`${resolved.reason}. Download it with: pharo-agent images vm download ${resolved.missingVersion ?? '<version>'}`)
  }
  // A port is free when nothing listens on it; a stale endpoint file for it is
  // simply overwritten by the new server.
  const port = options.port ?? await freePort(4044)
  const token = randomUUID()
  await ensurePrivateLiveDir()
  const logPath = path.join(liveDir(), 'logs', `${image.name.replace(/[^\w.-]+/g, '_')}.log`)
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 })
  const log = await open(logPath, 'a', 0o600)
  const agent = options.agent !== false
  const args = [...(options.headless ? ['--headless'] : []), image.imagePath, ...(agent ? ['st', liveServerScriptPath()] : [])]
  const child = spawn(vm, args, {
    cwd: image.dir,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, PHARO_AGENT_PORT: String(port), PHARO_AGENT_TOKEN: token },
    windowsHide: Boolean(options.headless),
  })
  child.unref()
  await log.close()
  const endpoint: LiveEndpoint = { url: `http://127.0.0.1:${port}`, token, source: 'file' }
  if (!agent) return { pid: child.pid, url: '', logPath, health: { ok: false, url: '', error: 'started without the agent server' } }
  const deadline = Date.now() + (options.waitSeconds ?? 90) * 1_000
  let exited: number | null = null
  child.once('exit', code => {
    exited = code ?? 1
  })
  while (Date.now() < deadline) {
    if (exited !== null) throw new LiveError(`Pharo exited with code ${exited} before the live server started. See ${logPath}`)
    try {
      const data = await liveRequest<{ ok?: boolean; pharo?: string; image?: string }>(endpoint, '/health', undefined, { timeoutMs: 1_000 })
      if (data.ok) return { pid: child.pid, url: endpoint.url, logPath, health: { ok: true, url: endpoint.url, pharo: data.pharo, image: data.image } }
    } catch {
      // still booting
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new LiveError(`The live server did not answer on ${endpoint.url} within ${options.waitSeconds ?? 90}s. See ${logPath}`)
}

/** Launch the configured image (config.image) with the live server. */
export async function startLiveImage(
  config: AgentConfig,
  options: { headless?: boolean; port?: number; waitSeconds?: number; cwd?: string } = {},
): Promise<StartedLiveImage> {
  if (!config.image) throw new LiveError('No image selected. Pick one with `pharo-agent images use <name>` (see `pharo-agent images`).')
  const imagePath = resolvePath(config.image, options.cwd)
  if (!await pathExists(imagePath)) throw new LiveError(`Configured Pharo image does not exist: ${imagePath}`)
  const image = await readImageDirectory(path.dirname(imagePath)).then(found => found?.imagePath === imagePath ? found : undefined) ?? await describeImage(imagePath, 'found')
  return startImage(image, { ...options, vm: await effectivePharoVm(config, { gui: !options.headless }) })
}

/** Ask a live image to quit (optionally saving first). */
export async function quitLiveImage(endpoint: LiveEndpoint, options: { save?: boolean } = {}): Promise<void> {
  const code = `[ Smalltalk snapshot: ${options.save ? 'true' : 'false'} andQuit: true ] forkAt: Processor userBackgroundPriority. 'quitting'`
  await liveEval(endpoint, code, { timeoutMs: 5_000 }).catch(() => undefined)
}

/** One line a user can paste into a Playground of an already-open image. */
export function liveLoadSnippet(port?: number): string {
  const file = liveServerScriptPath().replaceAll("'", "''")
  const choosePort = port ? `Smalltalk at: #PharoAgentLivePort put: ${port}. ` : ''
  return `${choosePort}Smalltalk compiler evaluate: '${file}' asFileReference contents.`
}

/** The first loopback port from 4044 that nothing listens on. */
export async function nextLivePort(start = 4044): Promise<number> {
  return freePort(start)
}

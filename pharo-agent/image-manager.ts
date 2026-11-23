/**
 * Image workflow shared by the CLI, the chat, and the agent's tools: which
 * images exist and run, which one is selected, and starting/stopping them.
 */
import path from 'node:path'
import type { AgentConfig } from './types.ts'
import { globalConfigPath, projectConfigPath, updateConfigFile } from './config.ts'
import {
  findImage,
  findOtherImages,
  launcherLocations,
  listLauncherImages,
  listVmProcesses,
  LauncherError,
  resolveVm,
  runningImagePids,
  versionLabel,
} from './launcher.ts'
import type { LauncherLocations, PharoImage, VmProcess } from './launcher.ts'
import { endpointForImage, listEndpointFiles, liveHealth, quitLiveImage, samePath, startImage } from './live.ts'
import type { StartedLiveImage } from './live.ts'
import { resolvePath } from './platform.ts'

export type ImageState = 'live' | 'running' | 'stopped'

export type ImageStatus = {
  index: number
  image: PharoImage
  state: ImageState
  pids: number[]
  liveUrl?: string
  selected: boolean
}

export async function imageStatuses(config: AgentConfig, options: { cwd: string; all?: boolean; locations?: LauncherLocations } = { cwd: process.cwd() }): Promise<ImageStatus[]> {
  const locations = options.locations ?? await launcherLocations()
  const images = await listLauncherImages(locations)
  if (options.all) images.push(...await findOtherImages(locations, { cwd: options.cwd, deep: true }))
  else if (config.image) {
    // Always show the selected image, even when it lives outside Launcher's directory.
    const selected = resolvePath(config.image, options.cwd)
    if (!images.some(image => image.imagePath === selected)) {
      try {
        images.push(await findImage(locations, selected, options.cwd))
      } catch {
        // selected image no longer exists
      }
    }
  }
  const [processes, endpoints] = await Promise.all([listVmProcesses().catch(() => [] as VmProcess[]), listEndpointFiles()])
  const selectedPath = config.image ? resolvePath(config.image, options.cwd) : undefined
  return Promise.all(images.map(async (image, index): Promise<ImageStatus> => {
    const pids = await runningImagePids(image, processes)
    const endpoint = pids.length ? await endpointForImage(image.imagePath, endpoints) : undefined
    let live = false
    if (endpoint) {
      const health = await liveHealth({ ...config, liveUrl: endpoint.url, liveToken: endpoint.token }, 800)
      live = Boolean(health?.ok)
    }
    return {
      index: index + 1,
      image,
      state: live ? 'live' : pids.length ? 'running' : 'stopped',
      pids,
      liveUrl: live ? endpoint?.url : undefined,
      selected: Boolean(selectedPath && await samePath(selectedPath, image.imagePath)),
    }
  }))
}

/** "3", an exact or partial name, or a path. Numbers refer to `listing` when given. */
export async function resolveImageRef(ref: string, options: { cwd: string; listing?: ImageStatus[]; locations?: LauncherLocations }): Promise<PharoImage> {
  const locations = options.locations ?? await launcherLocations()
  if (/^\d+$/.test(ref)) {
    const listing = options.listing ?? (await listLauncherImages(locations)).map((image, index) => ({ index: index + 1, image }))
    const hit = listing.find(entry => entry.index === Number(ref))
    if (!hit) throw new LauncherError(`No image #${ref}. List them with /images.`)
    return hit.image
  }
  const fromListing = options.listing?.find(entry => entry.image.name === ref)
  return fromListing?.image ?? findImage(locations, ref, options.cwd)
}

/**
 * Make `image` the one the agent works in. Saved to the project's
 * .pharo-agent.json when there is one, else to the global config, so the next
 * session starts on it too. The VM is chosen per image, so pharoVm is cleared.
 */
export async function selectImage(config: AgentConfig, image: PharoImage, options: { cwd: string; persist?: boolean; configPath?: string }): Promise<string | undefined> {
  config.image = image.imagePath
  config.pharoVm = undefined
  if (options.persist === false) return undefined
  const destination = options.configPath ?? projectConfigPath(options.cwd) ?? globalConfigPath()
  await updateConfigFile(destination, { image: image.imagePath, pharoVm: null })
  return destination
}

export async function startPharoImage(image: PharoImage, options: { headless?: boolean; agent?: boolean } = {}): Promise<StartedLiveImage & { alreadyRunning?: boolean }> {
  const endpoints = await listEndpointFiles()
  const pids = await runningImagePids(image)
  if (pids.length) {
    const endpoint = await endpointForImage(image.imagePath, endpoints)
    if (endpoint) {
      const health = await liveHealth({ liveUrl: endpoint.url, liveToken: endpoint.token } as AgentConfig, 1_500)
      if (health?.ok) return { pid: pids[0], url: endpoint.url, logPath: '', health, alreadyRunning: true }
    }
    throw new LauncherError(`"${image.name}" is already running (pid ${pids.join(', ')}) without the agent server. Connect it: paste the line from /live snippet into its Playground.`)
  }
  return startImage(image, { headless: options.headless, agent: options.agent })
}

export async function stopPharoImage(image: PharoImage, options: { save?: boolean; timeoutMs?: number } = {}): Promise<{ stopped: boolean; killed: boolean; saved: boolean }> {
  let pids = await runningImagePids(image)
  if (!pids.length) return { stopped: true, killed: false, saved: false }
  const endpoint = await endpointForImage(image.imagePath)
  let asked = false
  if (endpoint) {
    await quitLiveImage({ url: endpoint.url, token: endpoint.token, source: 'file' }, { save: options.save })
    asked = true
  }
  const deadline = Date.now() + (options.timeoutMs ?? (options.save ? 30_000 : 8_000))
  while (asked && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    pids = await runningImagePids(image)
    if (!pids.length) return { stopped: true, killed: false, saved: Boolean(options.save) }
  }
  if (options.save) throw new LauncherError(`"${image.name}" did not save and quit in time${asked ? '' : ' (no agent server to ask)'}; it is still running.`)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  return { stopped: true, killed: true, saved: false }
}

export function describeVersion(image: PharoImage): string {
  return image.version ? `Pharo ${versionLabel(image.version)}` : 'Pharo ?'
}

export async function vmSummary(image: PharoImage): Promise<string> {
  const resolved = await resolveVm(await launcherLocations(), image)
  return resolved.id ? `${resolved.id} (${resolved.reason})` : resolved.reason
}

export function shortImageName(image: PharoImage | string, max = 28): string {
  const name = typeof image === 'string' ? path.basename(image, '.image') : image.name
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

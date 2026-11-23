/**
 * First-run setup, Claude Code style: trust the folder, pick a model, decide how
 * much to ask before changes, MCP or not, then an image and its VM. Everything
 * is saved in the global config, so nothing has to be exported by hand.
 */
import path from 'node:path'
import type { AgentConfig, PermissionMode } from './types.ts'
import { globalConfigPath, isTrustedFolder, loadConfig, trustFolder, updateConfigFile } from './config.ts'
import type { ConfigUpdates } from './config.ts'
import { ask as askLine, select as selectMenu } from './prompts.ts'
import type { Choice } from './prompts.ts'
import { clearProgress, logoLines, printProgress, style, tildify } from './ui.ts'
import { effectiveLlamaServer } from './config.ts'
import {
  createImage,
  downloadVm,
  launcherLocations,
  listTemplates,
  listVms,
  resolveVm,
  versionLabel,
  vmVersionFor,
} from './launcher.ts'
import type { PharoImage } from './launcher.ts'
import { describeVersion, imageStatuses, selectImage, startPharoImage } from './image-manager.ts'
import { projectMcpFiles, readMcpFile } from './mcp.ts'
import { pathExists, writeJsonFile, xdgConfigDir } from './platform.ts'

/** How setup asks: arrow-key menus in a terminal, numbered questions inside the chat. */
export type SetupIo = {
  select<T>(title: string, choices: Choice<T>[], initial?: number): Promise<T>
  ask(question: string, fallback?: string): Promise<string>
  write(text: string): void
}

export const terminalIo: SetupIo = {
  select: (title, choices, initial) => selectMenu(title, choices, { initial }),
  ask: (question, fallback) => askLine(question, fallback),
  write: text => process.stdout.write(text),
}

export type SetupOptions = {
  cwd: string
  configPath?: string
  /** Ask about trusting cwd first (chat start), not when run from the installer. */
  trust?: boolean
  io?: SetupIo
  /** Delegates for heavy steps the CLI already implements. */
  downloadDefaultModel?: () => Promise<void>
}

export class SetupDeclined extends Error {}

export async function isCwdTrusted(cwd: string, configPath = globalConfigPath()): Promise<boolean> {
  const { readJsonFile } = await import('./platform.ts')
  const global = await readJsonFile<Partial<AgentConfig>>(configPath, {})
  return isTrustedFolder(cwd, global.trustedFolders)
}

/** The trust question. Throws SetupDeclined on "No". */
export async function askTrust(cwd: string, io: SetupIo = terminalIo, configPath = globalConfigPath()): Promise<void> {
  io.write(`\n${style.bold('Do you trust the files in this folder?')}\n\n  ${tildify(cwd)}\n\n`)
  io.write(style.dim('  Pharo Agent can read, edit and run files here, and uses this folder\'s\n  .pharo-agent.json and MCP settings. Only trust folders you know.\n\n'))
  const yes = await io.select('Trust this folder?', [
    { label: 'Yes, proceed', value: true },
    { label: 'No, exit', value: false },
  ])
  if (!yes) throw new SetupDeclined('Folder not trusted')
  await trustFolder(cwd, configPath)
}

export async function runSetup(options: SetupOptions): Promise<AgentConfig> {
  const io = options.io ?? terminalIo
  const file = options.configPath ?? globalConfigPath()
  const save = (values: ConfigUpdates) => updateConfigFile(file, values)

  const logo = logoLines()
  io.write(`\n${logo.map((line, i) => ` ${line}   ${i === 1 ? style.bold('Welcome to Pharo Agent') : i === 2 ? style.dim('A few questions and you are ready.') : ''}`).join('\n')}\n`)

  if (options.trust && !await isCwdTrusted(options.cwd, file)) await askTrust(options.cwd, io, file)

  let config = await loadConfig({ configPath: options.configPath, cwd: options.cwd })
  await modelStep(config, io, save, options)
  config = await loadConfig({ configPath: options.configPath, cwd: options.cwd })

  io.write('\n')
  const permission = await io.select<PermissionMode>('How should the agent ask before changing things?', [
    { label: 'Ask me every time', value: 'ask', hint: 'recommended: approve each change (y / n / always)' },
    { label: 'Auto-approve changes', value: 'auto', hint: 'still asks before deleting or other destructive steps' },
    { label: 'Read-only', value: 'read-only', hint: 'the agent can look but never change anything' },
  ], ['ask', 'auto', 'read-only'].indexOf(config.permissionMode) >= 0 ? ['ask', 'auto', 'read-only'].indexOf(config.permissionMode) : 0)
  await save({ permissionMode: permission })

  io.write('\n')
  await mcpStep(options.cwd, io, save)

  io.write('\n')
  config = await loadConfig({ configPath: options.configPath, cwd: options.cwd })
  const image = await imageStep(config, io, options.cwd)
  if (image) {
    await selectImage(config, image, { cwd: options.cwd, configPath: file })
    const vm = await vmStep(image, io)
    if (vm) await save({ pharoVm: vm })
    io.write('\n')
    const [status] = (await imageStatuses({ ...config, image: image.imagePath }, { cwd: options.cwd })).filter(entry => entry.selected)
    const start = status?.state === 'live' ? 'no' as const : await io.select('Start it now?', [
      { label: 'Yes, with its window', value: 'window' as const },
      { label: 'Yes, headless (no window)', value: 'headless' as const },
      { label: 'Not now', value: 'no' as const, hint: 'questions then run in a throwaway copy until you /image start' },
    ])
    if (status?.state === 'live') io.write(`${style.green('●')} ${image.name} is already live at ${status.liveUrl}\n`)
    if (start !== 'no') {
      io.write(style.dim(`Starting ${image.name}…\n`))
      try {
        const started = await startPharoImage(image, { headless: start === 'headless' })
        io.write(`${style.green('●')} ${image.name} is live at ${started.url}\n`)
      } catch (error) {
        io.write(`${style.yellow('!')} Could not start it: ${(error as Error).message}\n`)
      }
    }
  }

  await save({ onboarded: true })
  config = await loadConfig({ configPath: options.configPath, cwd: options.cwd })
  io.write(`\n${style.green('✓')} ${style.bold('Setup complete')} ${style.dim(`· saved in ${tildify(file)}`)}\n`)
  io.write(`  model        ${config.model ?? config.modelFile ?? 'none'} ${style.dim(config.baseUrl)}\n`)
  io.write(`  permissions  ${config.permissionMode}\n`)
  io.write(`  MCP          ${config.mcpEnabled === false ? 'off' : config.mcpConfig ? tildify(config.mcpConfig) : 'project .mcp.json when present'}\n`)
  io.write(`  image        ${config.image ? tildify(config.image) : 'none yet (/image)'}\n`)
  io.write(style.dim('  Change any of this later with /setup, /image, /model or /permissions.\n\n'))
  return config
}

// ---------------------------------------------------------------------------
// Model

type ModelChoice =
  | { kind: 'server'; baseUrl: string; model: string }
  | { kind: 'download' }
  | { kind: 'url' }
  | { kind: 'skip' }

const knownServers = [
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
]

export async function detectModelServers(extra: string[] = []): Promise<{ name: string; baseUrl: string; models: string[] }[]> {
  const candidates = [...extra.map(baseUrl => ({ name: serverName(baseUrl), baseUrl })), ...knownServers]
  const seen = new Set<string>()
  const unique = candidates.filter(candidate => {
    const key = candidate.baseUrl.replace(/\/$/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const results = await Promise.all(unique.map(async server => {
    try {
      const response = await fetch(`${server.baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1_500) })
      if (!response.ok) return undefined
      const data = await response.json() as { data?: { id?: string }[] }
      return { ...server, models: (data.data ?? []).map(item => item.id).filter((id): id is string => Boolean(id)) }
    } catch {
      return undefined
    }
  }))
  return results.filter((server): server is { name: string; baseUrl: string; models: string[] } => Boolean(server))
}

function serverName(baseUrl: string): string {
  return knownServers.find(server => server.baseUrl === baseUrl.replace(/\/$/, ''))?.name ?? baseUrl.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '')
}

async function modelStep(config: AgentConfig, io: SetupIo, save: (values: ConfigUpdates) => Promise<unknown>, options: SetupOptions): Promise<void> {
  io.write(`\n${style.dim('Looking for model servers (Ollama, llama.cpp, LM Studio)…')}\n`)
  const servers = await detectModelServers([config.baseUrl])
  const choices: Choice<ModelChoice>[] = []
  for (const server of servers) {
    // Embedding models (nomic-embed-text, …) cannot chat: don't offer them.
    for (const model of server.models.filter(id => !/embed/i.test(id)).slice(0, 8)) choices.push({ label: model, value: { kind: 'server', baseUrl: server.baseUrl, model }, hint: `${server.name} · running` })
  }
  const llama = await effectiveLlamaServer(config)
  if (llama) choices.push({ label: 'Download Qwen2.5-Coder 7B and run it with llama.cpp', value: { kind: 'download' }, hint: '≈4.7 GB, started automatically when needed' })
  choices.push({ label: 'Another OpenAI-compatible server…', value: { kind: 'url' }, hint: 'enter its URL' })
  choices.push({ label: 'Skip for now', value: { kind: 'skip' } })
  if (!servers.length) io.write(style.yellow(`No running model server found.${llama ? '' : ' Install Ollama (ollama.com) or llama.cpp, or enter a server URL.'}\n`))
  const current = choices.findIndex(choice => choice.value.kind === 'server' && choice.value.model === config.model && choice.value.baseUrl === config.baseUrl)
  const picked = await io.select('Which model should the agent use?', choices, current >= 0 ? current : 0)
  if (picked.kind === 'server') {
    await save({ baseUrl: picked.baseUrl, model: picked.model, modelPath: null })
  } else if (picked.kind === 'download') {
    if (options.downloadDefaultModel) await options.downloadDefaultModel()
    await save({ baseUrl: `http://127.0.0.1:${config.llamaPort}/v1`, autoStartModel: true })
  } else if (picked.kind === 'url') {
    const baseUrl = (await io.ask('Server URL (OpenAI-compatible, ending in /v1)', 'http://127.0.0.1:8080/v1')).replace(/\/$/, '')
    const apiKey = await io.ask('API key (leave empty if none)', '')
    const [server] = await detectModelServers([baseUrl])
    let model = config.model
    if (server?.models.length) model = await io.select('Which model?', server.models.slice(0, 9).map(id => ({ label: id, value: id })))
    else model = await io.ask('Model name', model ?? '')
    await save({ baseUrl, model, ...(apiKey ? { apiKey } : {}) })
  }
}

// ---------------------------------------------------------------------------
// MCP

async function mcpStep(cwd: string, io: SetupIo, save: (values: ConfigUpdates) => Promise<unknown>): Promise<void> {
  let projectFile: string | undefined
  let projectServers: string[] = []
  for (const name of projectMcpFiles) {
    const file = path.join(cwd, name)
    if (await pathExists(file)) {
      projectFile = file
      projectServers = Object.keys((await readMcpFile(file).catch(() => ({ mcpServers: {} }))).mcpServers ?? {})
      break
    }
  }
  type McpChoice = 'off' | 'project' | 'plexus' | 'file'
  const choices: Choice<McpChoice>[] = [
    { label: 'No MCP servers', value: 'off', hint: 'recommended: the built-in Pharo tools work without MCP' },
  ]
  if (projectFile) choices.push({ label: `Use ${path.basename(projectFile)} from this folder`, value: 'project', hint: projectServers.join(', ') || 'no servers listed' })
  choices.push({ label: 'Evref-BL MCP for Pharo (PLexus)', value: 'plexus', hint: 'adds image tools through npx @evref-bl/plexus mcp' })
  choices.push({ label: 'Another MCP config file…', value: 'file' })
  const picked = await io.select('Use MCP servers?', choices)
  if (picked === 'off') await save({ mcpEnabled: false, mcpConfig: null })
  else if (picked === 'project') await save({ mcpEnabled: true, mcpConfig: null })
  else if (picked === 'plexus') {
    const file = path.join(xdgConfigDir(), 'mcp.json')
    await writeJsonFile(file, { mcpServers: { pharo: { command: 'npx', args: ['--yes', '@evref-bl/plexus', 'mcp'] } } })
    await save({ mcpEnabled: true, mcpConfig: file })
  } else {
    const file = path.resolve(cwd, await io.ask('Path to an MCP config (JSON with mcpServers)', '.mcp.json'))
    await save({ mcpEnabled: true, mcpConfig: file })
  }
}

// ---------------------------------------------------------------------------
// Image and VM

type ImageChoice = { kind: 'image'; image: PharoImage } | { kind: 'create' } | { kind: 'search' } | { kind: 'skip' }

async function imageStep(config: AgentConfig, io: SetupIo, cwd: string): Promise<PharoImage | undefined> {
  const locations = await launcherLocations()
  let statuses = await imageStatuses(config, { cwd, locations })
  for (let round = 0; round < 3; round += 1) {
    if (statuses.length) io.write(style.dim(`Your images (${tildify(locations.imagesDir)}):\n`))
    const choices: Choice<ImageChoice>[] = statuses.map(status => ({
      label: status.image.name,
      value: { kind: 'image', image: status.image },
      hint: `${describeVersion(status.image)} · ${status.state}${status.image.source === 'found' ? ` · ${tildify(status.image.dir)}` : ''}`,
    }))
    choices.push({ label: 'Create a new image from a template…', value: { kind: 'create' }, hint: 'Pharo, Moose, … (downloads it)' })
    if (round === 0) choices.push({ label: 'Look for other images on this machine…', value: { kind: 'search' } })
    choices.push({ label: 'Skip for now', value: { kind: 'skip' } })
    const selected = statuses.findIndex(status => status.selected)
    const picked = await io.select('Which Pharo image should the agent work in?', choices, selected >= 0 ? selected : 0)
    if (picked.kind === 'image') return picked.image
    if (picked.kind === 'skip') return undefined
    if (picked.kind === 'create') return createStep(io)
    io.write(style.dim('Searching…\n'))
    statuses = await imageStatuses(config, { cwd, locations, all: true })
    if (!statuses.some(status => status.image.source === 'found')) io.write(style.dim('No other images found.\n'))
  }
  return undefined
}

async function createStep(io: SetupIo): Promise<PharoImage | undefined> {
  const locations = await launcherLocations()
  const templates = await listTemplates(locations)
  const official = templates.filter(template => template.group === 'Official distributions')
  const choices: Choice<string>[] = official.slice(0, 10).map(template => ({ label: template.name, value: template.name }))
  choices.push({ label: 'Another template (type its name)…', value: '' })
  const picked = await io.select('Create from which template?', choices)
  const name = picked || await io.ask('Template name (see pharo-agent images templates)', '')
  if (!name) return undefined
  const { findTemplate } = await import('./launcher.ts')
  const template = findTemplate(templates, name)
  const suggested = template.name.replace(/\s*-\s*64bit.*$/i, '').replace(/[()]/g, '').trim() || 'My image'
  const imageName = await io.ask('Name for the new image', suggested)
  io.write(style.dim(`Creating ${imageName} from ${template.name}…\n`))
  const image = await createImage(locations, { name: imageName, template }, { onProgress: printProgress })
  clearProgress()
  io.write(`${style.green('✓')} Created ${style.bold(image.name)} (${describeVersion(image)})\n`)
  return image
}

/** Returns an explicit VM path when the user picks a non-default one. */
async function vmStep(image: PharoImage, io: SetupIo): Promise<string | undefined> {
  const locations = await launcherLocations()
  const resolved = await resolveVm(locations, image)
  const version = image.version ? vmVersionFor(image.version) : undefined
  type VmChoice = { kind: 'auto' } | { kind: 'download' } | { kind: 'vm'; path: string }
  const choices: Choice<VmChoice>[] = []
  const exactMissing = Boolean(version && (!resolved.executable || resolved.missingVersion))
  if (exactMissing && version) choices.push({ label: `Download the Pharo ${versionLabel(version)} VM`, value: { kind: 'download' }, hint: 'recommended: the official VM for this image' })
  if (resolved.executable) choices.push({ label: `${resolved.id}`, value: { kind: 'auto' }, hint: exactMissing ? resolved.reason : `recommended: ${resolved.reason}` })
  // Only VMs that can run this image: 64-bit, and not older than the image.
  const wanted = Number(version ?? 0)
  for (const vm of await listVms(locations)) {
    if (!vm.executable || vm.id === resolved.id || !vm.id.endsWith('-x64')) continue
    if (wanted && Number(/^(\d+)/.exec(vm.id)?.[1] ?? 0) < wanted) continue
    choices.push({ label: vm.id, value: { kind: 'vm', path: vm.executable }, hint: tildify(vm.dir) })
  }
  if (choices.length === 1 && choices[0]!.value.kind === 'auto') {
    io.write(`${style.green('✓')} VM ${resolved.id} ${style.dim(`(${resolved.reason})`)}\n`)
    return undefined
  }
  io.write('\n')
  const picked = await io.select(`Which VM should run ${image.name}?`, choices.slice(0, 9))
  if (picked.kind === 'download' && version) {
    const vm = await downloadVm(locations, version, { onProgress: printProgress })
    clearProgress()
    io.write(`${style.green('✓')} VM ${vm.id} installed\n`)
    return undefined
  }
  return picked.kind === 'vm' ? picked.path : undefined
}

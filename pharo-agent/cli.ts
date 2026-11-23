#!/usr/bin/env node
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AgentConfig, ChatMessage, PermissionMode } from './types.ts'
import { effectivePharoVm, globalConfigPath, loadConfig, mergeConfig, modelCacheDir, pharoModeValue, updateConfigFile } from './config.ts'
import { AgentInterrupted, PharoAgentLoop } from './agent.ts'
import { evaluateSmalltalk, inspectImage, runSmalltalkFile, runSUnit } from './pharo.ts'
import type { PharoEvalResult, PharoRunResult } from './pharo.ts'
import { liveEndpoint, liveEval, liveHealth, liveLoadSnippet, liveSave, liveServerScriptPath, nextLivePort, samePath, startLiveImage } from './live.ts'
import { ActivityRenderer, bannerLines, colorEnabled, formatDuration, renderMarkdown, style, tildify } from './ui.ts'
import type { BannerInfo } from './ui.ts'
import { copyImage, createImage, deleteImage, downloadVm, findImage, findTemplate, launcherLocations, LauncherError, listLauncherImages, listTemplates, listVms, resolveVm, versionLabel, vmVersionFor } from './launcher.ts'
import type { LauncherLocations, PharoImage, Template } from './launcher.ts'
import { describeVersion, imageStatuses, resolveImageRef, selectImage, shortImageName, startPharoImage, stopPharoImage, vmSummary } from './image-manager.ts'
import type { ImageStatus } from './image-manager.ts'
import { buildLlamaCommand, startLlamaServer } from './llama.ts'
import { downloadGguf, downloadGgufSet, formatBytes, HuggingFaceError, listGgufFiles, listOrgModels, resolveGgufShardSet, resolveModelRef, selectGguf } from './hf.ts'
import { builtInTools } from './tools.ts'
import { appendMemory, clearMemory, readMemory } from './memory.ts'
import { listSessions, loadSessionMessages, SessionRecorder } from './sessions.ts'
import { pathExists, resolvePath, shellCommand, which } from './platform.ts'
import { addTask, clearCompletedTasks, readTasks, updateTask } from './task-store.ts'
import { collectDiagnostics, diagnosticsOk } from './diagnostics.ts'
import { discoverSetup } from './setup.ts'
import { VERSION } from './version.ts'
import { findModelPreset, formatModelPreset, loadModelPresets, modelReference, modelShardFiles, type ModelPreset } from './models.ts'

type CommandFn = (args: string[], global: GlobalOptions) => Promise<number>
type GlobalOptions = { configPath?: string; cwd: string }
type ChatState = {
  history: ChatMessage[]
  config: AgentConfig
  recorder?: SessionRecorder
  loop: PharoAgentLoop
  renderer: ActivityRenderer
  verbose: boolean
  rl?: import('node:readline/promises').Interface
  /** Set while the agent (or a user ! / > command) runs; aborting it interrupts. */
  turn?: AbortController
  /** The last /images listing, so /image 3 means what the user just saw. */
  imageListing?: ImageStatus[]
  /** True while a question (approval, picker) waits for an answer, so it isn't queued. */
  asking?: boolean
  /** True while the main prompt waits for input. Lines arriving otherwise are queued. */
  reading?: boolean
}

const commands: Record<string, CommandFn> = {
  ask: askCommand,
  chat: chatCommand,
  setup: setupCommand,
  status: statusCommand,
  configure: configureCommand,
  doctor: doctorCommand,
  eval: evalCommand,
  inspect: inspectCommand,
  st: stCommand,
  test: testCommand,
  tools: toolsCommand,
  tasks: tasksCommand,
  model: modelCommand,
  memory: memoryCommand,
  sessions: sessionsCommand,
  live: liveCommand,
  images: imagesCommand,
  image: imagesCommand,
  version: versionCommand,
  help: helpCommand,
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const global = parseGlobal(argv)
  const args = global.rest
  if (args[0] === '--help' || args[0] === '-h') args[0] = 'help'
  const commandName = args.length === 0 ? 'chat' : args[0] && commands[args[0]] ? args.shift()! : 'ask'
  try {
    return await commands[commandName]!(args, { configPath: global.configPath, cwd: process.cwd() })
  } catch (error) {
    if (error instanceof ChatExit) return 0
    process.stderr.write(`pharo-agent: ${(error as Error).message}\n`)
    return 1
  }
}

function parseGlobal(argv: string[]): { configPath?: string; rest: string[] } {
  const rest = [...argv]
  let configPath: string | undefined
  for (let i = 0; i < rest.length;) {
    if (rest[i] === '--config') {
      configPath = rest[i + 1]
      rest.splice(i, 2)
    } else {
      i += 1
    }
  }
  return { configPath, rest }
}

async function askCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags, positional } = parseFlags(args)
  let config = await runtimeConfig(global, flags)
  let running: Awaited<ReturnType<typeof startLlamaServer>> | undefined
  if (flags['start-server']) {
    const modelPath = await configuredOrDownloadedModel(config)
    running = await startLlamaServer(config, { modelPath })
  }
  const recorder = flags['no-session'] ? undefined : await createOptionalRecorder(positional.join(' ').slice(0, 80))
  try {
    const prompt = positional.join(' ') || await readStdin()
    if (!prompt.trim()) throw new Error('No prompt provided.')
    const resumeMessages = typeof flags.resume === 'string' ? await loadSessionMessages(flags.resume) : undefined
    const renderer = process.stderr.isTTY && !flags.quiet
      ? new ActivityRenderer({ verbose: Boolean(flags.verbose), write: text => process.stderr.write(text) })
      : undefined
    const controller = new AbortController()
    const interrupt = () => controller.abort()
    process.once('SIGINT', interrupt)
    try {
      const answer = await new PharoAgentLoop(config).run(prompt, {
        cwd: global.cwd,
        recorder,
        resumeMessages,
        signal: controller.signal,
        onEvent: renderer?.handle,
      })
      renderer?.stop()
      process.stdout.write(`${answer}\n`)
    } finally {
      renderer?.stop()
      process.off('SIGINT', interrupt)
    }
    return 0
  } finally {
    await running?.stop()
  }
}

async function chatCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags, positional } = parseFlags(args)
  const config = await runtimeConfig(global, flags)
  let running: Awaited<ReturnType<typeof startLlamaServer>> | undefined
  if (flags['start-server']) running = await startLlamaServer(config, { modelPath: await configuredOrDownloadedModel(config) })
  const recorder = await createOptionalRecorder(positional.join(' ').slice(0, 80) || 'chat')
  const history: ChatMessage[] = typeof flags.resume === 'string' ? await loadSessionMessages(flags.resume) : []
  const interactive = Boolean(process.stdin.isTTY)
  const renderer = new ActivityRenderer({ verbose: Boolean(flags.verbose), write: text => process.stdout.write(text) })
  const state: ChatState = { history, config, recorder, loop: new PharoAgentLoop(config), renderer, verbose: Boolean(flags.verbose) }
  try {
    await printChatWelcome(config, global.cwd)
    if (!interactive) {
      const lines = [positional.join(' '), ...(await readStdin()).split(/\r?\n/)]
      for (const raw of lines) {
        const prompt = raw.trim()
        if (!prompt || prompt === '/paste') continue
        await handleChatInput(prompt, state, global)
      }
      return 0
    }
    const readline = await import('node:readline/promises')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 200 })
    state.rl = rl
    let lastSigint = 0
    rl.on('SIGINT', () => {
      if (state.turn) {
        state.turn.abort()
        return
      }
      if (rl.line) {
        // Clear the current input, like a shell.
        rl.write(null, { ctrl: true, name: 'u' })
        return
      }
      if (Date.now() - lastSigint < 2_000) {
        rl.close()
        return
      }
      lastSigint = Date.now()
      process.stdout.write(`\n${style.dim('(press Ctrl+C again to exit, or type /exit)')}\n${style.blue('❯')} `)
    })
    process.stdin.on('keypress', (_text, key: { name?: string } | undefined) => {
      if (key?.name === 'escape' && state.turn) state.turn.abort()
    })
    let closed = false
    rl.once('close', () => {
      closed = true
    })
    // Lines typed while the agent works are kept and run afterwards, in order.
    const queued: string[] = []
    rl.on('line', line => {
      if (!state.reading && !state.asking && line.trim()) queued.push(line)
    })
    if (positional.length) await handleChatInput(positional.join(' '), state, global)
    while (!closed) {
      let prompt: string
      const next = queued.shift()
      if (next !== undefined) {
        prompt = next.trim()
        process.stdout.write(`${await chatPrompt(state.config)}${prompt}\n`)
      } else {
        const label = await chatPrompt(state.config)
        if (queued.length) continue
        state.reading = true
        try {
          prompt = (await rl.question(label)).trim()
        } catch {
          break
        } finally {
          state.reading = false
        }
      }
      if (!prompt) continue
      if (prompt === '/paste') prompt = await readMultilinePrompt(rl)
      if (!prompt) continue
      await handleChatInput(prompt, state, global)
    }
    process.stdout.write('\n')
    return 0
  } finally {
    state.rl?.close()
    await running?.stop()
  }
}

async function setupCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags } = parseFlags(args)
  const destination = flags.local ? path.join(global.cwd, '.pharo-agent.json') : (global.configPath ?? globalConfigPath())
  const config = await loadConfig({ configPath: global.configPath, cwd: global.cwd })
  const discovery = await discoverSetup(global.cwd, config)
  const updates: Partial<AgentConfig> = {}
  const defaults = {
    pharoVm: config.pharoVm ?? discovery.pharoVms[0],
    image: config.image ?? discovery.images[0],
    llamaServer: config.llamaServer ?? discovery.llamaServers[0],
    modelRepo: config.modelRepo,
    publishRepo: config.publishRepo,
    baseUrl: config.baseUrl,
    permissionMode: config.permissionMode,
  }

  if (process.stdin.isTTY && !flags.yes) {
    const readline = await import('node:readline/promises')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      process.stdout.write(setupHeader(discovery))
      updates.pharoVm = await askValue(rl, 'Pharo VM', defaults.pharoVm)
      updates.image = await askValue(rl, 'Pharo image', defaults.image)
      updates.llamaServer = await askValue(rl, 'llama.cpp server', defaults.llamaServer)
      updates.modelRepo = await askValue(rl, 'Hugging Face model repo', defaults.modelRepo)
      updates.publishRepo = await askValue(rl, 'Hugging Face publish repo', defaults.publishRepo)
      updates.baseUrl = await askValue(rl, 'OpenAI-compatible base URL', defaults.baseUrl)
      updates.permissionMode = permissionModeValue(await askValue(rl, 'Permission mode', defaults.permissionMode), defaults.permissionMode)
      updates.allowOutsideWorkspace = await askYesNo(rl, 'Allow model tools outside this workspace', config.allowOutsideWorkspace)
      updates.allowPrivateNetwork = await askYesNo(rl, 'Allow web_fetch to private/local network URLs', config.allowPrivateNetwork)
    } finally {
      rl.close()
    }
  } else {
    if (defaults.pharoVm) updates.pharoVm = defaults.pharoVm
    if (defaults.image) updates.image = defaults.image
    if (defaults.llamaServer) updates.llamaServer = defaults.llamaServer
    updates.modelRepo = defaults.modelRepo
    updates.publishRepo = defaults.publishRepo
    updates.baseUrl = defaults.baseUrl
    updates.permissionMode = defaults.permissionMode
    updates.allowOutsideWorkspace = config.allowOutsideWorkspace
    updates.allowPrivateNetwork = config.allowPrivateNetwork
  }

  let next = await updateConfigFile(destination, updates)
  if (flags['download-model']) {
    const file = await selectGguf(next.modelRepo, next.modelFile)
    const bundle = await downloadGgufSet(file, next, { force: Boolean(flags.force) })
    next = await updateConfigFile(destination, {
      modelRepo: file.repoId,
      model: `${file.repoId}:${file.filename}`,
      modelFile: file.filename,
      modelPath: bundle.primary,
    })
  }

  process.stdout.write(`Saved ${destination}\n`)
  await printStatus(next, global.cwd, { online: Boolean(flags.online) })
  return 0
}

async function configureCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags } = parseFlags(args)
  const destination = flags.local ? path.join(global.cwd, '.pharo-agent.json') : (global.configPath ?? globalConfigPath())
  const updates = configUpdatesFromFlags(flags)
  const next = await updateConfigFile(destination, updates)
  process.stdout.write(`Saved ${destination}\n`)
  if (flags.show) process.stdout.write(`${JSON.stringify(next, null, 2)}\n`)
  return 0
}

async function doctorCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags } = parseFlags(args)
  const config = await loadConfig({ configPath: global.configPath, cwd: global.cwd })
  const checks = await collectDiagnostics(config, global.cwd, { online: Boolean(flags.online) })
  if (flags.json) process.stdout.write(`${JSON.stringify({ config, checks }, null, 2)}\n`)
  else for (const check of checks) process.stdout.write(`${check.ok ? 'ok     ' : 'missing'} ${check.name}: ${check.detail}\n`)
  return diagnosticsOk(checks) ? 0 : 1
}

async function statusCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags } = parseFlags(args)
  const config = await loadConfig({ configPath: global.configPath, cwd: global.cwd })
  await printStatus(config, global.cwd, { online: Boolean(flags.online) })
  return 0
}

async function evalCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags, positional } = parseFlags(args)
  const code = positional.join(' ') || await readStdin()
  if (!code.trim()) throw new Error('Usage: pharo-agent eval "Smalltalk code"')
  return printEvalResult(await evaluateSmalltalk(await runtimeConfig(global, flags), code, { cwd: global.cwd, ui: Boolean(flags.ui) }), Boolean(flags.json))
}

async function inspectCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags, positional } = parseFlags(args)
  return printEvalResult(await inspectImage(await runtimeConfig(global, flags), positional[0], { cwd: global.cwd, pattern: stringFlag(flags.pattern) }), Boolean(flags.json))
}

async function stCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags, positional } = parseFlags(args)
  const script = positional[0]
  if (!script) throw new Error('Usage: pharo-agent st <script.st>')
  return printEvalResult(await runSmalltalkFile(await runtimeConfig(global, flags), script, { cwd: global.cwd }), Boolean(flags.json))
}

async function testCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags } = parseFlags(args)
  return printEvalResult(await runSUnit(await runtimeConfig(global, flags), {
    package: stringFlag(flags.package),
    className: stringFlag(flags.class ?? flags.className),
    selector: stringFlag(flags.selector),
  }, { cwd: global.cwd }), Boolean(flags.json))
}

type ImageSession = {
  config: AgentConfig
  /** Ask the human (chat only); without it nothing is interactive. */
  ask?: (question: string) => Promise<string>
  /** Numbers in /image 3 refer to the last listing shown. */
  listing?: ImageStatus[]
  /** Tell the agent's context what changed (chat only). */
  note?: (text: string) => void
}

const imagesUsage = `Usage: pharo-agent images [list [--all] | where | use <image> | info [image] | templates [filter] [--refresh]
                     | create <name> --template <template> | create <name> --zip <file.zip>
                     | copy <image> <newName> | delete <image> [--yes]
                     | start [image] [--headless] [--no-agent] | stop [image] [--save]
                     | vms | vm download <version>]
<image> is a number from the list, a name (or part of one), or a path to a .image file.`

async function imagesCommand(args: string[], global: GlobalOptions, session?: ImageSession): Promise<number> {
  const known = new Set(['list', 'ls', 'where', 'use', 'select', 'info', 'templates', 'create', 'new', 'copy', 'delete', 'rm', 'start', 'launch', 'stop', 'vms', 'vm', 'help'])
  const sub = args[0] && known.has(args[0]) ? args.shift()! : args[0] && !args[0].startsWith('--') ? 'use' : 'list'
  const { flags, positional } = parseFlags(args)
  const config = session?.config ?? await runtimeConfig(global, flags)
  const locations = await launcherLocations()
  const out = (text: string) => process.stdout.write(text)
  const ref = (value: string | undefined) => value ? resolveImageRef(value, { cwd: global.cwd, listing: session?.listing, locations }) : undefined
  const selectedImage = async (): Promise<PharoImage> => {
    if (!config.image) throw new LauncherError('No image selected. Pick one with /image (chat) or pharo-agent images use <image>.')
    return findImage(locations, resolvePath(config.image, global.cwd), global.cwd)
  }

  if (sub === 'help') {
    out(`${imagesUsage}\n`)
    return 0
  }
  if (sub === 'where') {
    out(`${style.bold('Pharo Launcher locations')}${locations.settingsFile ? '' : style.dim(' (Pharo Launcher settings not found: defaults)')}\n`)
    out(`  images     ${locations.imagesDir} ${style.dim(`(${locations.origin.imagesDir})`)}\n`)
    out(`  vms        ${locations.vmsDir} ${style.dim(`(${locations.origin.vmsDir})`)}\n`)
    out(`  templates  ${locations.sourcesFile}\n`)
    out(`  cache      ${locations.templateCacheDir}\n`)
    if (locations.settingsFile) out(`  settings   ${locations.settingsFile}\n`)
    return 0
  }
  if (sub === 'list' || sub === 'ls') {
    if (flags.all) out(style.dim('Searching the machine for other images…\n'))
    const statuses = await imageStatuses(config, { cwd: global.cwd, all: Boolean(flags.all), locations })
    if (session) session.listing = statuses
    if (flags.json) {
      out(`${JSON.stringify(statuses, null, 2)}\n`)
      return 0
    }
    printImageTable(statuses, locations)
    return 0
  }
  if (sub === 'use' || sub === 'select') {
    let image = await ref(positional[0])
    if (!image) {
      if (!session?.ask) throw new LauncherError('Usage: pharo-agent images use <image>')
      image = await pickImage(session, global, locations)
      if (!image) return 0
    }
    await useImage(image, config, global, session, flags)
    return 0
  }
  if (sub === 'info') {
    const image = await ref(positional[0]) ?? await selectedImage()
    const [status] = (await imageStatuses({ ...config, image: image.imagePath }, { cwd: global.cwd, locations })).filter(entry => entry.image.imagePath === image.imagePath)
    out(`${style.bold(image.name)}\n`)
    out(`  path      ${image.imagePath}\n`)
    out(`  version   ${describeVersion(image)}${image.arch ? ` · ${image.arch}-bit` : ''}${image.formatNumber ? ` · format ${image.formatNumber}` : ''}\n`)
    if (image.template) out(`  template  ${image.template}\n`)
    out(`  vm        ${await vmSummary(image)}\n`)
    out(`  state     ${status ? stateLabel(status) : 'stopped'}\n`)
    if (image.modifiedAt) out(`  saved     ${new Date(image.modifiedAt).toLocaleString()}\n`)
    return 0
  }
  if (sub === 'templates') {
    const templates = await listTemplates(locations, { refresh: Boolean(flags.refresh) })
    const filter = positional.join(' ').toLowerCase()
    const shown = templates.filter(template => !filter || template.name.toLowerCase().includes(filter) || template.group.toLowerCase().includes(filter))
    if (flags.json) {
      out(`${JSON.stringify(shown, null, 2)}\n`)
      return 0
    }
    let group = ''
    for (const template of shown) {
      if (template.group !== group) {
        group = template.group
        out(`\n${style.bold(group)}${group === 'Local templates' ? style.dim(' (already downloaded)') : ''}\n`)
      }
      out(`  ${template.name}\n`)
    }
    out(style.dim(`\n${shown.length} templates. Create one: pharo-agent images create <name> --template "<template>"\n`))
    return 0
  }
  if (sub === 'create' || sub === 'new') {
    let name = positional[0]
    if (!name && session?.ask) name = (await session.ask('  New image name: ')).trim()
    if (!name) throw new LauncherError(`Usage: pharo-agent images create <name> --template "<template>"`)
    const zip = stringFlag(flags.zip)
    const template = zip ? undefined : await chooseTemplate(locations, stringFlag(flags.template) ?? positional.slice(1).join(' '), session)
    if (!zip && !template) return 0
    out(`Creating ${style.bold(name)} from ${template?.name ?? zip}…\n`)
    const image = await createImage(locations, { name, template, zipPath: zip ? path.resolve(global.cwd, zip) : undefined }, { onProgress: printProgress })
    clearProgress()
    out(`${style.green('✓')} Created ${style.bold(image.name)} (${describeVersion(image)}) in ${image.dir}\n`)
    const resolved = await resolveVm(locations, image)
    if (!resolved.executable && resolved.missingVersion) {
      out(`Downloading the Pharo ${versionLabel(resolved.missingVersion)} VM…\n`)
      await downloadVm(locations, vmVersionFor(resolved.missingVersion), { onProgress: printProgress })
      clearProgress()
    }
    session?.note?.(`[I created the Pharo image "${image.name}" (${describeVersion(image)})]`)
    if (flags.use || (session?.ask && /^(y|yes|)$/i.test((await session.ask(`  Work in ${image.name} now? [Y/n] `)).trim()))) {
      await useImage(image, config, global, session, flags)
    }
    return 0
  }
  if (sub === 'copy') {
    const image = await ref(positional[0])
    const newName = positional.slice(1).join(' ')
    if (!image || !newName) throw new LauncherError('Usage: pharo-agent images copy <image> <newName>')
    const copy = await copyImage(locations, image, newName)
    out(`${style.green('✓')} Copied ${image.name} to ${style.bold(copy.name)}\n`)
    return 0
  }
  if (sub === 'delete' || sub === 'rm') {
    const image = await ref(positional[0])
    if (!image) throw new LauncherError('Usage: pharo-agent images delete <image>')
    if (!flags.yes) {
      if (!session?.ask) throw new LauncherError(`This deletes ${image.dir} for good. Add --yes to confirm.`)
      const answer = (await session.ask(`  Delete ${style.bold(image.name)} and everything in ${image.dir}? Type the image name to confirm: `)).trim()
      if (answer !== image.name) {
        out('Not deleted.\n')
        return 0
      }
    }
    await deleteImage(locations, image)
    if (config.image && await samePath(resolvePath(config.image, global.cwd), image.imagePath)) config.image = undefined
    out(`${style.green('✓')} Deleted ${image.name}\n`)
    return 0
  }
  if (sub === 'start' || sub === 'launch') {
    const image = await ref(positional[0]) ?? await selectedImage()
    await startAndReport(image, { headless: Boolean(flags.headless), agent: !flags['no-agent'] })
    if (!config.image || !await samePath(resolvePath(config.image, global.cwd), image.imagePath)) {
      if (session?.ask && /^(y|yes|)$/i.test((await session.ask(`  Work in ${image.name} now? [Y/n] `)).trim())) await useImage(image, config, global, session, { ...flags, 'no-start': true })
    }
    return 0
  }
  if (sub === 'stop') {
    const image = await ref(positional[0]) ?? await selectedImage()
    out(`Stopping ${image.name}${flags.save ? ' (saving first)' : ''}…\n`)
    const result = await stopPharoImage(image, { save: Boolean(flags.save) })
    out(`${style.green('✓')} ${image.name} ${result.saved ? 'saved and stopped' : result.killed ? 'stopped (process terminated, unsaved changes lost)' : 'stopped'}\n`)
    session?.note?.(`[I stopped the Pharo image "${image.name}"${result.saved ? ' after saving it' : ''}]`)
    return 0
  }
  if (sub === 'vms') {
    const vms = await listVms(locations)
    out(`${style.bold('VMs')} ${style.dim(locations.vmsDir)}\n`)
    for (const vm of vms) out(`  ${vm.id.padEnd(10)} ${vm.executable ? style.green('✓') : style.red('✗ no executable')} ${style.dim(vm.executable ?? vm.dir)}\n`)
    if (!vms.length) out('  (none) Download one: pharo-agent images vm download 140\n')
    return 0
  }
  if (sub === 'vm') {
    if (positional[0] !== 'download' || !positional[1]) throw new LauncherError('Usage: pharo-agent images vm download <version>   e.g. 140 for Pharo 14')
    const vm = await downloadVm(locations, positional[1].replace('.', ''), { onProgress: printProgress })
    clearProgress()
    out(`${style.green('✓')} VM ${vm.id} ready: ${vm.executable}\n`)
    return 0
  }
  throw new LauncherError(imagesUsage)
}

async function useImage(image: PharoImage, config: AgentConfig, global: GlobalOptions, session: ImageSession | undefined, flags: Record<string, unknown>): Promise<void> {
  const saved = await selectImage(config, image, { cwd: global.cwd, persist: !flags['no-save'], configPath: global.configPath })
  process.stdout.write(`${style.green('✓')} Working in ${style.bold(image.name)} ${style.dim(`(${describeVersion(image)})`)}${saved ? style.dim(` · saved in ${tildify(saved)}`) : ''}\n`)
  const [status] = (await imageStatuses(config, { cwd: global.cwd })).filter(entry => entry.selected)
  session?.note?.(`[I switched the agent to the Pharo image "${image.name}" (${describeVersion(image)}), currently ${status?.state ?? 'stopped'}]`)
  if (!status || status.state === 'live' || flags['no-start']) {
    if (status?.state === 'live') process.stdout.write(`  ${style.green('● live')} at ${status.liveUrl}: ask away.\n`)
    return
  }
  if (status.state === 'running') {
    process.stdout.write(`  ${style.yellow('● running')} without the agent server. Paste this in its Playground to connect:\n  ${style.cyan(liveLoadSnippet(await nextLivePort()))}\n`)
    return
  }
  if (!session?.ask) {
    process.stdout.write(style.dim(`  Stopped: questions run in a throwaway headless copy. Start it with: pharo-agent images start\n`))
    return
  }
  const answer = (await session.ask(`  Start it? ${style.dim('[w]indow / [h]eadless / [n]o (headless copies per question)')} `)).trim().toLowerCase()
  if (answer === 'w' || answer === 'window' || answer === 'y' || answer === 'yes' || answer === '') await startAndReport(image, { headless: false })
  else if (answer === 'h' || answer === 'headless') await startAndReport(image, { headless: true })
}

async function startAndReport(image: PharoImage, options: { headless?: boolean; agent?: boolean }): Promise<void> {
  process.stdout.write(`Starting ${style.bold(image.name)}${options.headless ? ' (headless)' : ''}…\n`)
  const started = await startPharoImage(image, options)
  if (options.agent === false) {
    process.stdout.write(`${style.green('✓')} Started ${image.name} (pid ${started.pid ?? '?'}) without the agent server\n`)
    return
  }
  process.stdout.write(`${style.green('● live')} ${started.health.pharo ?? ''} at ${started.url}${started.alreadyRunning ? style.dim(' (was already running)') : ''}\n`)
}

async function pickImage(session: ImageSession, global: GlobalOptions, locations: LauncherLocations): Promise<PharoImage | undefined> {
  const statuses = await imageStatuses(session.config, { cwd: global.cwd, locations })
  session.listing = statuses
  printImageTable(statuses, locations)
  const answer = (await session.ask!(`  Select an image ${style.dim('(number or name; enter to cancel; "all" to search the machine)')}: `)).trim()
  if (!answer) return undefined
  if (answer === 'all') {
    process.stdout.write(style.dim('Searching the machine for other images…\n'))
    session.listing = await imageStatuses(session.config, { cwd: global.cwd, all: true, locations })
    printImageTable(session.listing, locations)
    const second = (await session.ask!('  Select an image (number or name; enter to cancel): ')).trim()
    return second ? resolveImageRef(second, { cwd: global.cwd, listing: session.listing, locations }) : undefined
  }
  return resolveImageRef(answer, { cwd: global.cwd, listing: statuses, locations })
}

async function chooseTemplate(locations: LauncherLocations, query: string, session?: ImageSession): Promise<Template | undefined> {
  const templates = await listTemplates(locations)
  if (!query && !session?.ask) throw new LauncherError('Pass --template "<template>" (see pharo-agent images templates)')
  if (!query) query = (await session!.ask!(`  Template ${style.dim('(name or part of it, e.g. "Pharo 14", "Moose")')}: `)).trim()
  if (!query) return undefined
  try {
    return findTemplate(templates, query)
  } catch (error) {
    if (!session?.ask) throw error
    const matches = templates.filter(template => template.name.toLowerCase().includes(query.toLowerCase()))
    if (!matches.length) throw error
    matches.forEach((template, index) => process.stdout.write(`  ${style.cyan(String(index + 1).padStart(2))}  ${template.name} ${style.dim(`· ${template.group}`)}\n`))
    const pick = Number((await session.ask(`  Template number: `)).trim())
    return matches[pick - 1]
  }
}

function stateLabel(status: ImageStatus): string {
  if (status.state === 'live') return `${style.green('● live')} ${style.dim(status.liveUrl?.replace('http://', '') ?? '')}`
  if (status.state === 'running') return `${style.yellow('● running')} ${style.dim('no agent server')}`
  return style.dim('○ stopped')
}

function printImageTable(statuses: ImageStatus[], locations: LauncherLocations): void {
  const out = (text: string) => process.stdout.write(text)
  if (!statuses.length) {
    out(`No images in ${locations.imagesDir}.\nCreate one: /image create (chat) or pharo-agent images create <name> --template "Pharo 14.0 - 64bit (stable)"\n`)
    return
  }
  const width = Math.min(46, Math.max(...statuses.map(status => status.image.name.length)) + 2)
  out(`${style.dim(`     #  ${'Image'.padEnd(width)}${'Pharo'.padEnd(8)}State`)}\n`)
  let source = ''
  for (const status of statuses) {
    if (status.image.source !== source) {
      source = status.image.source
      if (source === 'found') out(style.dim(`  Other images on this machine\n`))
    }
    const marker = status.selected ? style.blue('❯') : ' '
    const name = status.image.name.length > width - 2 ? `${status.image.name.slice(0, width - 3)}…` : status.image.name
    out(`  ${marker} ${style.cyan(String(status.index).padStart(2))}  ${(status.selected ? style.bold(name) : name).padEnd(width + (status.selected && colorEnabled ? 9 : 0))}${versionLabel(status.image.version).padEnd(8)}${stateLabel(status)}\n`)
    if (status.image.source === 'found') out(style.dim(`         ${tildify(status.image.imagePath)}\n`))
  }
  out(style.dim(`\n  ${locations.imagesDir} · /image <#> to work in one · /image create · /image start · /image stop\n`))
}

let progressShown = false
function printProgress(event: { label: string; received: number; total?: number }): void {
  if (!process.stderr.isTTY) return
  progressShown = true
  const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1)
  const percent = event.total ? Math.floor((event.received / event.total) * 100) : undefined
  const bar = percent === undefined ? '' : `${'█'.repeat(Math.floor(percent / 5))}${'░'.repeat(20 - Math.floor(percent / 5))} ${percent}%`
  process.stderr.write(`\r\x1b[2K  ↓ ${event.label}  ${bar}  ${mb(event.received)}${event.total ? `/${mb(event.total)}` : ''} MB`)
}

function clearProgress(): void {
  if (progressShown) process.stderr.write('\r\x1b[2K')
  progressShown = false
}

/** Split a chat command line, keeping "quoted words" together. */
export function splitArgs(line: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line))) args.push(match[1] ?? match[2] ?? match[3]!)
  return args
}

async function liveCommand(args: string[], global: GlobalOptions, sessionConfig?: AgentConfig): Promise<number> {
  const sub = args.shift() ?? 'status'
  const { flags } = parseFlags(args)
  const config = sessionConfig ?? await runtimeConfig(global, flags)
  if (sub === 'status') {
    const health = await liveHealth(config)
    if (health?.ok) {
      process.stdout.write(`${style.green('● live')} ${health.pharo ?? 'Pharo'} at ${health.url}\n  image: ${health.image ?? '?'}\n  requests served: ${health.requests ?? 0}\n  mode: ${config.pharoMode}\n`)
      return 0
    }
    process.stdout.write(`${style.yellow('○ no live image')}${health ? ` (${health.url}: ${health.error ?? 'not answering'})` : ''}\n`)
    process.stdout.write(`  mode: ${config.pharoMode}${config.pharoMode === 'auto' ? ' (falls back to a headless copy of the image)' : ''}\n\n`)
    process.stdout.write(`Connect your open image: paste this into a Playground and Do it (Cmd+D):\n\n  ${style.cyan(liveLoadSnippet(await nextLivePort()))}\n\n`)
    process.stdout.write(`Or pick and start an image: ${style.cyan('/image')} (chat) or ${style.cyan('pharo-agent images start <image>')}\n`)
    return 1
  }
  if (sub === 'snippet') {
    const port = flags.port ? Number(flags.port) : await nextLivePort()
    process.stdout.write(`${liveLoadSnippet(port)}\n`)
    if (!flags.quiet) process.stderr.write(style.dim(`\nPaste it into a Playground of your open image and Do it (Cmd+D).\nThe server listens on 127.0.0.1:${port} and writes its token to ~/.pharo-agent/endpoints/${port}.json.\nThen select that image (/image) so questions go to it.\nServer source: ${liveServerScriptPath()}\n`))
    return 0
  }
  if (sub === 'start') {
    const existing = await liveHealth(config)
    if (existing?.ok) {
      process.stdout.write(`A live image is already running at ${existing.url} (${existing.image ?? existing.pharo ?? ''}).\n`)
      return 0
    }
    process.stdout.write(`Starting ${config.image ?? 'the configured image'} with the live server...\n`)
    const started = await startLiveImage(config, {
      headless: Boolean(flags.headless),
      port: flags.port ? Number(flags.port) : undefined,
      cwd: global.cwd,
    })
    process.stdout.write(`${style.green('● live')} ${started.health.pharo ?? 'Pharo'} at ${started.url} (pid ${started.pid ?? '?'})\n  log: ${started.logPath}\n`)
    return 0
  }
  if (sub === 'stop' || sub === 'save') {
    const endpoint = await liveEndpoint(config)
    const health = await liveHealth(config)
    if (!endpoint || !health?.ok) {
      process.stdout.write('No live image is running.\n')
      return 1
    }
    if (sub === 'save') {
      const saved = await liveSave(endpoint)
      process.stdout.write(saved.ok ? `Saving ${saved.image ?? 'the image'}.\n` : `Save failed: ${saved.error}\n`)
      return saved.ok ? 0 : 1
    }
    await liveEval(endpoint, `[ ((Smalltalk at: #PharoAgentLive) at: #stop) value ] forkAt: Processor userBackgroundPriority. 'stopping'`, { timeoutMs: 5_000 })
    process.stdout.write('Live server stopped. The image keeps running.\n')
    return 0
  }
  throw new Error('Usage: pharo-agent live <status|start [--headless] [--port N]|snippet|stop|save>')
}

function printEvalResult(result: PharoEvalResult | PharoRunResult, json: boolean): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.ok ? 0 : 1
  }
  if (!('backend' in result)) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    return result.exitCode
  }
  if (result.output && !result.ok) process.stderr.write(`${result.output}\n`)
  if (result.result !== undefined) process.stdout.write(`${result.result}\n`)
  if (!result.ok && result.error) {
    process.stderr.write(`${result.error}\n`)
    for (const line of result.stack?.slice(0, 8) ?? []) process.stderr.write(`  ${line}\n`)
  }
  for (const warning of result.warnings ?? []) process.stderr.write(`warning: ${warning}\n`)
  return result.ok ? 0 : 1
}

async function toolsCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags } = parseFlags(args)
  const tools = builtInTools()
  if (flags.json) process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
  else for (const tool of tools) process.stdout.write(`${tool.name}${tool.readOnly ? ' [read]' : ' [write]'} - ${tool.description}\n`)
  void global
  return 0
}

async function tasksCommand(args: string[], global: GlobalOptions): Promise<number> {
  const sub = args.shift() ?? 'list'
  const { flags, positional } = parseFlags(args)
  if (sub === 'list') {
    const tasks = await readTasks(global.cwd)
    if (flags.json) process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`)
    else for (const task of tasks) process.stdout.write(`${task.id}\t${task.status}\t${task.content}\n`)
    return 0
  }
  if (sub === 'add') {
    const content = positional.join(' ')
    if (!content) throw new Error('Usage: pharo-agent tasks add <content>')
    process.stdout.write(`${JSON.stringify(await addTask(content, global.cwd), null, 2)}\n`)
    return 0
  }
  if (sub === 'update') {
    const id = positional[0]
    if (!id) throw new Error('Usage: pharo-agent tasks update <id> [--status pending|in_progress|completed|blocked] [--content text]')
    const status = stringFlag(flags.status)
    if (status && !['pending', 'in_progress', 'completed', 'blocked'].includes(status)) throw new Error(`Invalid status: ${status}`)
    const content = stringFlag(flags.content) ?? (positional.slice(1).join(' ') || undefined)
    const updated = await updateTask(id, { status: status as 'pending' | 'in_progress' | 'completed' | 'blocked' | undefined, content }, global.cwd)
    if (!updated) throw new Error(`Task not found: ${id}`)
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`)
    return 0
  }
  if (sub === 'clear-completed') {
    process.stdout.write(`removed ${await clearCompletedTasks(global.cwd)} completed tasks\n`)
    return 0
  }
  throw new Error('Usage: pharo-agent tasks <list|add|update|clear-completed>')
}

async function modelCommand(args: string[], global: GlobalOptions): Promise<number> {
  const known = new Set(['current', 'list', 'presets', 'files', 'download', 'use', 'serve', 'publish'])
  const sub = args[0] && known.has(args[0]) ? args.shift()! : args.length ? 'use' : 'menu'
  const { flags, positional } = parseFlags(args)
  const config = await loadConfig({ configPath: global.configPath, cwd: global.cwd })
  const presets = await loadModelPresets(global.cwd)
  if (sub === 'menu' || sub === 'presets' || (sub === 'list' && !flags.files && !positional[0] && !flags.org)) {
    if (sub === 'menu') await printModelMenu(config, presets)
    else await printModelPresets(presets, Boolean(flags.json))
    return 0
  }
  if (sub === 'list' || sub === 'files') {
    if (flags.org) {
      const repos = await listOrgModels(String(flags.org))
      process.stdout.write(flags.json ? `${JSON.stringify(repos, null, 2)}\n` : `${repos.join('\n')}\n`)
      return 0
    }
    const preset = findModelPreset(positional[0], presets)
    const ref = preset ? { repoId: preset.repoId, selector: preset.filename } : resolveModelRef(positional[0], config.modelRepo)
    const files = await listGgufFiles(ref.repoId)
    if (flags.json) process.stdout.write(`${JSON.stringify(files, null, 2)}\n`)
    else if (files.length === 0) process.stdout.write(`No .gguf files found in ${ref.repoId}\n`)
    else for (const file of files) process.stdout.write(`${file.repoId}:${file.filename}\t${file.quant ?? '-'}\t${formatBytes(file.size)}\n`)
    return 0
  }
  if (sub === 'download') {
    const preset = findModelPreset(positional[0], presets)
    const ref = preset ? { repoId: preset.repoId, selector: preset.filename } : resolveModelRef(positional[0], config.modelRepo)
    const files = flags.all
      ? await listGgufFiles(ref.repoId)
      : preset
        ? [{ repoId: preset.repoId, filename: preset.filename }]
        : [await selectGguf(ref.repoId, ref.selector ?? config.modelFile)]
    if (files.length === 0) throw new HuggingFaceError(`No .gguf files found in ${ref.repoId}`)
    if (flags['dry-run']) {
      const planned = flags.all ? files : preset ? modelShardFiles(preset) : await resolveGgufShardSet(files[0]!)
      for (const file of planned) process.stdout.write(`would download ${file.repoId}:${file.filename}\n`)
      return 0
    }
    if (flags.all) for (const file of files) {
      const downloaded = await downloadGguf(file, config, { force: Boolean(flags.force) })
      process.stdout.write(`${file.repoId}:${file.filename} -> ${downloaded}\n`)
    }
    else {
      const bundle = preset
        ? await downloadPreset(preset, config, { force: Boolean(flags.force) })
        : await downloadGgufSet(files[0]!, config, { force: Boolean(flags.force) })
      for (const item of bundle.files) process.stdout.write(`${item.file.repoId}:${item.file.filename} -> ${item.path}\n`)
      if (flags.use) {
        await updateConfigFile(global.configPath ?? globalConfigPath(), {
          modelRepo: preset?.repoId ?? files[0]!.repoId,
          publishRepo: preset?.publishRepo ?? config.publishRepo,
          model: preset?.id ?? `${files[0]!.repoId}:${files[0]!.filename}`,
          modelFile: preset?.filename ?? files[0]!.filename,
          modelPath: bundle.primary,
        })
      }
    }
    return 0
  }
  if (sub === 'use') {
    const refValue = positional[0]
    if (!refValue) throw new Error('Usage: pharo-agent model use <name|repo:filename|path.gguf>')
    const destination = flags.local ? path.join(global.cwd, '.pharo-agent.json') : (global.configPath ?? globalConfigPath())
    const preset = findModelPreset(refValue, presets)
    if (preset) {
      await updateConfigFile(destination, {
        modelRepo: preset.repoId,
        publishRepo: preset.publishRepo ?? config.publishRepo,
        model: preset.id,
        modelFile: preset.filename,
        modelPath: null,
      })
      process.stdout.write(`Selected ${preset.id}: ${modelReference(preset)}\n`)
    } else if (refValue.endsWith('.gguf') && await pathExists(refValue)) {
      await updateConfigFile(destination, { modelPath: path.resolve(global.cwd, refValue), model: path.basename(refValue), modelFile: path.basename(refValue) })
      process.stdout.write(`Selected local file ${refValue}\n`)
    } else {
      const ref = resolveModelRef(refValue, config.modelRepo)
      const file = await selectGguf(ref.repoId, ref.selector ?? config.modelFile)
      await updateConfigFile(destination, { modelRepo: file.repoId, model: `${file.repoId}:${file.filename}`, modelFile: file.filename })
      process.stdout.write(`Selected ${file.repoId}:${file.filename}\n`)
    }
    process.stdout.write(`Saved ${destination}\n`)
    return 0
  }
  if (sub === 'serve') {
    const refValue = positional[0]
    let modelPath = config.modelPath
    let hfRef: string | undefined
    if (flags.port) config.llamaPort = Number(flags.port)
    const preset = findModelPreset(refValue, presets)
    if (typeof flags.hf === 'string') hfRef = flags.hf
    else if (flags.hf && refValue) hfRef = refValue
    else if (preset) hfRef = modelReference(preset)
    else if (refValue?.endsWith('.gguf')) modelPath = path.resolve(global.cwd, refValue)
    else if (refValue) {
      const ref = resolveModelRef(refValue, config.modelRepo)
      modelPath = (await downloadGgufSet(await selectGguf(ref.repoId, ref.selector ?? config.modelFile), config)).primary
    } else if (!modelPath) modelPath = await configuredOrDownloadedModel(config)
    const command = await buildLlamaCommand(config, { modelPath, hfRef, allowMissingServer: Boolean(flags['print-command']) })
    if (flags['print-command']) {
      process.stdout.write(`${command.join(' ')}\n`)
      return 0
    }
    process.stdout.write(`Starting llama.cpp: ${command.join(' ')}\n`)
    const running = await startLlamaServer(config, { modelPath, hfRef, waitSeconds: 120 })
    process.stdout.write(`Server ready at ${config.baseUrl}; log ${running.logPath}\n`)
    return await new Promise(resolve => running.process.on('exit', code => resolve(code ?? 0)))
  }
  if (sub === 'publish') {
    const source = positional[0]
    if (!source?.endsWith('.gguf')) throw new Error('Usage: pharo-agent model publish <file.gguf>')
    const sourcePath = path.resolve(global.cwd, source)
    if (!flags['dry-run'] && !await pathExists(sourcePath)) throw new Error(`GGUF file not found: ${source}`)
    const hf = await which('hf') ?? await which('huggingface-cli')
    if (!hf) throw new Error('Hugging Face CLI not found. Install huggingface_hub and run `hf auth login`.')
    const repo = stringFlag(flags.repo) ?? config.publishRepo
    const command = [hf, 'upload', repo, sourcePath]
    if (flags['path-in-repo']) command.push(String(flags['path-in-repo']))
    command.push('--repo-type', 'model')
    command.push('--commit-message', String(flags['commit-message'] ?? 'Upload Pharo Agent GGUF model'))
    if (flags['create-pr']) command.push('--create-pr')
    if (flags.token) command.push('--token', String(flags.token))
    if (flags['dry-run']) process.stdout.write(`${command.join(' ')}\n`)
    else await new Promise<void>((resolve, reject) => spawn(command[0]!, command.slice(1), { stdio: 'inherit' }).on('exit', code => code === 0 ? resolve() : reject(new Error(`hf upload exited ${code}`))))
    return 0
  }
  const currentPreset = currentModelPreset(config, presets)
  process.stdout.write(`${JSON.stringify({ preset: currentPreset?.id, modelRepo: config.modelRepo, publishRepo: config.publishRepo, model: config.model, modelFile: config.modelFile, modelPath: config.modelPath, modelCacheDir: modelCacheDir(config), baseUrl: config.baseUrl }, null, 2)}\n`)
  return 0
}

async function printModelMenu(config: AgentConfig, presets: ModelPreset[]): Promise<void> {
  const current = currentModelPreset(config, presets)
  process.stdout.write(`${bold('Models')}\n`)
  process.stdout.write(`Current: ${current ? `${current.id} (${current.name})` : config.model ?? config.modelFile ?? config.modelPath ?? config.baseUrl}\n`)
  process.stdout.write(`Download source: ${config.modelRepo}\n`)
  process.stdout.write(`Publish target: ${config.publishRepo}\n\n`)
  await printModelPresets(presets, false)
  process.stdout.write(`
Use:
  /model use qwen-coder-7b
  /model download qwen-coder-7b --use
  /model serve qwen-coder-7b
  /model files qwen-coder-7b

Add future aliases in ~/.config/pharo-agent/models.json or .pharo-agent.models.json.
`)
}

async function printModelPresets(presets: ModelPreset[], json: boolean): Promise<void> {
  if (json) {
    process.stdout.write(`${JSON.stringify(presets, null, 2)}\n`)
    return
  }
  process.stdout.write('Predefined models:\n')
  for (const preset of presets) process.stdout.write(`${formatModelPreset(preset)}\n`)
}

async function downloadPreset(preset: ModelPreset, config: AgentConfig, options: { force?: boolean }) {
  const files = modelShardFiles(preset)
  const downloaded: { file: { repoId: string; filename: string }; path: string }[] = []
  for (const file of files) downloaded.push({ file, path: await downloadGguf(file, config, options) })
  return { primary: downloaded[0]!.path, files: downloaded }
}

function currentModelPreset(config: AgentConfig, presets: ModelPreset[]): ModelPreset | undefined {
  if (config.model) {
    const byName = findModelPreset(config.model, presets)
    if (byName) return byName
  }
  return presets.find(preset => preset.repoId === config.modelRepo && preset.filename === config.modelFile)
}

async function memoryCommand(args: string[], global: GlobalOptions): Promise<number> {
  const sub = args.shift() ?? 'read'
  const { positional } = parseFlags(args)
  const config = await loadConfig({ configPath: global.configPath, cwd: global.cwd })
  if (sub === 'read') process.stdout.write(await readMemory(config, global.cwd))
  else if (sub === 'write') await appendMemory(config, positional.join(' '), global.cwd)
  else if (sub === 'clear') await clearMemory(config, global.cwd)
  else throw new Error('Usage: pharo-agent memory <read|write|clear>')
  return 0
}

async function sessionsCommand(args: string[]): Promise<number> {
  const sub = args.shift() ?? 'list'
  if (sub === 'list') {
    for (const session of await listSessions()) process.stdout.write(`${session.id}\t${session.updatedAt}\t${session.title ?? ''}\n`)
    return 0
  }
  if (sub === 'show') {
    const id = args[0]
    if (!id) throw new Error('Usage: pharo-agent sessions show <id>')
    process.stdout.write(`${JSON.stringify(await loadSessionMessages(id), null, 2)}\n`)
    return 0
  }
  throw new Error('Usage: pharo-agent sessions <list|show>')
}

async function versionCommand(): Promise<number> {
  process.stdout.write(`pharo-agent ${VERSION}\n`)
  return 0
}

async function helpCommand(): Promise<number> {
  process.stdout.write(`Pharo Agent

Usage:
  pharo-agent
  pharo-agent ask [--start-server] [prompt]
  pharo-agent chat [--start-server]
  pharo-agent setup [--local] [--online] [--download-model]
  pharo-agent status [--online]
  pharo-agent configure [--pharo-vm PATH] [--image IMAGE] [--model PATH_OR_REF]
  pharo-agent doctor [--online]
  pharo-agent images [list [--all]|where|use|info|templates|create|copy|delete|start|stop|vms|vm download]
  pharo-agent live [status|start|snippet|stop|save]
  pharo-agent eval "Smalltalk code"
  pharo-agent inspect [ClassOrPackage] [--pattern text]
  pharo-agent st script.st
  pharo-agent test [--package Pkg] [--class TestClass] [--selector testName]
  pharo-agent model [list|files|download|use|serve|publish|current]
  pharo-agent tools
  pharo-agent tasks <list|add|update|clear-completed>
  pharo-agent memory <read|write|clear>
  pharo-agent sessions <list|show>

Global options:
  --config PATH

Permission modes:
  --permission-mode ask|auto|read-only|dangerous

Pharo modes (where Smalltalk runs):
  --pharo-mode auto|live|headless   auto = live image when connected, else headless copy

Safety flags:
  --allow-outside-workspace true|false
  --allow-private-network true|false
`)
  return 0
}

async function runtimeConfig(global: GlobalOptions, flags: Record<string, unknown>): Promise<AgentConfig> {
  return mergeConfig(await loadConfig({ configPath: global.configPath, cwd: global.cwd }), configUpdatesFromFlags(flags))
}

function configUpdatesFromFlags(flags: Record<string, unknown>): Partial<AgentConfig> {
  const updates: Partial<AgentConfig> = {}
  assignFlag(updates, flags, 'pharo-vm', 'pharoVm')
  assignFlag(updates, flags, 'image', 'image')
  assignFlag(updates, flags, 'model-repo', 'modelRepo')
  assignFlag(updates, flags, 'publish-repo', 'publishRepo')
  assignFlag(updates, flags, 'model', 'model')
  assignFlag(updates, flags, 'model-file', 'modelFile')
  assignFlag(updates, flags, 'model-path', 'modelPath')
  assignFlag(updates, flags, 'base-url', 'baseUrl')
  assignFlag(updates, flags, 'api-key', 'apiKey')
  assignFlag(updates, flags, 'llama-server', 'llamaServer')
  assignFlag(updates, flags, 'model-cache-dir', 'modelCacheDir')
  assignFlag(updates, flags, 'mcp-config', 'mcpConfig')
  assignFlag(updates, flags, 'memory-file', 'memoryFile')
  if (flags.timeout) updates.timeoutSeconds = Number(flags.timeout)
  if (flags['max-iterations']) updates.maxIterations = Number(flags['max-iterations'])
  if (flags.temperature) updates.temperature = Number(flags.temperature)
  if (flags['llama-port']) updates.llamaPort = Number(flags['llama-port'])
  if (flags['permission-mode']) updates.permissionMode = String(flags['permission-mode']) as PermissionMode
  if (flags['pharo-mode']) updates.pharoMode = pharoModeValue(String(flags['pharo-mode']))
  if (flags['live-port']) updates.livePort = Number(flags['live-port'])
  assignFlag(updates, flags, 'live-url', 'liveUrl')
  assignFlag(updates, flags, 'live-token', 'liveToken')
  if (flags.headless !== undefined) updates.headless = String(flags.headless) !== 'false'
  if (flags['allow-outside-workspace'] !== undefined) updates.allowOutsideWorkspace = boolFlag(flags['allow-outside-workspace'])
  if (flags['allow-private-network'] !== undefined) updates.allowPrivateNetwork = boolFlag(flags['allow-private-network'])
  return updates
}

function assignFlag<T extends keyof AgentConfig>(updates: Partial<AgentConfig>, flags: Record<string, unknown>, flag: string, key: T): void {
  if (flags[flag] !== undefined) updates[key] = flags[flag] as AgentConfig[T]
}

async function configuredOrDownloadedModel(config: AgentConfig): Promise<string> {
  if (config.modelPath) return config.modelPath
  const ref = resolveModelRef(config.modelFile ?? config.model, config.modelRepo)
  return (await downloadGgufSet(await selectGguf(ref.repoId, ref.selector), config)).primary
}

function parseFlags(args: string[]): { flags: Record<string, unknown>; positional: string[] } {
  const flags: Record<string, unknown> = {}
  const positional: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq > 0 ? eq : undefined)
    if (eq > 0) {
      flags[name] = arg.slice(eq + 1)
      continue
    }
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      flags[name] = next
      i += 1
    } else {
      flags[name] = true
    }
  }
  return { flags, positional }
}

function stringFlag(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function boolFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
  return Boolean(value)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

/** One line of chat input: slash command, `!` shell, `>` Smalltalk, or a prompt for the agent. */
async function handleChatInput(input: string, state: ChatState, global: GlobalOptions): Promise<void> {
  if (input.startsWith('!')) return userShell(input.slice(1).trim(), state, global)
  if (input.startsWith('>')) return userSmalltalk(input.slice(1).trim(), state, global)
  if (await handleChatSlash(input, global, state)) return
  await runChatTurn(input, state, global)
}

async function runChatTurn(prompt: string, state: ChatState, global: GlobalOptions): Promise<void> {
  const controller = new AbortController()
  state.turn = controller
  const started = Date.now()
  state.renderer.toolCalls = 0
  process.stdout.write('\n')
  try {
    const result = await state.loop.runTurn(prompt, {
      cwd: global.cwd,
      recorder: state.recorder,
      resumeMessages: trimChatHistory(state.history),
      signal: controller.signal,
      onEvent: state.renderer.handle,
      prompt: state.rl ? async question => {
        state.asking = true
        try {
          return await state.rl!.question(question, { signal: controller.signal })
        } finally {
          state.asking = false
        }
      } : undefined,
    })
    state.renderer.stop()
    state.history = trimChatHistory(result.messages)
    process.stdout.write(`${style.bold('●')} ${renderMarkdown(result.answer)}\n`)
    process.stdout.write(style.dim(`  ${formatDuration(Date.now() - started)} · ${state.renderer.toolCalls} tool call${state.renderer.toolCalls === 1 ? '' : 's'}\n\n`))
  } catch (error) {
    state.renderer.stop()
    if (controller.signal.aborted || error instanceof AgentInterrupted) {
      process.stdout.write(`  ${style.gray('⎿')}  ${style.yellow('Interrupted.')} ${style.dim('What should the agent do instead?')}\n\n`)
    } else {
      process.stdout.write(`\n${style.red('error:')} ${(error as Error).message}\n`)
      process.stdout.write(style.dim('Run /status for setup checks, /model current for model config, or /help for chat commands.\n\n'))
    }
  } finally {
    state.turn = undefined
  }
}

/** `!cmd`: the user runs a shell command; output is shown live and added to the agent's context. */
async function userShell(command: string, state: ChatState, global: GlobalOptions): Promise<void> {
  if (!command) {
    process.stdout.write(style.dim('Usage: !<shell command>\n'))
    return
  }
  const controller = new AbortController()
  state.turn = controller
  let output = ''
  const code = await new Promise<number>(resolve => {
    const [bin, ...rest] = shellCommand(command)
    const child = spawn(bin!, rest, { cwd: global.cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal })
    const forward = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output += text
      process.stdout.write(text)
    }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', error => {
      if (!controller.signal.aborted) process.stdout.write(`${style.red(error.message)}\n`)
      resolve(127)
    })
    child.on('close', exitCode => resolve(exitCode ?? 130))
  })
  state.turn = undefined
  if (output && !output.endsWith('\n')) process.stdout.write('\n')
  if (code !== 0) process.stdout.write(style.dim(`exit ${code}\n`))
  addUserContext(state, `[I ran a shell command myself]\n$ ${command}\n${truncate(output, 6_000)}${code !== 0 ? `\n(exit ${code})` : ''}`)
}

/** `>code`: the user evaluates Smalltalk in the image directly, like a Playground print-it. */
async function userSmalltalk(code: string, state: ChatState, global: GlobalOptions): Promise<void> {
  if (!code) {
    process.stdout.write(style.dim('Usage: > <Smalltalk code>   e.g.  > 3 factorial\n'))
    return
  }
  const controller = new AbortController()
  state.turn = controller
  try {
    const result = await evaluateSmalltalk(state.config, code, { cwd: global.cwd, signal: controller.signal })
    const text = result.ok ? (result.result ?? '') : `${result.error ?? 'failed'}${result.stack?.length ? `\n  ${result.stack.slice(0, 4).join('\n  ')}` : ''}`
    const backend = result.backend === 'live' ? style.green('live') : style.yellow('headless')
    process.stdout.write(`${style.gray('⎿')}  ${result.ok ? text : style.red(text)}  ${style.dim(`${backend} · ${formatDuration(result.durationMs)}`)}\n`)
    addUserContext(state, `[I evaluated Smalltalk in the ${result.backend} image myself]\n${code}\n=> ${truncate(text, 4_000)}`)
  } catch (error) {
    process.stdout.write(`${style.red('error:')} ${(error as Error).message}\n`)
  } finally {
    state.turn = undefined
  }
}

function addUserContext(state: ChatState, content: string): void {
  state.history = trimChatHistory([...state.history, { role: 'user', content }])
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters)` : text
}

async function handleChatSlash(prompt: string, global: GlobalOptions, state: ChatState): Promise<boolean> {
  if (!prompt.startsWith('/')) return false
  const [command, ...rest] = splitArgs(prompt.slice(1))
  if (command === 'exit' || command === 'quit') throw new ChatExit()
  if (command === 'help' || command === '?') {
    printChatHelp()
    return true
  }
  if (command === 'clear') {
    state.history = []
    process.stdout.write('Conversation context cleared. Session transcript continues.\n')
    return true
  }
  if (command === 'context') {
    process.stdout.write(`${state.history.filter(message => message.role !== 'system').length} messages in active context.\n`)
    return true
  }
  if (command === 'new') {
    state.history = []
    state.recorder = await createOptionalRecorder('chat')
    process.stdout.write(`Started new session ${state.recorder?.id ?? '(not recorded)'}\n`)
    return true
  }
  if (command === 'resume') {
    const id = rest[0]
    if (!id) {
      process.stdout.write('Usage: /resume <session-id>\n')
      return true
    }
    state.history = trimChatHistory(await loadSessionMessages(id))
    process.stdout.write(`Resumed ${id}; ${state.history.length} messages loaded into context.\n`)
    return true
  }
  if (command === 'verbose') {
    state.verbose = rest[0] ? boolFlag(rest[0]) : !state.verbose
    state.renderer.setVerbose(state.verbose)
    process.stdout.write(`Full tool output ${state.verbose ? 'on' : 'off'}.\n`)
    return true
  }
  if (command === 'eval') {
    await userSmalltalk(rest.join(' '), state, global)
    return true
  }
  if (command === 'mode') {
    if (!rest[0]) {
      process.stdout.write(`Pharo mode: ${state.config.pharoMode} (auto | live | headless)\n`)
      return true
    }
    state.config.pharoMode = pharoModeValue(rest[0])
    process.stdout.write(`Pharo mode set to ${state.config.pharoMode} for this session.\n`)
    return true
  }
  if (command === 'permissions') {
    if (!rest[0]) {
      const allowed = [...state.loop.sessionAllowed]
      process.stdout.write(`Permission mode: ${state.config.permissionMode}${allowed.length ? `; always allowed this session: ${allowed.join(', ')}` : ''}\n`)
      return true
    }
    state.config.permissionMode = permissionModeValue(rest[0], state.config.permissionMode)
    process.stdout.write(`Permission mode set to ${state.config.permissionMode} for this session.\n`)
    return true
  }
  if (command === 'images' || command === 'image' || command === 'templates' || command === 'vms') {
    const session: ImageSession = {
      config: state.config,
      ask: state.rl ? async question => {
        state.asking = true
        try {
          return await state.rl!.question(question)
        } finally {
          state.asking = false
        }
      } : undefined,
      listing: state.imageListing,
      note: text => addUserContext(state, text),
    }
    const args = command === 'templates' ? ['templates', ...rest]
      : command === 'vms' ? ['vms']
      : command === 'images' ? (rest.length ? rest : ['list'])
      : (rest.length ? rest : ['use'])
    try {
      await imagesCommand(args, global, session)
    } catch (error) {
      process.stdout.write(`${style.red('error:')} ${(error as Error).message}\n`)
    }
    state.imageListing = session.listing
    return true
  }
  if (command === 'live') return await liveCommand(rest.length ? rest : ['status'], global, state.config).then(() => true)
  if (command === 'save') return await liveCommand(['save'], global, state.config).then(() => true)
  if (command === 'sessions') return await sessionsCommand(rest.length ? rest : ['list']).then(() => true)
  if (command === 'setup') return await setupCommand(rest, global).then(() => true)
  if (command === 'status') return await statusCommand(rest, global).then(() => true)
  if (command === 'doctor') return await doctorCommand(rest, global).then(() => true)
  if (command === 'tools') return await toolsCommand(rest, global).then(() => true)
  if (command === 'tasks') return await tasksCommand(rest.length ? rest : ['list'], global).then(() => true)
  if (command === 'memory') return await memoryCommand(rest.length ? rest : ['read'], global).then(() => true)
  if (command === 'model') return await modelCommand(rest, global).then(() => true)
  process.stdout.write(`Unknown chat command: /${command}. Type /help.\n`)
  return true
}

class ChatExit extends Error {}

async function readMultilinePrompt(rl: { question(prompt: string): Promise<string> }): Promise<string> {
  process.stdout.write('Paste your prompt. End with a line containing only /end.\n')
  const lines: string[] = []
  while (true) {
    const line = await rl.question('... ')
    if (line.trim() === '/end') return lines.join('\n').trim()
    lines.push(line)
  }
}

async function createOptionalRecorder(title: string): Promise<SessionRecorder | undefined> {
  try {
    return await SessionRecorder.create(title)
  } catch (error) {
    process.stderr.write(`warning: session recording disabled: ${(error as Error).message}\n`)
    return undefined
  }
}

async function printChatWelcome(config: AgentConfig, cwd: string): Promise<void> {
  const [modelReady, health, locations] = await Promise.all([
    fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1_500) }).then(response => response.ok).catch(() => false),
    config.pharoMode === 'headless' ? Promise.resolve(undefined) : liveHealth(config),
    launcherLocations(),
  ])
  let pharo: BannerInfo['pharo']
  if (config.image) {
    const image = await findImage(locations, resolvePath(config.image, cwd), cwd).catch(() => undefined)
    pharo = {
      kind: health?.ok ? 'live' : 'stopped',
      name: image?.name ?? shortImageName(config.image),
      version: image ? describeVersion(image) : undefined,
      detail: health?.ok ? health.url.replace('http://', '') : image ? '/image start to open it' : 'image file missing · /image',
    }
  } else if (health?.ok) {
    pharo = { kind: 'live', name: shortImageName(health.image ?? 'image'), version: health.pharo, detail: health.url.replace('http://', '') }
  } else {
    const count = (await listLauncherImages(locations)).length
    pharo = { kind: 'none', detail: count ? `/image to pick one of your ${count} images` : '/image create to make one' }
  }
  const lines = bannerLines({
    version: VERSION,
    model: config.model ?? config.modelFile ?? (config.modelPath ? path.basename(config.modelPath) : 'default model'),
    modelStatus: modelReady ? 'ready' : 'offline',
    modelUrl: config.baseUrl,
    pharo,
    cwd,
    permissionMode: config.permissionMode,
  })
  process.stdout.write(`\n${lines.join('\n')}\n\n`)
}

function printChatHelp(): void {
  const row = (left: string, right: string) => `  ${style.cyan(left.padEnd(22))} ${right}`
  process.stdout.write(`${style.bold('Chat commands:')}
${row('<question>', 'Ask the agent; every tool call and result is shown as it runs')}
${row('! <command>', 'Run a shell command yourself (the agent sees the output)')}
${row('> <smalltalk>', 'Evaluate Smalltalk in the image yourself (also /eval)')}
${row('esc / Ctrl+C', 'Interrupt the agent mid-turn')}
${style.bold('Images')} ${style.dim('(shared with Pharo Launcher)')}
${row('/images [--all]', 'List images: version, running, live (--all: whole machine)')}
${row('/image', 'Pick the image to work in (then start it)')}
${row('/image <#|name>', 'Work in that image')}
${row('/image create [name]', 'New image from a template (Pharo, Moose, …)')}
${row('/image start|stop [#]', 'Open (window or --headless) / quit (--save)')}
${row('/image copy|delete <#>', 'Duplicate / remove an image')}
${row('/image info [#]', 'Path, version, VM, state')}
${row('/templates [filter]', 'Available templates')}
${row('/vms', 'Installed VMs')}
${style.bold('Live connection')}
${row('/live [status|snippet|stop]', 'Connect an image you opened yourself')}
${row('/save', 'Save the live image')}
${row('/mode [auto|live|headless]', 'Where Pharo code runs')}
${row('/permissions [mode]', 'ask | auto | read-only | dangerous')}
${row('/verbose [on|off]', 'Show complete tool output')}
${row('/status [--online]', 'Show setup and model status')}
${row('/setup [--local]', 'Run first-time setup')}
${row('/doctor [--online]', 'Run diagnostics')}
${row('/tools', 'List model tools')}
${row('/model [subcommand]', 'Manage GGUF models')}
${row('/tasks [subcommand]', 'Manage workspace tasks')}
${row('/memory [subcommand]', 'Read/write project memory')}
${row('/sessions', 'List saved sessions')}
${row('/resume <id>', 'Load a previous session into context')}
${row('/context', 'Show active context size')}
${row('/clear', 'Clear active context')}
${row('/new', 'Start a fresh transcript')}
${row('/paste', 'Enter a multi-line prompt ending with /end')}
${row('/exit', 'Quit')}
`)
}

/** `Pharo 14 dev ● ❯`: the image questions go to, green when live. */
async function chatPrompt(config: AgentConfig): Promise<string> {
  if (!config.image) return `${style.blue('❯')} `
  const health = config.pharoMode === 'headless' ? undefined : await liveHealth(config, 500)
  const dot = health?.ok ? style.green('●') : style.dim('○')
  return `${style.dim(shortImageName(config.image, 24))} ${dot} ${style.blue('❯')} `
}

function trimChatHistory(messages: ChatMessage[], maxMessages = 40): ChatMessage[] {
  const system = messages.find(message => message.role === 'system')
  const rest = messages.filter(message => message.role !== 'system')
  const trimmed = rest.slice(Math.max(0, rest.length - maxMessages))
  return system ? [system, ...trimmed] : trimmed
}

async function printStatus(config: AgentConfig, cwd: string, options: { online?: boolean } = {}): Promise<void> {
  const checks = await collectDiagnostics(config, cwd, options)
  const ok = diagnosticsOk(checks)
  process.stdout.write(`\n${bold('Pharo Agent Status')} ${ok ? color('[ready]', '32') : color('[needs setup]', '33')}\n`)
  process.stdout.write(`Version: ${VERSION}\n`)
  process.stdout.write(`Workspace: ${cwd}\n`)
  process.stdout.write(`Model repo: ${config.modelRepo}\n`)
  process.stdout.write(`Publish repo: ${config.publishRepo}\n`)
  process.stdout.write(`Base URL: ${config.baseUrl}\n`)
  process.stdout.write(`Permissions: ${config.permissionMode}; outside workspace: ${yesNo(config.allowOutsideWorkspace)}; private web fetch: ${yesNo(config.allowPrivateNetwork)}\n\n`)
  for (const check of checks) {
    const marker = check.ok ? color('[ok]', '32') : check.required ? color('[missing]', '31') : color('[optional]', '33')
    process.stdout.write(`${marker} ${check.name.padEnd(18)} ${check.detail}\n`)
  }
  const next = nextSteps(checks)
  if (next.length) {
    process.stdout.write('\nNext steps:\n')
    for (const step of next) process.stdout.write(`- ${step}\n`)
  }
  process.stdout.write('\n')
}

function nextSteps(checks: { name: string; ok: boolean }[]): string[] {
  const missing = new Set(checks.filter(check => !check.ok).map(check => check.name))
  const steps: string[] = []
  if (missing.has('pharo.live')) steps.push('Connect your open image: pharo-agent live snippet (paste it in a Playground), or pharo-agent live start')
  if (missing.has('pharo.image')) steps.push('Pick an image: pharo-agent images, then pharo-agent images use <#> (or /image in the chat)')
  else if (missing.has('pharo.vm')) steps.push('Download the VM for your image: pharo-agent images vm download <version>')
  if (missing.has('model.path') && missing.has('llm.api')) steps.push('Upload/download a GGUF, then run pharo-agent model download --use or pharo-agent model serve --hf <repo:file>')
  else if (missing.has('llm.api')) steps.push('Start llama.cpp with pharo-agent model serve, or set PHARO_AGENT_BASE_URL')
  return steps
}

function setupHeader(discovery: Awaited<ReturnType<typeof discoverSetup>>): string {
  return `${bold('Pharo Agent Setup')}

Detected:
- Pharo VMs: ${discovery.pharoVms.slice(0, 3).join(', ') || 'none'}
- Pharo images: ${discovery.images.slice(0, 3).join(', ') || 'none'}
- llama.cpp: ${discovery.llamaServers.slice(0, 3).join(', ') || 'none'}

Press enter to accept a default, or paste a path/value.
`
}

async function askValue(rl: { question(prompt: string): Promise<string> }, label: string, fallback?: string): Promise<string | undefined> {
  const answer = (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim()
  return answer || fallback
}

async function askYesNo(rl: { question(prompt: string): Promise<string> }, label: string, fallback: boolean): Promise<boolean> {
  const answer = (await rl.question(`${label} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase()
  if (!answer) return fallback
  return answer === 'y' || answer === 'yes' || answer === 'true' || answer === '1'
}

function permissionModeValue(value: string | undefined, fallback: PermissionMode): PermissionMode {
  if (!value) return fallback
  if (['ask', 'auto', 'read-only', 'dangerous'].includes(value)) return value as PermissionMode
  throw new Error(`Invalid permission mode: ${value}`)
}

function color(value: string, code: string): string {
  return process.stdout.isTTY ? `\x1b[${code}m${value}\x1b[0m` : value
}

function bold(value: string): string {
  return color(value, '1')
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}

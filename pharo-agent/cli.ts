#!/usr/bin/env node
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AgentConfig, ChatMessage, PermissionMode } from './types.ts'
import { effectivePharoVm, globalConfigPath, loadConfig, mergeConfig, modelCacheDir, pharoModeValue, updateConfigFile } from './config.ts'
import { AgentInterrupted, PharoAgentLoop } from './agent.ts'
import { evaluateSmalltalk, inspectImage, runSmalltalkFile, runSUnit } from './pharo.ts'
import type { PharoEvalResult, PharoRunResult } from './pharo.ts'
import { liveEndpoint, liveEval, liveHealth, liveInfoFile, liveLoadSnippet, liveSave, liveServerScriptPath, startLiveImage } from './live.ts'
import { ActivityRenderer, bannerLines, formatDuration, renderMarkdown, style, tildify } from './ui.ts'
import type { BannerInfo } from './ui.ts'
import { buildLlamaCommand, startLlamaServer } from './llama.ts'
import { downloadGguf, downloadGgufSet, formatBytes, HuggingFaceError, listGgufFiles, listOrgModels, resolveGgufShardSet, resolveModelRef, selectGguf } from './hf.ts'
import { builtInTools } from './tools.ts'
import { appendMemory, clearMemory, readMemory } from './memory.ts'
import { listSessions, loadSessionMessages, SessionRecorder } from './sessions.ts'
import { pathExists, shellCommand, which } from './platform.ts'
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
      process.stdout.write(`\n${style.dim('(press Ctrl+C again to exit, or type /exit)')}\n${chatPrompt()}`)
    })
    process.stdin.on('keypress', (_text, key: { name?: string } | undefined) => {
      if (key?.name === 'escape' && state.turn) state.turn.abort()
    })
    let closed = false
    rl.once('close', () => {
      closed = true
    })
    if (positional.length) await handleChatInput(positional.join(' '), state, global)
    while (!closed) {
      let prompt: string
      try {
        prompt = (await rl.question(chatPrompt())).trim()
      } catch {
        break
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
    process.stdout.write(`Connect your open image: paste this into a Playground and Do it (Cmd+D):\n\n  ${style.cyan(liveLoadSnippet())}\n\n`)
    process.stdout.write(`Or launch the configured image with the server: ${style.cyan('pharo-agent live start')}\n`)
    return 1
  }
  if (sub === 'snippet') {
    process.stdout.write(`${liveLoadSnippet()}\n`)
    if (!flags.quiet) process.stderr.write(style.dim(`\nPaste it into a Playground of your open image and Do it (Cmd+D).\nThe server listens on 127.0.0.1:${config.livePort} and writes its token to ${tildify(liveInfoFile(config))}.\nServer source: ${liveServerScriptPath()}\n`))
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
      prompt: state.rl ? question => state.rl!.question(question, { signal: controller.signal }) : undefined,
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
  const [command, ...rest] = prompt.slice(1).split(/\s+/)
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
  const [modelReady, health] = await Promise.all([
    fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1_500) }).then(response => response.ok).catch(() => false),
    config.pharoMode === 'headless' ? Promise.resolve(undefined) : liveHealth(config),
  ])
  const vm = await effectivePharoVm(config)
  const pharo: BannerInfo['pharo'] = health?.ok
    ? { kind: 'live', version: health.pharo, image: health.image, url: health.url }
    : vm && config.image
      ? { kind: 'headless', image: config.image }
      : { kind: 'none' }
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
${row('/live [status|start|snippet|stop]', '')}
${row('', 'Connect to a running Pharo image')}
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

function chatPrompt(): string {
  return `${style.blue('❯')} `
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
  if (missing.has('pharo.vm')) steps.push('Run pharo-agent setup or pharo-agent configure --pharo-vm /path/to/pharo')
  if (missing.has('pharo.image')) steps.push('Run pharo-agent setup or pharo-agent configure --image /path/to/Pharo.image')
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

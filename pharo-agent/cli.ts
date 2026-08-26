#!/usr/bin/env node
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AgentConfig, ChatMessage, PermissionMode } from './types.ts'
import { globalConfigPath, loadConfig, mergeConfig, modelCacheDir, updateConfigFile } from './config.ts'
import { PharoAgentLoop } from './agent.ts'
import { evaluateSmalltalk, inspectImage, runPharoScriptFile, runSUnit } from './pharo.ts'
import { buildLlamaCommand, startLlamaServer } from './llama.ts'
import { downloadGguf, downloadGgufSet, formatBytes, HuggingFaceError, listGgufFiles, listOrgModels, resolveGgufShardSet, resolveModelRef, selectGguf } from './hf.ts'
import { builtInTools } from './tools.ts'
import { appendMemory, clearMemory, readMemory } from './memory.ts'
import { listSessions, loadSessionMessages, SessionRecorder } from './sessions.ts'
import { pathExists, which } from './platform.ts'
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
    const answer = await new PharoAgentLoop(config).run(prompt, {
      cwd: global.cwd,
      verbose: Boolean(flags.verbose),
      recorder,
      resumeMessages,
    })
    process.stdout.write(`${answer}\n`)
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
  let history: ChatMessage[] = typeof flags.resume === 'string' ? await loadSessionMessages(flags.resume) : []
  try {
    printChatWelcome(config, global.cwd, recorder?.id)
    const loop = new PharoAgentLoop(config)
    const state: ChatState = { history, config, recorder }
    const firstPrompt = positional.join(' ')
    if (firstPrompt) {
      await runChatTurn(loop, firstPrompt, state, global, Boolean(flags.verbose))
      history = state.history
    }
    if (!process.stdin.isTTY) {
      const piped = await readStdin()
      for (const raw of piped.split(/\r?\n/)) {
        const prompt = raw.trim()
        if (!prompt || prompt === '/paste') continue
        if (await handleChatSlash(prompt, global, state)) {
          history = state.history
          continue
        }
        await runChatTurn(loop, prompt, state, global, Boolean(flags.verbose))
        history = state.history
      }
      return 0
    }
    const readline = await import('node:readline/promises')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      while (true) {
        let prompt: string
        try {
          prompt = (await rl.question(chatPrompt(history))).trim()
        } catch {
          return 0
        }
        if (!prompt) continue
        if (prompt === '/paste') prompt = await readMultilinePrompt(rl)
        if (!prompt) continue
        if (await handleChatSlash(prompt, global, state)) {
          history = state.history
          continue
        }
        await runChatTurn(loop, prompt, state, global, Boolean(flags.verbose))
        history = state.history
      }
    } finally {
      rl.close()
    }
  } finally {
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
  const result = await evaluateSmalltalk(await runtimeConfig(global, flags), positional.join(' '), { cwd: global.cwd })
  printRunResult(result, Boolean(flags.json))
  return result.exitCode
}

async function inspectCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags, positional } = parseFlags(args)
  const result = await inspectImage(await runtimeConfig(global, flags), positional[0], { cwd: global.cwd })
  printRunResult(result, Boolean(flags.json))
  return result.exitCode
}

async function stCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags, positional } = parseFlags(args)
  const script = positional[0]
  if (!script) throw new Error('Usage: pharo-agent st <script.st>')
  const result = await runPharoScriptFile(await runtimeConfig(global, flags), script, { cwd: global.cwd })
  printRunResult(result, Boolean(flags.json))
  return result.exitCode
}

async function testCommand(args: string[], global: GlobalOptions): Promise<number> {
  const { flags } = parseFlags(args)
  const result = await runSUnit(await runtimeConfig(global, flags), {
    package: stringFlag(flags.package),
    className: stringFlag(flags.class ?? flags.className),
    selector: stringFlag(flags.selector),
  }, { cwd: global.cwd })
  printRunResult(result, Boolean(flags.json))
  return result.exitCode
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
    const command = await buildLlamaCommand(config, { modelPath, hfRef })
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
  pharo-agent eval "Smalltalk code"
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

function printRunResult(result: { stdout: string; stderr: string; exitCode: number; command: string[] }, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
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

async function runChatTurn(loop: PharoAgentLoop, prompt: string, state: ChatState, global: GlobalOptions, verbose: boolean): Promise<void> {
  process.stdout.write(color('thinking...\n', '2'))
  try {
    const result = await loop.runTurn(prompt, {
      cwd: global.cwd,
      recorder: state.recorder,
      resumeMessages: trimChatHistory(state.history),
      verbose,
    })
    state.history = trimChatHistory(result.messages)
    process.stdout.write(`\n${result.answer}\n\n`)
  } catch (error) {
    process.stdout.write(`\n${color('error:', '31')} ${(error as Error).message}\n`)
    process.stdout.write('Run /status for setup checks, /model current for model config, or /help for chat commands.\n\n')
  }
}

async function handleChatSlash(prompt: string, global: GlobalOptions, state: ChatState): Promise<boolean> {
  if (!prompt.startsWith('/')) return false
  const [command, ...rest] = prompt.slice(1).split(/\s+/)
  if (command === 'exit' || command === 'quit') throw new ChatExit()
  if (command === 'help') {
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

function printChatWelcome(config: AgentConfig, cwd: string, sessionId?: string): void {
  process.stdout.write(`${bold('Pharo Agent')} ${color(`v${VERSION}`, '2')}\n`)
  process.stdout.write(`Workspace: ${cwd}\n`)
  process.stdout.write(`Model: ${config.model ?? config.modelFile ?? config.modelPath ?? config.baseUrl}\n`)
  process.stdout.write(`Session: ${sessionId ?? '(not recorded)'}\n`)
  process.stdout.write('Ask a question, or type /help for commands. Type /exit to quit.\n\n')
}

function printChatHelp(): void {
  process.stdout.write(`Chat commands:
/help                 Show this help
/status [--online]    Show setup and model status
/setup [--local]      Run first-time setup
/doctor [--online]    Run diagnostics
/tools                List model tools
/model [subcommand]   Manage GGUF models
/tasks [subcommand]   Manage workspace tasks
/memory [subcommand]  Read/write project memory
/sessions             List saved sessions
/resume <id>          Load a previous session into context
/context              Show active context size
/clear                Clear active context
/new                  Start a fresh transcript
/paste                Enter a multi-line prompt ending with /end
/exit                 Quit
`)
}

function chatPrompt(history: ChatMessage[]): string {
  const turns = history.filter(message => message.role === 'user').length
  return color(`pharo-agent:${turns + 1}> `, '36')
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

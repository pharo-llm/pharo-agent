import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { AgentConfig } from './types.ts'
import { effectiveLlamaServer } from './config.ts'
import { ensureDir, xdgCacheDir } from './platform.ts'
import { OpenAICompatibleClient } from './llm.ts'

export type RunningServer = {
  command: string[]
  process: ChildProcess
  logPath: string
  stop(): Promise<void>
}

export class LlamaError extends Error {}

export async function buildLlamaCommand(config: AgentConfig, options: { modelPath?: string; hfRef?: string } = {}): Promise<string[]> {
  const server = await effectiveLlamaServer(config)
  if (!server) throw new LlamaError('llama-server was not found. Install llama.cpp or set PHARO_AGENT_LLAMA_SERVER.')
  const command = path.basename(server) === 'llama' ? [server, 'serve'] : [server]
  if (options.hfRef) command.push('-hf', options.hfRef)
  else if (options.modelPath) command.push('-m', options.modelPath)
  else throw new LlamaError('No GGUF model path or Hugging Face ref was provided.')
  command.push('--port', String(config.llamaPort))
  return command
}

export async function startLlamaServer(config: AgentConfig, options: { modelPath?: string; hfRef?: string; waitSeconds?: number } = {}): Promise<RunningServer> {
  const command = await buildLlamaCommand(config, options)
  const logPath = path.join(xdgCacheDir(), 'llama-server.log')
  await ensureDir(path.dirname(logPath))
  const fs = await import('node:fs')
  const log = fs.createWriteStream(logPath, { flags: 'a' })
  const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', log, log] })
  const running: RunningServer = {
    command,
    process: child,
    logPath,
    async stop() {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
          resolve()
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    },
  }
  const client = new OpenAICompatibleClient(config.baseUrl, config.apiKey, 5_000)
  const deadline = Date.now() + (options.waitSeconds ?? 60) * 1_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new LlamaError(`llama.cpp exited early with code ${child.exitCode}. See ${logPath}`)
    if (await client.available()) return running
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  await running.stop()
  throw new LlamaError(`Timed out waiting for llama.cpp at ${config.baseUrl}. See ${logPath}`)
}

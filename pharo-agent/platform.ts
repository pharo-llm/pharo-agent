import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

export function resolvePath(value: string, cwd = process.cwd()): string {
  return path.resolve(cwd, expandHome(value))
}

export async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(value: string): Promise<void> {
  await mkdir(value, { recursive: true })
}

export function xdgConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'pharo-agent')
}

export function xdgCacheDir(): string {
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'pharo-agent')
}

export function xdgStateDir(): string {
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'pharo-agent')
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

export async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isDirectory()
  } catch {
    return false
  }
}

export async function which(binary: string): Promise<string | undefined> {
  if (binary.includes('/') || binary.includes('\\')) {
    const full = resolvePath(binary)
    return (await pathExists(full)) ? full : undefined
  }
  const pathValue = process.env.PATH ?? ''
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of pathValue.split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, binary + ext)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // keep scanning
      }
    }
  }
  return undefined
}

export type ExecResult = {
  command: string[]
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export function execFileCapture(command: string[], options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  const cwd = options.cwd ?? process.cwd()
  const start = Date.now()
  return new Promise(resolve => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
          }, 2_000).unref()
        }, options.timeoutMs)
      : undefined
    timer?.unref()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({
        command,
        cwd,
        exitCode: 127,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`,
        durationMs: Date.now() - start,
        timedOut,
      })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({
        command,
        cwd,
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      })
    })
  })
}

export function shellCommand(command: string): string[] {
  if (process.platform === 'win32') return ['cmd.exe', '/d', '/s', '/c', command]
  return [process.env.SHELL || '/bin/sh', '-lc', command]
}

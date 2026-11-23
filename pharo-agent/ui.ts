import os from 'node:os'
import type { AgentEvent } from './agent.ts'
import type { JsonObject, ToolCall, ToolResult } from './types.ts'

// ---------------------------------------------------------------------------
// Colors

export const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

function sgr(code: string, value: string): string {
  return colorEnabled ? `\x1b[${code}m${value}\x1b[0m` : value
}

export const style = {
  bold: (value: string) => sgr('1', value),
  dim: (value: string) => sgr('2', value),
  italic: (value: string) => sgr('3', value),
  red: (value: string) => sgr('31', value),
  green: (value: string) => sgr('32', value),
  yellow: (value: string) => sgr('33', value),
  cyan: (value: string) => sgr('36', value),
  gray: (value: string) => sgr('90', value),
  /** Pharo blue. */
  blue: (value: string) => sgr('38;5;74', value),
  orange: (value: string) => sgr('38;5;214', value),
  added: (value: string) => sgr('38;5;114', value),
  removed: (value: string) => sgr('38;5;174', value),
}

// ---------------------------------------------------------------------------
// Logo: the Pharo lighthouse, drawn with half blocks (two pixels per cell).

const logoPixels = [
  '......Y......',
  '..v..oYo..v..',
  '...v.OYO.v...',
  '....rRRRr....',
  '.....pdd.....',
  '.....bbd.....',
  '....dbbdd....',
  '....bddbb....',
  '...bbbddbb...',
  '..bbbbbbbbb..',
]

/** xterm-256 colors, safe in Terminal.app as well as truecolor terminals. */
const logoPalette: Record<string, number> = {
  Y: 227, // lamp core
  o: 214, // lamp
  O: 208, // lamp, lower
  v: 187, // light rays
  r: 131, // gallery edge
  R: 167, // gallery
  p: 96, // tower top, purple
  d: 60, // stripe
  b: 74, // Pharo blue
}

export function logoLines(): string[] {
  if (!colorEnabled) return ['   _/\\_   ', '   |##|   ', '  /####\\  ', ' /######\\ ', '/########\\']
  const lines: string[] = []
  for (let y = 0; y < logoPixels.length; y += 2) {
    const top = logoPixels[y]!
    const bottom = logoPixels[y + 1] ?? ''
    let line = ''
    for (let x = 0; x < top.length; x += 1) {
      const upper = logoPalette[top[x]!]
      const lower = logoPalette[bottom[x] ?? '.']
      if (upper === undefined && lower === undefined) line += ' '
      else if (lower === undefined) line += `\x1b[38;5;${upper}m▀\x1b[0m`
      else if (upper === undefined) line += `\x1b[38;5;${lower}m▄\x1b[0m`
      else line += `\x1b[38;5;${upper};48;5;${lower}m▀\x1b[0m`
    }
    lines.push(line)
  }
  return lines
}

export type BannerInfo = {
  version: string
  model: string
  modelStatus: 'ready' | 'offline' | 'unknown'
  modelUrl: string
  pharo: { kind: 'live'; version?: string; image?: string; url: string } | { kind: 'headless'; image?: string } | { kind: 'none' }
  cwd: string
  permissionMode: string
}

export function bannerLines(info: BannerInfo): string[] {
  const dot = (ok: boolean) => (ok ? style.green('●') : style.red('○'))
  const modelLine = `${info.model} ${style.dim('·')} ${dot(info.modelStatus === 'ready')} ${style.dim(info.modelStatus === 'ready' ? shortUrl(info.modelUrl) : `no model server at ${shortUrl(info.modelUrl)}`)}`
  let pharoLine: string
  if (info.pharo.kind === 'live') {
    pharoLine = `${info.pharo.version ?? 'Pharo'} ${style.dim('·')} ${style.green('● live')} ${style.dim(tildify(info.pharo.image ?? info.pharo.url))}`
  } else if (info.pharo.kind === 'headless') {
    pharoLine = `Pharo ${style.dim('·')} ${style.yellow('○ headless')} ${style.dim(`${tildify(info.pharo.image ?? '')} · /live start to connect`)}`
  } else {
    pharoLine = `Pharo ${style.dim('·')} ${style.red('○ not configured')} ${style.dim('· /live start or /setup')}`
  }
  const text = [
    `${style.bold('Pharo Agent')} ${style.dim(`v${info.version}`)}`,
    modelLine,
    pharoLine,
    style.dim(`${tildify(info.cwd)} · permissions: ${info.permissionMode}`),
    style.dim('/help · ! shell · > Smalltalk · esc interrupts'),
  ]
  const logo = logoLines()
  const rows = Math.max(logo.length, text.length)
  const out: string[] = []
  for (let i = 0; i < rows; i += 1) out.push(` ${logo[i] ?? ' '.repeat(13)}   ${text[i] ?? ''}`)
  return out
}

export function tildify(value: string): string {
  const home = os.homedir()
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '')
}

// ---------------------------------------------------------------------------
// Spinner

const frames = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

export class Spinner {
  private timer?: NodeJS.Timeout
  private started = 0
  private frame = 0
  private label = ''
  // stderr keeps the spinner out of piped stdout (pharo-agent ask ... > answer.txt).
  private readonly stream = process.stderr

  start(label: string): void {
    if (!this.stream.isTTY) return
    this.stop()
    this.label = label
    this.started = Date.now()
    this.render()
    this.timer = setInterval(() => this.render(), 120)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
    this.stream.write('\r\x1b[2K')
  }

  get running(): boolean {
    return this.timer !== undefined
  }

  private render(): void {
    const seconds = Math.floor((Date.now() - this.started) / 1000)
    this.frame = (this.frame + 1) % frames.length
    this.stream.write(`\r\x1b[2K${style.orange(frames[this.frame]!)} ${style.orange(this.label)} ${style.dim(`(${seconds}s · esc to interrupt)`)}`)
  }
}

// ---------------------------------------------------------------------------
// Rendering agent activity

export type RenderOptions = {
  /** Show complete tool results instead of a preview. */
  verbose: boolean
  write: (text: string) => void
}

const previewLines = 8
const pharoNames: Record<string, string> = {
  pharo_eval: 'Pharo eval',
  pharo_inspect: 'Pharo inspect',
  pharo_source: 'Pharo source',
  pharo_find: 'Pharo find',
  pharo_compile: 'Pharo compile',
  pharo_define_class: 'Pharo define class',
  pharo_test: 'Pharo test',
  pharo_script: 'Pharo file-in',
  pharo_save: 'Pharo save image',
}

/** Header line(s) for a tool call: what is about to run, with its key input. */
export function formatToolStart(call: ToolCall, depth = 0): string {
  const pad = '  '.repeat(depth)
  const args = call.arguments
  const name = pharoNames[call.name] ?? call.name
  const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  let title: string
  let body: string[] = []
  switch (call.name) {
    case 'pharo_eval':
      title = name
      body = str('code').split(/\r?\n/)
      break
    case 'pharo_compile': {
      const selector = selectorFromSource(str('source'))
      title = `${name}(${str('className')}${args.classSide ? ' class' : ''}${selector ? `>>#${selector}` : ''}${str('protocol') ? ` · ${str('protocol')}` : ''})`
      body = str('source').split(/\r?\n/)
      break
    }
    case 'pharo_define_class':
      title = `${name}(${str('superclass') || 'Object'} << #${str('name')} · ${str('package')}${str('tag') ? `-${str('tag')}` : ''})`
      if (Array.isArray(args.slots) && args.slots.length) body = [`slots: ${(args.slots as string[]).join(' ')}`]
      break
    case 'pharo_source':
      title = `${name}(${str('className')}${args.classSide ? ' class' : ''}${str('selector') ? `>>#${str('selector')}` : ''})`
      break
    case 'pharo_find':
      title = `${name}(${str('kind')}: ${str('query')})`
      break
    case 'pharo_inspect':
      title = `${name}(${str('target') || (str('pattern') ? `packages ~ ${str('pattern')}` : 'image')})`
      break
    case 'pharo_test':
      title = `${name}(${[str('className') || str('package') || 'all tests', str('selector')].filter(Boolean).join('>>#')})`
      break
    case 'shell':
      title = `shell(${oneLine(str('command'), 100)})`
      break
    case 'file_edit':
      title = `file_edit(${str('path')})`
      body = [
        ...str('oldString').split(/\r?\n/).slice(0, 10).map(line => style.removed(`- ${line}`)),
        ...str('newString').split(/\r?\n/).slice(0, 10).map(line => style.added(`+ ${line}`)),
      ]
      break
    case 'file_write':
      title = `file_write(${str('path')} · ${str('content').split(/\r?\n/).length} lines)`
      break
    case 'agent':
      title = `agent(${oneLine(str('prompt'), 90)})`
      break
    default:
      title = `${call.name}(${oneLine(compactArgs(args), 100)})`
  }
  const lines = [`${pad}${style.blue('●')} ${style.bold(title)}`]
  const shown = body.slice(0, 14)
  for (const line of shown) lines.push(`${pad}  ${style.gray('│')} ${call.name === 'file_edit' ? line : style.cyan(line)}`)
  if (body.length > shown.length) lines.push(`${pad}  ${style.gray('│')} ${style.dim(`… ${body.length - shown.length} more lines`)}`)
  return `${lines.join('\n')}\n`
}

/** Result lines for a finished tool call. */
export function formatToolEnd(call: ToolCall, result: ToolResult, durationMs: number, options: { verbose: boolean; depth?: number }): string {
  const pad = '  '.repeat(options.depth ?? 0)
  const data = (result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {}) as JsonObject
  const backend = typeof data.backend === 'string' ? data.backend : undefined
  let text = resultText(call, result, data)
  if (!text.trim()) text = result.ok ? '(done)' : '(failed)'
  const allLines = text.replace(/\s+$/, '').split('\n')
  const limit = options.verbose ? 400 : previewLines
  const lines = allLines.slice(0, limit)
  const paint = result.ok ? (value: string) => value : style.red
  const out = lines.map((line, index) => `${pad}  ${index === 0 ? style.gray('⎿') : ' '}  ${paint(line)}`)
  if (allLines.length > lines.length) out.push(`${pad}     ${style.dim(`… +${allLines.length - lines.length} lines (/verbose to expand)`)}`)
  // Prefer the time Pharo itself reports: the wall clock includes waiting for approval.
  const elapsed = typeof data.durationMs === 'number' ? data.durationMs : durationMs
  const meta = [backend ? (backend === 'live' ? style.green('live') : style.yellow('headless')) : undefined, formatDuration(elapsed)].filter(Boolean).join(style.dim(' · '))
  out[out.length - 1] += `  ${style.dim(meta)}`
  if (typeof data.note === 'string') out.push(`${pad}     ${style.yellow(data.note)}`)
  return `${out.join('\n')}\n`
}

function resultText(call: ToolCall, result: ToolResult, data: JsonObject): string {
  if (call.name.startsWith('pharo_')) {
    const parts: string[] = []
    if (typeof data.result === 'string') parts.push(prettyJson(data.result))
    if (!result.ok && typeof data.error === 'string') {
      parts.push(String(data.errorClass && !data.error.startsWith(String(data.errorClass)) ? `${data.errorClass}: ${data.error}` : data.error))
      if (Array.isArray(data.stack)) parts.push(...(data.stack as string[]).slice(0, 4).map(line => `  ${line}`))
    }
    if (Array.isArray(data.warnings) && data.warnings.length) parts.push(...(data.warnings as string[]).map(line => `warning: ${line}`))
    if (typeof data.output === 'string' && !result.ok) parts.push(data.output)
    if (data.saved === true) parts.push(`saved ${data.image ?? ''}`)
    return parts.join('\n')
  }
  if (call.name === 'shell' || ('stdout' in data && 'exitCode' in data)) {
    const stdout = String(data.stdout ?? '').trimEnd()
    const stderr = String(data.stderr ?? '').trimEnd()
    const code = Number(data.exitCode ?? 0)
    return [stdout, stderr, code !== 0 ? `exit ${code}${data.timedOut ? ' (timed out)' : ''}` : ''].filter(Boolean).join('\n') || '(no output)'
  }
  if (!result.ok && typeof data.error === 'string') return data.error
  if (call.name === 'file_read' && typeof result.data === 'string') return `${result.data.split('\n').length} lines read`
  if (call.name === 'agent' && typeof data.answer === 'string') return data.answer
  if (typeof result.summary === 'string' && result.summary) return result.summary
  if (typeof result.data === 'string') return result.data
  return JSON.stringify(result.data, null, 2)
}

/** The selector a method source defines: unary, binary, or keyword (at:put:). */
export function selectorFromSource(source: string): string | undefined {
  const header = source.trimStart().split(/\r?\n/)[0] ?? ''
  const keywords = header.match(/[A-Za-z_][A-Za-z0-9_]*:/g)
  if (keywords && /^[A-Za-z_][A-Za-z0-9_]*:/.test(header)) return keywords.join('')
  const binary = header.match(/^([-+*/\\~<>=@%|&?,]+)/)
  if (binary) return binary[1]
  return header.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
}

function prettyJson(text: string): string {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function compactArgs(args: JsonObject): string {
  const entries = Object.entries(args)
  if (entries.length === 1 && typeof entries[0]![1] === 'string') return entries[0]![1] as string
  return entries.map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', ')
}

export function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Light markdown for answers: headings, bold, inline code, fenced code. */
export function renderMarkdown(text: string): string {
  let inFence = false
  return text.split('\n').map(line => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return style.gray(line)
    }
    if (inFence) return style.cyan(line)
    if (/^#{1,6}\s/.test(line)) return style.bold(line.replace(/^#{1,6}\s/, ''))
    return line
      .replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => style.bold(inner))
      .replace(/`([^`]+)`/g, (_, inner: string) => style.cyan(inner))
  }).join('\n')
}

/** Turns agent events into terminal output. */
export class ActivityRenderer {
  private readonly spinner = new Spinner()
  private readonly options: RenderOptions
  toolCalls = 0

  constructor(options: RenderOptions) {
    this.options = options
  }

  handle = (event: AgentEvent): void => {
    const depth = event.depth ?? 0
    switch (event.type) {
      case 'model_start':
        this.spinner.start(depth ? 'Subagent thinking…' : event.iteration === 1 ? 'Thinking…' : 'Working…')
        break
      case 'model_end':
        this.spinner.stop()
        break
      case 'assistant_text':
        this.spinner.stop()
        this.options.write(`${'  '.repeat(depth)}${style.bold('●')} ${renderMarkdown(event.text)}\n`)
        break
      case 'tool_start':
        this.spinner.stop()
        this.toolCalls += 1
        this.options.write(formatToolStart(event.call, depth))
        if (event.tool?.readOnly || event.call.name === 'agent') this.spinner.start(depth ? 'Subagent running…' : 'Running…')
        break
      case 'tool_end':
        this.spinner.stop()
        this.options.write(formatToolEnd(event.call, event.result, event.durationMs, { verbose: this.options.verbose, depth }))
        break
    }
  }

  stop(): void {
    this.spinner.stop()
  }

  setVerbose(verbose: boolean): void {
    this.options.verbose = verbose
  }
}

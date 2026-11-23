import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { AgentConfig, JsonObject, ToolDefinition } from './types.ts'

const readOnlyShellPrefixes = [
  'cat',
  'cd',
  'date',
  'du',
  'echo',
  'find',
  'git diff',
  'git log',
  'git show',
  'git status',
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'sed -n',
  'tail',
  'tree',
  'wc',
]

const destructiveShellPatterns = [
  /^rm\s/,
  /^rmdir\s/,
  /^mv\s/,
  /^cp\s/,
  /^chmod\s/,
  /^chown\s/,
  /^sudo\s/,
  /^dd\s/,
  /^mkfs\b/,
  /^git\s+(reset|clean|checkout|restore|switch|rebase|merge|cherry-pick)\b/,
  /^git\s+(commit|push|tag|branch\s+-D)\b/,
  /^npm\s+(install|update|audit\s+fix|publish)\b/,
  /^curl\b.*\|\s*(sh|bash)\b/,
  /^wget\b.*\|\s*(sh|bash)\b/,
]

export function isReadOnlyShellCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ')
  if (!normalized) return true
  if (/[;&|`$<>]/.test(normalized)) return false
  return readOnlyShellPrefixes.some(prefix => normalized === prefix || normalized.startsWith(`${prefix} `))
}

export function isDestructiveShellCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ')
  if (!normalized) return false
  return destructiveShellPatterns.some(pattern => pattern.test(normalized))
}

/** Asks the human a question and resolves with their raw answer. */
export type Prompter = (question: string) => Promise<string>

export type ApprovalOptions = {
  /** Reuse the chat's readline instead of opening a second one on stdin. */
  prompt?: Prompter
  /** Tools the user allowed for the rest of the session with "a". */
  sessionAllowed?: Set<string>
}

export async function approveTool(config: AgentConfig, tool: ToolDefinition, inputJson: JsonObject, options: ApprovalOptions = {}): Promise<boolean> {
  if (tool.readOnly) return true
  if (config.permissionMode === 'dangerous') return true
  if (config.permissionMode === 'read-only') return false
  if (config.permissionMode === 'auto' && !tool.destructive) return true
  if (!tool.destructive && options.sessionAllowed?.has(tool.name)) return true
  const label = tool.destructive ? 'destructive ' : ''
  const question = options.prompt
    ? `  Allow ${label}${tool.name}? ${tool.destructive ? '[y/N] ' : '[y]es / [N]o / [a]lways this session '}`
    : `Allow ${label}${tool.name}? ${JSON.stringify(inputJson).slice(0, 240)} [y/N] `
  let answer: string
  if (options.prompt) {
    answer = await options.prompt(question)
  } else {
    if (!process.stdin.isTTY) return false
    const rl = readline.createInterface({ input, output })
    try {
      answer = await rl.question(question)
    } finally {
      rl.close()
    }
  }
  const normalized = answer.trim().toLowerCase()
  if ((normalized === 'a' || normalized === 'always') && !tool.destructive) {
    options.sessionAllowed?.add(tool.name)
    return true
  }
  return normalized === 'y' || normalized === 'yes'
}

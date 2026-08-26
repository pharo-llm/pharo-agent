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

export async function approveTool(config: AgentConfig, tool: ToolDefinition, inputJson: JsonObject): Promise<boolean> {
  if (tool.readOnly) return true
  if (config.permissionMode === 'dangerous') return true
  if (config.permissionMode === 'read-only') return false
  if (config.permissionMode === 'auto' && !tool.destructive) return true
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input, output })
  try {
    const label = tool.destructive ? 'destructive ' : ''
    const answer = await rl.question(`Allow ${label}${tool.name}? ${JSON.stringify(inputJson).slice(0, 240)} [y/N] `)
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

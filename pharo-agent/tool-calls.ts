/**
 * Tool calls written as text, and the text protocol for models without native
 * tool calling.
 *
 * Small local models often ignore the server's tool-call format and write the
 * call in the reply instead, in whichever shape they saw in training:
 * `{"tool": …}`, `{"name": …}`, `{"function": …}`, OpenAI's
 * `{"type":"function","function":{…}}`, Qwen's `<tool_call>…</tool_call>`,
 * inside or outside a ```json fence, sometimes several in one reply, often with
 * raw newlines inside strings (method source). All of these count as calls.
 */
import type { ChatMessage, JsonObject, ToolCall, ToolDefinition } from './types.ts'

export type ExtractedToolCalls = {
  calls: ToolCall[]
  /** The reply with the calls taken out: what the model said around them. */
  narration: string
  /** Set when the reply looks like a tool call but none could be read. */
  malformed?: string
}

export function parseToolCalls(text: string, known?: Iterable<string>): ToolCall[] {
  return extractToolCalls(text, known).calls
}

/**
 * Every tool call in `text`. With `known`, only calls to those tools (and
 * `final`) count, so JSON that merely appears in an answer is not run.
 */
export function extractToolCalls(text: string, known?: Iterable<string>): ExtractedToolCalls {
  const names = known ? new Set(known) : undefined
  const calls: ToolCall[] = []
  const used: [number, number][] = []
  const invented = new Set<string>()
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char !== '{' && char !== '[') continue
    const end = balancedEnd(text, i)
    if (end < 0) continue
    const value = parseJsonLenient(text.slice(i, end + 1))
    const all = value === undefined ? [] : normalize(value)
    const found = all.filter(call => !names || call.name === 'final' || names.has(call.name))
    // A snake_case name with arguments is a call to a tool the model made up:
    // it needs to hear that, not have its JSON shown to the user.
    for (const call of all) if (!found.includes(call) && /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(call.name)) invented.add(call.name)
    if (!found.length) continue
    calls.push(...found)
    used.push([i, end + 1])
    i = end
  }
  let narration = text
  for (const [start, end] of used.reverse()) narration = narration.slice(0, start) + narration.slice(end)
  narration = narration
    .replace(/```[a-z]*\s*```/gi, '')
    .replace(/<tool_call>\s*(<\/tool_call>)?/g, '')
    .replace(/<\/tool_call>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const result: ExtractedToolCalls = { calls, narration }
  if (!calls.length) {
    const malformed = invented.size
      ? `there is no tool named ${[...invented].join(' or ')}; the tools are: ${[...names!].join(', ')}`
      : looksLikeToolCall(text, names)
    if (malformed) result.malformed = malformed
  }
  return result
}

function looksLikeToolCall(text: string, names?: Set<string>): string | undefined {
  if (/<tool_call>/.test(text)) return 'the <tool_call> block is not valid JSON'
  if (!names?.size) return undefined
  const pattern = new RegExp(`"(?:tool|name|function|tool_name)"\\s*:\\s*"(${[...names].map(escapeRegex).join('|')})"`)
  const match = text.match(pattern)
  return match ? `the call to ${match[1]} is not valid JSON` : undefined
}

function normalize(value: unknown): ToolCall[] {
  if (Array.isArray(value)) return value.flatMap(normalize)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  for (const key of ['tools', 'tool_calls']) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).flatMap(normalize)
  }
  if (typeof record.final === 'string') return [{ name: 'final', arguments: { answer: record.final } }]
  const fn = record.function && typeof record.function === 'object' && !Array.isArray(record.function)
    ? record.function as Record<string, unknown>
    : undefined
  const name = [record.tool, record.name, record.tool_name, fn?.name, record.function].find(each => typeof each === 'string') as string | undefined
  if (!name) return []
  const rawArgs = [record.arguments, record.args, record.parameters, record.input, fn?.arguments, fn?.parameters].find(each => each !== undefined)
  const args = toArguments(rawArgs)
  if (!args) return []
  const call: ToolCall = { name, arguments: args }
  if (typeof record.id === 'string') call.id = record.id
  return [call]
}

function toArguments(raw: unknown): JsonObject | undefined {
  if (raw === undefined || raw === null) return {}
  const value = typeof raw === 'string' ? (raw.trim() ? parseJsonLenient(raw) : {}) : raw
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

/** Index of the bracket that closes the one at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return -1
      if (!stack.length) return i
    }
  }
  return -1
}

/** JSON.parse that also takes raw newlines/tabs inside strings and trailing commas. */
export function parseJsonLenient(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    // repair below
  }
  let out = ''
  let inString = false
  let escaped = false
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      else if (char === '\n') {
        out += '\\n'
        continue
      } else if (char === '\r') {
        out += '\\r'
        continue
      } else if (char === '\t') {
        out += '\\t'
        continue
      }
      out += char
      continue
    }
    if (char === '"') inString = true
    else if (char === '}' || char === ']') out = out.replace(/,\s*$/, '')
    out += char
  }
  try {
    return JSON.parse(out)
  } catch {
    return undefined
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** System-prompt section for models that get no native `tools`. */
export function textToolProtocol(tools: ToolDefinition[]): string {
  const lines = tools.map(tool => {
    const required = new Set(tool.inputSchema.required ?? [])
    const params = Object.entries(tool.inputSchema.properties)
      .map(([name, prop]) => `${name}${required.has(name) ? '' : '?'}: ${typeof prop.type === 'string' ? prop.type : 'any'}`)
      .join(', ')
    return `- ${tool.name}(${params}): ${tool.description}`
  })
  return `# Calling tools
You run tools yourself. To call one, reply with only a JSON object, and no other text:
{"name": "file_read", "arguments": {"path": "README.md"}}
For several calls, write one JSON object per line. Strings must be valid JSON: write a newline inside a string as \\n.
Each result comes back in a message that starts with "Tool result for". When the task is done, reply with your answer as plain text.

Tools (a ? marks an optional argument):
${lines.join('\n')}`
}

/**
 * The native history rewritten for a model without native tools: calls become
 * the JSON the model is asked to write, results become user messages.
 */
export function toTextMessages(messages: ChatMessage[], tools: ToolDefinition[]): ChatMessage[] {
  const protocol = tools.length ? textToolProtocol(tools) : ''
  const out: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: protocol ? `${message.content}\n\n${protocol}` : message.content })
    } else if (message.role === 'assistant' && message.tool_calls?.length) {
      const calls = message.tool_calls.map(call => JSON.stringify({ name: call.function.name, arguments: parseJsonLenient(call.function.arguments) ?? {} }))
      out.push({ role: 'assistant', content: [message.content, ...calls].filter(Boolean).join('\n') })
    } else if (message.role === 'tool') {
      out.push({ role: 'user', content: `Tool result for ${message.name ?? 'tool'}:\n${message.content}` })
    } else {
      out.push({ role: message.role, content: message.content })
    }
  }
  if (protocol && !out.some(message => message.role === 'system')) out.unshift({ role: 'system', content: protocol })
  return out
}

/** The native history as the chat API takes it. */
export function toNativeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id ?? '' }
    if (message.tool_calls?.length) return { role: message.role, content: message.content, tool_calls: message.tool_calls }
    return { role: message.role, content: message.content }
  })
}

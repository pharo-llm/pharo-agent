import type { AgentConfig, AgentTool, ChatMessage, JsonObject, ToolCall, ToolResult } from './types.ts'
import { OpenAICompatibleClient } from './llm.ts'
import type { ChatResponse } from './llm.ts'
import { builtInTools } from './tools.ts'
import { workspaceContext } from './workspace.ts'
import { approveTool } from './permissions.ts'
import { readMemory } from './memory.ts'
import { SessionRecorder } from './sessions.ts'

export class AgentLoopError extends Error {}

export type AgentRunOptions = {
  cwd?: string
  verbose?: boolean
  resumeMessages?: ChatMessage[]
  recorder?: SessionRecorder
  signal?: AbortSignal
}

export type AgentTurnResult = {
  answer: string
  messages: ChatMessage[]
}

export type AgentLlmClient = {
  models(): Promise<string[]>
  chat(options: {
    model: string
    messages: ChatMessage[]
    tools?: AgentTool[]
    temperature?: number
    maxTokens?: number
  }): Promise<ChatResponse>
}

export class PharoAgentLoop {
  private config: AgentConfig
  private client: AgentLlmClient
  private tools: AgentTool[]

  constructor(config: AgentConfig, tools = builtInTools(), client?: AgentLlmClient) {
    this.config = config
    this.client = client ?? new OpenAICompatibleClient(config.baseUrl, config.apiKey, config.timeoutSeconds * 1_000)
    this.tools = tools
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<string> {
    return (await this.runTurn(prompt, options)).answer
  }

  async runTurn(prompt: string, options: AgentRunOptions = {}): Promise<AgentTurnResult> {
    const cwd = options.cwd ?? process.cwd()
    const model = await this.modelName()
    const resumeMessages = options.resumeMessages ?? []
    const messages: ChatMessage[] = [
      ...(resumeMessages.some(message => message.role === 'system') ? [] : [{ role: 'system' as const, content: await this.systemPrompt(cwd) }]),
      ...resumeMessages,
      { role: 'user', content: prompt },
    ]
    await options.recorder?.record({ type: 'message', message: messages.at(-1)!, timestamp: new Date().toISOString() })
    for (let iteration = 1; iteration <= this.config.maxIterations; iteration += 1) {
      const response = await this.client.chat({
        model,
        messages,
        tools: this.tools,
        temperature: this.config.temperature,
      })
      const content = response.content.trim()
      if (options.verbose) process.stderr.write(`[iteration ${iteration}] ${content}\n`)
      const calls = response.toolCalls.length ? response.toolCalls : parseToolCalls(content)
      if (calls.length === 0) {
        messages.push({ role: 'assistant', content })
        await options.recorder?.record({ type: 'message', message: messages.at(-1)!, timestamp: new Date().toISOString() })
        await options.recorder?.record({ type: 'final', content, timestamp: new Date().toISOString() })
        return { answer: content, messages }
      }
      const final = calls.find(call => call.name === 'final')
      if (final) {
        const answer = typeof final.arguments.answer === 'string' ? final.arguments.answer : String(final.arguments.content ?? '')
        messages.push({ role: 'assistant', content: answer })
        await options.recorder?.record({ type: 'message', message: messages.at(-1)!, timestamp: new Date().toISOString() })
        await options.recorder?.record({ type: 'final', content: answer, timestamp: new Date().toISOString() })
        return { answer, messages }
      }
      messages.push({ role: 'assistant', content })
      await options.recorder?.record({ type: 'message', message: messages.at(-1)!, timestamp: new Date().toISOString() })
      for (const call of calls) {
        await options.recorder?.record({ type: 'tool_call', call, timestamp: new Date().toISOString() })
        const result = await this.runTool(call, cwd, options)
        await options.recorder?.record({ type: 'tool_result', call, result, timestamp: new Date().toISOString() })
        messages.push({
          role: 'user',
          content: `Tool result for ${call.name}:\n${JSON.stringify(result, null, 2)}\nContinue with a tool call JSON object or final answer.`,
        })
      }
    }
    throw new AgentLoopError(`Reached max iterations (${this.config.maxIterations}) without a final answer.`)
  }

  private async runTool(call: ToolCall, cwd: string, options: AgentRunOptions): Promise<ToolResult> {
    const tool = this.tools.find(candidate => candidate.name === call.name)
    if (!tool) return { ok: false, data: { error: `Unknown tool: ${call.name}` } }
    try {
      return await tool.run(call.arguments, {
        config: this.config,
        cwd,
        signal: options.signal ?? new AbortController().signal,
        approve: (definition, input) => approveTool(this.config, definition, input),
        record: event => options.recorder?.record(event) ?? Promise.resolve(),
      })
    } catch (error) {
      return { ok: false, data: { error: (error as Error).message, stack: (error as Error).stack } }
    }
  }

  private async modelName(): Promise<string> {
    if (this.config.model) return this.config.model
    const models = await this.client.models()
    if (!models[0]) throw new AgentLoopError('No model configured and the LLM server returned no models.')
    return models[0]
  }

  private async systemPrompt(cwd: string): Promise<string> {
    const memory = await readMemory(this.config, cwd)
    const toolDescriptions = this.tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')
    return `You are Pharo Agent, a local TypeScript coding agent for Pharo Smalltalk projects.

You have a full local coding-agent tool loop: inspect files, edit files, search, run shell commands, manage durable memory, call MCP tools, evaluate Smalltalk, run Pharo scripts, and run SUnit tests.

Use tools whenever the answer depends on the live workspace or live Pharo image. Do not invent classes, methods, packages, files, or test results. Prefer small, verifiable steps. When changing files, inspect first, edit precisely, and run the relevant checks.

Tool protocol fallback for GGUF models:
- Call one or more tools by returning JSON only:
  {"tool":"file_read","arguments":{"path":"README.md"}}
  {"tools":[{"tool":"pharo_test","arguments":{"package":"MyPackage"}}]}
- Finish by returning JSON only:
  {"tool":"final","arguments":{"answer":"your answer"}}

Available tools:
${toolDescriptions}

${await workspaceContext(cwd)}

# Memory
${memory || '(empty)'}`
  }
}

export function parseToolCalls(text: string): ToolCall[] {
  const parsed = extractJson(text)
  if (!parsed || typeof parsed !== 'object') return []
  if (Array.isArray(parsed)) return parsed.flatMap(item => normalizeCall(item))
  const record = parsed as Record<string, unknown>
  if (Array.isArray(record.tools)) return record.tools.flatMap(item => normalizeCall(item))
  return normalizeCall(record)
}

function normalizeCall(value: unknown): ToolCall[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  if (record.final !== undefined) {
    return [{ name: 'final', arguments: { answer: String(record.final) } }]
  }
  const tool = typeof record.tool === 'string' ? record.tool : typeof record.name === 'string' ? record.name : undefined
  if (!tool) return []
  const args = record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
    ? record.arguments as JsonObject
    : {}
  return [{ id: typeof record.id === 'string' ? record.id : undefined, name: tool, arguments: args }]
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const source = fence?.[1]?.trim() ?? trimmed
  if (source.startsWith('{') || source.startsWith('[')) {
    try {
      return JSON.parse(source)
    } catch {
      // fall through to balanced extraction
    }
  }
  const start = [...source].findIndex(char => char === '{' || char === '[')
  if (start < 0) return undefined
  const open = source[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

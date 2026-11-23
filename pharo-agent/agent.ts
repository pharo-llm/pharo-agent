import type { AgentConfig, AgentTool, ChatMessage, JsonObject, ToolCall, ToolResult } from './types.ts'
import { OpenAICompatibleClient } from './llm.ts'
import { cloudHeaders, isCloud, registerMachine } from './cloud.ts'
import type { ChatResponse } from './llm.ts'
import { builtInTools } from './tools.ts'
import { workspaceContext } from './workspace.ts'
import { approveTool } from './permissions.ts'
import type { Prompter } from './permissions.ts'
import { readMemory } from './memory.ts'
import { SessionRecorder } from './sessions.ts'

export class AgentLoopError extends Error {}

export class AgentInterrupted extends Error {
  constructor() {
    super('Interrupted')
  }
}

/** Everything the loop does, as it happens, so a UI can show it. */
export type AgentEvent = (
  | { type: 'model_start'; iteration: number }
  | { type: 'model_end'; iteration: number; durationMs: number; tokens?: number }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_start'; call: ToolCall; tool?: AgentTool }
  | { type: 'tool_end'; call: ToolCall; result: ToolResult; durationMs: number }
) & { depth?: number }

export type AgentRunOptions = {
  cwd?: string
  verbose?: boolean
  resumeMessages?: ChatMessage[]
  recorder?: SessionRecorder
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
  /** Ask the human (approvals). Defaults to a private readline on stdin. */
  prompt?: Prompter
}

/** How many empty replies in a row the loop nudges before giving up. */
const maxEmptyReplies = 2

/** Keep one huge tool result from flooding a small local model's context. */
const maxToolResultChars = 24_000

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
    signal?: AbortSignal
  }): Promise<ChatResponse>
}

export class PharoAgentLoop {
  private config: AgentConfig
  private client: AgentLlmClient
  private tools: AgentTool[]
  /** Tools the user approved with "always" during this loop's lifetime. */
  readonly sessionAllowed = new Set<string>()

  constructor(config: AgentConfig, tools = builtInTools(), client?: AgentLlmClient) {
    this.config = config
    this.client = client ?? new OpenAICompatibleClient(config.baseUrl, config.apiKey, config.timeoutSeconds * 1_000, {
      headers: cloudHeaders(config),
      reregister: isCloud(config) ? async () => {
        const registered = await registerMachine(config.cloudUrl!)
        config.cloudClientId = registered.clientId
        return { 'x-pharo-client-id': registered.clientId }
      } : undefined,
    })
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
    const emit = options.onEvent ?? (() => undefined)
    let emptyReplies = 0
    const checkAborted = () => {
      if (options.signal?.aborted) throw new AgentInterrupted()
    }
    for (let iteration = 1; iteration <= this.config.maxIterations; iteration += 1) {
      checkAborted()
      emit({ type: 'model_start', iteration })
      const started = Date.now()
      let response: ChatResponse | undefined
      try {
        response = await this.client.chat({
          model,
          messages,
          tools: this.tools,
          temperature: this.config.temperature,
          maxTokens: this.config.maxOutputTokens,
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw new AgentInterrupted()
        throw error
      } finally {
        emit({ type: 'model_end', iteration, durationMs: Date.now() - started, tokens: response?.usage ? response.usage.promptTokens + response.usage.completionTokens : undefined })
      }
      // Reasoning models may wrap their thinking in <think> tags: it is not an answer.
      const content = response.content.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim()
      if (options.verbose) process.stderr.write(`[iteration ${iteration}] ${content}\n`)
      const calls = response.toolCalls.length ? response.toolCalls : parseToolCalls(content)
      if (calls.length === 0 && !content && emptyReplies < maxEmptyReplies) {
        // Small local models sometimes stop mid-task with an empty reply. Ask them to
        // go on instead of ending the turn with no answer.
        emptyReplies += 1
        messages.push({ role: 'user', content: 'Your last reply was empty. Continue the task: call the next tool, or give your final answer if the task is done.' })
        continue
      }
      emptyReplies = 0
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
      // Narration that came with native tool calls ("Let me look at the tests first").
      if (response.toolCalls.length && content) emit({ type: 'assistant_text', text: content })
      messages.push({ role: 'assistant', content: content || JSON.stringify({ tools: calls.map(call => ({ tool: call.name, arguments: call.arguments })) }) })
      await options.recorder?.record({ type: 'message', message: messages.at(-1)!, timestamp: new Date().toISOString() })
      for (const call of calls) {
        checkAborted()
        const tool = this.tools.find(candidate => candidate.name === call.name)
        emit({ type: 'tool_start', call, tool })
        await options.recorder?.record({ type: 'tool_call', call, timestamp: new Date().toISOString() })
        const toolStarted = Date.now()
        const result = await this.runTool(call, cwd, options)
        emit({ type: 'tool_end', call, result, durationMs: Date.now() - toolStarted })
        await options.recorder?.record({ type: 'tool_result', call, result, timestamp: new Date().toISOString() })
        checkAborted()
        let serialized = JSON.stringify(result, null, 2)
        if (serialized.length > maxToolResultChars) serialized = `${serialized.slice(0, maxToolResultChars)}\n... (truncated ${serialized.length - maxToolResultChars} characters)`
        messages.push({
          role: 'user',
          content: `Tool result for ${call.name}:\n${serialized}\nContinue with a tool call JSON object or final answer.`,
        })
      }
    }
    throw new AgentLoopError(`Reached max iterations (${this.config.maxIterations}) without a final answer.`)
  }

  private async runTool(call: ToolCall, cwd: string, options: AgentRunOptions): Promise<ToolResult> {
    const tool = this.tools.find(candidate => candidate.name === call.name)
    if (!tool) return { ok: false, data: { error: `Unknown tool: ${call.name}. Available: ${this.tools.map(each => each.name).join(', ')}` } }
    try {
      return await tool.run(call.arguments, {
        config: this.config,
        cwd,
        signal: options.signal ?? new AbortController().signal,
        approve: (definition, input) => approveTool(this.config, definition, input, { prompt: options.prompt, sessionAllowed: this.sessionAllowed }),
        record: event => options.recorder?.record(event) ?? Promise.resolve(),
        prompt: options.prompt,
        onEvent: options.onEvent,
      })
    } catch (error) {
      if (options.signal?.aborted) throw new AgentInterrupted()
      return { ok: false, data: { error: (error as Error).message } }
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
    return `You are Pharo Agent, a local coding agent for Pharo Smalltalk projects.

You have a full local tool loop: inspect files, edit files, search, run shell commands, manage durable memory, call MCP tools, and work directly inside a Pharo image (evaluate Smalltalk, browse classes and methods, define classes, compile methods, run SUnit tests).

Use tools whenever the answer depends on the workspace or the Pharo image. Do not invent classes, methods, packages, files, or test results. Prefer small, verifiable steps. When changing files, inspect first, edit precisely, and run the relevant checks.

# Working in the Pharo image
- Every pharo_* result has a "backend" field. "live" means the user's running image: changes you make stay there immediately, so be careful. "headless" means a throwaway copy booted for that one call: changes are discarded afterwards, so tell the user if you changed something in headless mode.
- Explore before changing: pharo_find (classes, implementors, senders, references), pharo_inspect (image, package, or class overview), pharo_source (class definition or method source).
- Create or change classes with pharo_define_class and methods with pharo_compile. They work on every Pharo version. Do not write class definitions inside pharo_eval: the syntax differs between Pharo versions.
- pharo_eval compiles the whole snippet first, so it cannot mention a class created in the same snippet. Use Smalltalk at: #ClassName, or make two calls.
- After changing code, run the relevant tests with pharo_test.
- Only call pharo_save when the user asks you to save the image.
- Images are managed like Pharo Launcher does: image_list shows them (and which one is selected), image_templates lists what can be created, image_create / image_select / image_start / image_stop manage them. If the selected image is stopped, start it (image_start) before changing code so the changes are kept.

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

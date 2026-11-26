import { randomUUID } from 'node:crypto'
import type { AgentConfig, AgentTool, ChatMessage, ToolCall, ToolResult } from './types.ts'
import { extractToolCalls } from './tool-calls.ts'
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

/** How many unreadable tool calls in a row the loop sends back for a retry. */
const maxMalformedReplies = 2

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
    let malformedReplies = 0
    /** Reads and failed calls already answered since the last change: small models repeat them. */
    const answered = new Set<string>()
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
      // Small models often write the call in the reply instead of using the
      // server's tool-call format: those count as calls too.
      const extracted = response.toolCalls.length
        ? { calls: response.toolCalls, narration: content, malformed: undefined }
        : extractToolCalls(content, this.tools.map(tool => tool.name))
      const calls = extracted.calls
      if (calls.length === 0 && !content && emptyReplies < maxEmptyReplies) {
        // Small local models sometimes stop mid-task with an empty reply. Ask them to
        // go on instead of ending the turn with no answer.
        emptyReplies += 1
        messages.push({ role: 'user', content: 'Your last reply was empty. Continue the task: call the next tool, or give your final answer if the task is done.' })
        continue
      }
      emptyReplies = 0
      if (calls.length === 0 && extracted.malformed && malformedReplies < maxMalformedReplies) {
        // A call the harness cannot read must not reach the user as the answer.
        malformedReplies += 1
        messages.push({ role: 'assistant', content })
        messages.push({ role: 'user', content: `Your last reply tried to call a tool, but ${extracted.malformed}, so nothing ran. Call the tool again with valid JSON, {"name": "<tool>", "arguments": {...}}, escaping newlines inside strings as \\n. Do not explain the call to me: make it.` })
        continue
      }
      malformedReplies = 0
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
      // Narration that came with the calls ("Let me look at the tests first").
      if (extracted.narration) emit({ type: 'assistant_text', text: extracted.narration })
      const ids = calls.map(call => call.id ?? `call_${randomUUID().replaceAll('-', '').slice(0, 12)}`)
      // History keeps the native shape whichever way the model wrote the call, so
      // the model sees well-formed calls in its context. Narration stays out: some
      // chat templates (Ollama's Qwen) drop the calls of a message that has text.
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: calls.map((call, index) => ({ id: ids[index]!, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      })
      await options.recorder?.record({ type: 'message', message: messages.at(-1)!, timestamp: new Date().toISOString() })
      for (const [index, call] of calls.entries()) {
        checkAborted()
        const tool = this.tools.find(candidate => candidate.name === call.name)
        emit({ type: 'tool_start', call, tool })
        await options.recorder?.record({ type: 'tool_call', call, timestamp: new Date().toISOString() })
        const toolStarted = Date.now()
        const key = `${call.name} ${stableJson(call.arguments)}`
        const repeated = answered.has(key)
        const result: ToolResult = repeated
          ? { ok: false, data: { error: `You already called ${call.name} with these arguments and nothing has changed since, so it was not run again. Use the result you got above: answer the user, or call a different tool.` } }
          : await this.runTool(call, cwd, options)
        // A read, or a failed change, gives the same result until something changes.
        if (tool?.readOnly || !result.ok) answered.add(key)
        else if (tool) answered.clear()
        emit({ type: 'tool_end', call, result, durationMs: Date.now() - toolStarted })
        await options.recorder?.record({ type: 'tool_result', call, result, timestamp: new Date().toISOString() })
        checkAborted()
        let serialized = JSON.stringify(result, null, 2)
        if (serialized.length > maxToolResultChars) serialized = `${serialized.slice(0, maxToolResultChars)}\n... (truncated ${serialized.length - maxToolResultChars} characters)`
        messages.push({ role: 'tool', tool_call_id: ids[index]!, name: call.name, content: serialized })
        await options.recorder?.record({ type: 'message', message: messages.at(-1)!, timestamp: new Date().toISOString() })
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

You act; you do not advise. When the user asks you to do something, call the tools that do it, then report what happened. Never show the user tool calls or JSON as instructions to follow: nobody else will run them.

Use tools whenever the answer depends on the workspace or the Pharo image. Do not invent classes, methods, packages, files, or test results. Prefer small, verifiable steps. When changing files, inspect first, edit precisely, and run the relevant checks.

# Working in the Pharo image
- Every pharo_* result has a "backend" field. "live" means the user's running image: changes you make stay there immediately, so be careful. "headless" means a throwaway copy booted for that one call: changes are discarded afterwards, so tell the user if you changed something in headless mode.
- Explore before changing: pharo_find (classes, implementors, senders, references), pharo_inspect (image, package, or class overview), pharo_source (class definition or method source).
- Create or change classes with pharo_define_class and methods with pharo_compile. They work on every Pharo version. Do not write class definitions inside pharo_eval: the syntax differs between Pharo versions.
- pharo_eval compiles the whole snippet first, so it cannot mention a class created in the same snippet. Use Smalltalk at: #ClassName, or make two calls.
- After changing code, run the relevant tests with pharo_test.
- Only call pharo_save when the user asks you to save the image.
- Images are managed like Pharo Launcher does: image_list shows them (and which one is selected), image_templates lists what can be created, image_create / image_select / image_start / image_stop manage them. If the selected image is stopped, start it (image_start) before changing code so the changes are kept.

Available tools:
${toolDescriptions}

${await workspaceContext(cwd)}

# Memory
${memory || '(empty)'}`
  }
}

export { parseToolCalls } from './tool-calls.ts'

/** JSON with sorted keys, so the same arguments in another order compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

import type { ChatMessage, JsonObject, ToolCall, ToolDefinition } from './types.ts'

export class LlmError extends Error {
  status?: number
  type?: string
  constructor(message: string, status?: number, type?: string) {
    super(message)
    this.status = status
    this.type = type
  }
}

export type ChatResponse = {
  content: string
  toolCalls: ToolCall[]
  raw: unknown
  usage?: { promptTokens: number; completionTokens: number }
}

export type ClientOptions = {
  /** Sent with every request (Pharo Cloud: X-Pharo-Client-Id). */
  headers?: Record<string, string>
  /** Called once on 401 "unregistered" (e.g. the cloud lost this machine): returns new headers. */
  reregister?: () => Promise<Record<string, string> | undefined>
}

export class OpenAICompatibleClient {
  private baseUrl: string
  private apiKey?: string
  private timeoutMs: number
  private options: ClientOptions
  /** Models the server said cannot take native tools: they get the JSON protocol. */
  private readonly noNativeTools = new Set<string>()

  constructor(baseUrl: string, apiKey?: string, timeoutMs = 120_000, options: ClientOptions = {}) {
    this.baseUrl = baseUrl
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
    this.options = options
  }

  async models(): Promise<string[]> {
    const data = await this.request<{ data?: { id?: string }[] }>('GET', '/models')
    return (data.data ?? []).filter(item => typeof item.id === 'string').map(item => item.id!)
  }

  async available(): Promise<boolean> {
    try {
      await this.models()
      return true
    } catch {
      return false
    }
  }

  async chat(options: {
    model: string
    messages: ChatMessage[]
    tools?: ToolDefinition[]
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): Promise<ChatResponse> {
    const body: JsonObject = {
      model: options.model,
      messages: options.messages as unknown as JsonObject[],
      temperature: options.temperature ?? 0.2,
      stream: false,
    }
    if (options.maxTokens) body.max_tokens = options.maxTokens
    // Models without a tool template (common for GGUF fine-tunes) use the JSON
    // tool protocol from the system prompt instead.
    if (options.tools?.length && !this.noNativeTools.has(options.model)) {
      body.tools = options.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })) as unknown as JsonObject[]
      body.tool_choice = 'auto'
    }
    let data: { choices?: { message?: { content?: unknown; tool_calls?: unknown[] } }[] }
    try {
      data = await this.request('POST', '/chat/completions', body, options.signal)
    } catch (error) {
      if (body.tools && error instanceof LlmError && /(does not|doesn't) support tools|tools? (is|are) not supported|tool_choice/i.test(error.message)) {
        this.noNativeTools.add(options.model)
        delete body.tools
        delete body.tool_choice
        data = await this.request('POST', '/chat/completions', body, options.signal)
      } else throw error
    }
    const message = data.choices?.[0]?.message
    if (!message) throw new LlmError('LLM response did not include a chat message')
    const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: parseNativeToolCalls(message.tool_calls),
      raw: data,
      usage: usage ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 } : undefined,
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, retried = false): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'pharo-agent/0.1',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let error: { message?: string; type?: string } | undefined
        try {
          error = (JSON.parse(text) as { error?: { message?: string; type?: string } }).error
        } catch {
          // not JSON
        }
        if (response.status === 401 && error?.type === 'unregistered' && this.options.reregister && !retried) {
          const headers = await this.options.reregister()
          if (headers) {
            this.options.headers = { ...this.options.headers, ...headers }
            clearTimeout(timer)
            return this.request<T>(method, path, body, signal, true)
          }
        }
        // Servers such as Pharo Cloud write messages meant for people: show them as they are.
        throw new LlmError(error?.message ?? `LLM server returned HTTP ${response.status}: ${text.slice(0, 500)}`, response.status, error?.type)
      }
      return await response.json() as T
    } catch (error) {
      if (error instanceof LlmError) throw error
      if (signal?.aborted) throw new LlmError('Interrupted')
      if (controller.signal.aborted) throw new LlmError(`LLM server at ${this.baseUrl} did not answer within ${Math.round(this.timeoutMs / 1000)}s`)
      throw new LlmError(`Could not reach LLM server at ${this.baseUrl}: ${(error as Error).message}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}

function parseNativeToolCalls(raw: unknown[] | undefined): ToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: ToolCall[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as { id?: string; function?: { name?: string; arguments?: unknown } }
    const name = record.function?.name
    if (!name) continue
    let args: JsonObject = {}
    const rawArgs = record.function?.arguments
    if (typeof rawArgs === 'string') {
      try {
        const parsed = JSON.parse(rawArgs)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
      } catch {
        args = {}
      }
    } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      args = rawArgs as JsonObject
    }
    calls.push({ id: record.id, name, arguments: args })
  }
  return calls
}

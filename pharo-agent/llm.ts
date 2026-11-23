import type { ChatMessage, JsonObject, ToolCall, ToolDefinition } from './types.ts'

export class LlmError extends Error {}

export type ChatResponse = {
  content: string
  toolCalls: ToolCall[]
  raw: unknown
}

export class OpenAICompatibleClient {
  private baseUrl: string
  private apiKey?: string
  private timeoutMs: number

  constructor(baseUrl: string, apiKey?: string, timeoutMs = 120_000) {
    this.baseUrl = baseUrl
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
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
    if (options.tools?.length) {
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
    const data = await this.request<{ choices?: { message?: { content?: unknown; tool_calls?: unknown[] } }[] }>('POST', '/chat/completions', body, options.signal)
    const message = data.choices?.[0]?.message
    if (!message) throw new LlmError('LLM response did not include a chat message')
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: parseNativeToolCalls(message.tool_calls),
      raw: data,
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new LlmError(`LLM server returned HTTP ${response.status}: ${text.slice(0, 500)}`)
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

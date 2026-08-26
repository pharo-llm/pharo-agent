export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ChatMessage = {
  role: ChatRole
  content: string
  name?: string
  tool_call_id?: string
}

export type ToolSchema = {
  type: 'object'
  properties: Record<string, JsonObject>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolDefinition = {
  name: string
  description: string
  inputSchema: ToolSchema
  readOnly: boolean
  destructive?: boolean
}

export type ToolCall = {
  id?: string
  name: string
  arguments: JsonObject
}

export type ToolResult = {
  ok: boolean
  data: JsonValue
  summary?: string
}

export type PermissionMode = 'ask' | 'auto' | 'read-only' | 'dangerous'

export type AgentConfig = {
  pharoVm?: string
  image?: string
  headless: boolean
  timeoutSeconds: number
  modelRepo: string
  publishRepo: string
  model?: string
  modelFile?: string
  modelPath?: string
  modelCacheDir?: string
  baseUrl: string
  apiKey?: string
  llamaServer?: string
  llamaPort: number
  maxIterations: number
  temperature: number
  permissionMode: PermissionMode
  allowOutsideWorkspace: boolean
  allowPrivateNetwork: boolean
  mcpConfig?: string
  memoryFile?: string
}

export type ToolContext = {
  config: AgentConfig
  cwd: string
  signal: AbortSignal
  approve(tool: ToolDefinition, input: JsonObject): Promise<boolean>
  record(event: SessionEvent): Promise<void>
}

export type AgentTool = ToolDefinition & {
  run(input: JsonObject, context: ToolContext): Promise<ToolResult>
}

export type SessionEvent =
  | { type: 'message'; message: ChatMessage; timestamp: string }
  | { type: 'tool_call'; call: ToolCall; timestamp: string }
  | { type: 'tool_result'; call: ToolCall; result: ToolResult; timestamp: string }
  | { type: 'final'; content: string; timestamp: string }
  | { type: 'error'; message: string; timestamp: string }

export type SessionRecord = {
  id: string
  path: string
  createdAt: string
  updatedAt: string
  title?: string
}

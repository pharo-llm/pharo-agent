import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentConfig, JsonObject, ToolDefinition, ToolResult } from './types.ts'
import { pathExists } from './platform.ts'

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type McpConfig = {
  mcpServers?: Record<string, McpServerConfig>
}

export async function loadMcpConfig(config: AgentConfig, cwd = process.cwd()): Promise<McpConfig> {
  const file = config.mcpConfig ?? path.join(cwd, '.pharo-agent.mcp.json')
  if (!await pathExists(file)) return {}
  return JSON.parse(await readFile(file, 'utf8')) as McpConfig
}

export async function listMcpTools(config: AgentConfig, cwd = process.cwd()): Promise<ToolDefinition[]> {
  const mcp = await loadMcpConfig(config, cwd)
  const servers = Object.entries(mcp.mcpServers ?? {})
  const tools: ToolDefinition[] = []
  for (const [serverName, server] of servers) {
    const client = await McpStdioClient.start(server)
    try {
      const listed = await client.listTools()
      for (const tool of listed) {
        tools.push({
          name: `mcp__${serverName}__${tool.name}`,
          description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          readOnly: false,
        })
      }
    } finally {
      client.close()
    }
  }
  return tools
}

export async function callMcpTool(config: AgentConfig, serverName: string, toolName: string, args: JsonObject, cwd = process.cwd()): Promise<ToolResult> {
  const mcp = await loadMcpConfig(config, cwd)
  const server = mcp.mcpServers?.[serverName]
  if (!server) return { ok: false, data: { error: `MCP server not found: ${serverName}` } }
  const client = await McpStdioClient.start(server)
  try {
    const result = await client.callTool(toolName, args)
    return { ok: !result.isError, data: result as unknown as JsonObject }
  } finally {
    client.close()
  }
}

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams
  private id = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private buffer = ''

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.onData(chunk))
    child.stderr.setEncoding('utf8')
  }

  static async start(config: McpServerConfig): Promise<McpStdioClient> {
    const child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = new McpStdioClient(child)
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pharo-agent', version: '0.1.0' },
    })
    client.notify('notifications/initialized', {})
    return client
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: ToolDefinition['inputSchema'] }[]> {
    const result = await this.request('tools/list', {})
    return ((result as { tools?: unknown[] }).tools ?? []) as { name: string; description?: string; inputSchema?: ToolDefinition['inputSchema'] }[]
  }

  async callTool(name: string, args: JsonObject): Promise<{ isError?: boolean; content?: unknown[]; structuredContent?: unknown }> {
    return await this.request('tools/call', { name, arguments: args }) as { isError?: boolean; content?: unknown[]; structuredContent?: unknown }
  }

  close(): void {
    this.child.kill('SIGTERM')
  }

  private notify(method: string, params: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = ++this.id
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request timed out: ${method}`))
      }, 30_000).unref()
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n')
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id === undefined) continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'MCP error'))
      else pending.resolve(message.result)
    }
  }
}

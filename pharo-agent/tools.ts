import path from 'node:path'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { AgentTool, JsonObject, ToolContext, ToolResult } from './types.ts'
import { evaluateSmalltalk, inspectImage, runPharoScriptFile, runSUnit } from './pharo.ts'
import { collectFiles, isTextFile, readTextSlice } from './workspace.ts'
import { appendMemory, readMemory } from './memory.ts'
import { callMcpTool, listMcpTools } from './mcp.ts'
import { execFileCapture, shellCommand } from './platform.ts'
import { isDestructiveShellCommand, isReadOnlyShellCommand } from './permissions.ts'
import { addTask, clearCompletedTasks, readTasks, updateTask } from './task-store.ts'
import { fetchUrl, webSearch } from './web-tools.ts'
import { isWorkspaceRoot, resolveWorkspacePath } from './safety.ts'

export function builtInTools(): AgentTool[] {
  return [
    listDirTool,
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    fileDeleteTool,
    globTool,
    grepTool,
    shellTool,
    pharoInspectTool,
    pharoEvalTool,
    pharoScriptTool,
    pharoTestTool,
    memoryReadTool,
    memoryWriteTool,
    taskListTool,
    taskAddTool,
    taskUpdateTool,
    taskClearCompletedTool,
    webFetchTool,
    webSearchTool,
    subagentTool,
    mcpListToolsTool,
    mcpCallToolTool,
  ]
}

const listDirTool: AgentTool = {
  name: 'list_dir',
  description: 'List files and directories under a path.',
  readOnly: true,
  inputSchema: schema({ path: stringProp('Directory path. Defaults to current directory.', false) }),
  async run(input, context) {
    const dir = resolveInputPath(input.path, context)
    const entries = await readdir(dir, { withFileTypes: true })
    return ok(entries.map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`).sort())
  },
}

const fileReadTool: AgentTool = {
  name: 'file_read',
  description: 'Read a text file with optional offset and limit.',
  readOnly: true,
  inputSchema: schema({
    path: stringProp('File path to read.', true),
    offset: numberProp('Character offset.', false),
    limit: numberProp('Maximum characters to read.', false),
  }, ['path']),
  async run(input, context) {
    const file = resolveInputPath(input.path, context)
    return ok(await readTextSlice(file, numberValue(input.offset, 0), numberValue(input.limit, 20_000)))
  },
}

const fileWriteTool: AgentTool = {
  name: 'file_write',
  description: 'Write a full text file, creating parent directories as needed.',
  readOnly: false,
  inputSchema: schema({
    path: stringProp('File path to write.', true),
    content: stringProp('Complete file content.', true),
  }, ['path', 'content']),
  async run(input, context) {
    if (!await context.approve(fileWriteTool, input)) return denied()
    const file = resolveInputPath(input.path, context)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, String(input.content ?? ''), 'utf8')
    return ok({ path: file, bytes: Buffer.byteLength(String(input.content ?? ''), 'utf8') })
  },
}

const fileEditTool: AgentTool = {
  name: 'file_edit',
  description: 'Replace one exact string in a text file.',
  readOnly: false,
  inputSchema: schema({
    path: stringProp('File path to edit.', true),
    oldString: stringProp('Exact text to replace.', true),
    newString: stringProp('Replacement text.', true),
    replaceAll: boolProp('Replace all occurrences instead of exactly one.', false),
  }, ['path', 'oldString', 'newString']),
  async run(input, context) {
    if (!await context.approve(fileEditTool, input)) return denied()
    const file = resolveInputPath(input.path, context)
    const oldString = String(input.oldString ?? '')
    const newString = String(input.newString ?? '')
    const content = await readFile(file, 'utf8')
    const count = content.split(oldString).length - 1
    if (count === 0) return fail(`oldString not found in ${file}`)
    if (!input.replaceAll && count !== 1) return fail(`oldString matched ${count} times. Set replaceAll true or provide a more specific string.`)
    const next = input.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
    await writeFile(file, next, 'utf8')
    return ok({ path: file, replacements: input.replaceAll ? count : 1 })
  },
}

const fileDeleteTool: AgentTool = {
  name: 'file_delete',
  description: 'Delete a file or directory.',
  readOnly: false,
  destructive: true,
  inputSchema: schema({
    path: stringProp('Path to delete.', true),
    recursive: boolProp('Allow recursive directory deletion.', false),
  }, ['path']),
  async run(input, context) {
    if (!await context.approve(fileDeleteTool, input)) return denied()
    const target = resolveInputPath(input.path, context)
    if (isWorkspaceRoot(target, context.cwd)) return fail('Refusing to delete the workspace root.')
    await rm(target, { recursive: Boolean(input.recursive), force: false })
    return ok({ path: target, deleted: true })
  },
}

const globTool: AgentTool = {
  name: 'glob',
  description: 'Find files by glob-like pattern.',
  readOnly: true,
  inputSchema: schema({
    pattern: stringProp('Pattern such as **/*.st or *.md.', true),
    path: stringProp('Root path. Defaults to current directory.', false),
    maxResults: numberProp('Maximum files to return.', false),
  }, ['pattern']),
  async run(input, context) {
    const root = resolveInputPath(input.path, context)
    const files = await collectFiles(root, { maxFiles: 5_000 })
    const regex = globToRegex(String(input.pattern ?? '*'))
    const max = numberValue(input.maxResults, 100)
    const matches = files
      .map(file => path.relative(context.cwd, file))
      .filter(file => regex.test(file))
      .slice(0, max)
    return ok({ files: matches, count: matches.length, truncated: matches.length >= max })
  },
}

const grepTool: AgentTool = {
  name: 'grep',
  description: 'Search text files with a regular expression.',
  readOnly: true,
  inputSchema: schema({
    pattern: stringProp('JavaScript regular expression.', true),
    path: stringProp('Root path. Defaults to current directory.', false),
    glob: stringProp('Optional glob filter.', false),
    caseInsensitive: boolProp('Case-insensitive search.', false),
    maxResults: numberProp('Maximum matches to return.', false),
  }, ['pattern']),
  async run(input, context) {
    const root = resolveInputPath(input.path, context)
    const files = await collectFiles(root, { maxFiles: 5_000 })
    const globRegex = input.glob ? globToRegex(String(input.glob)) : undefined
    const regex = new RegExp(String(input.pattern), input.caseInsensitive ? 'i' : '')
    const max = numberValue(input.maxResults, 100)
    const matches: { path: string; line: number; text: string }[] = []
    for (const file of files) {
      const relative = path.relative(context.cwd, file)
      if (globRegex && !globRegex.test(relative)) continue
      if (!await isTextFile(file)) continue
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index]!)) matches.push({ path: relative, line: index + 1, text: lines[index]!.slice(0, 500) })
        if (matches.length >= max) return ok({ matches, count: matches.length, truncated: true })
      }
    }
    return ok({ matches, count: matches.length, truncated: false })
  },
}

const shellTool: AgentTool = {
  name: 'shell',
  description: 'Run a terminal command in the workspace.',
  readOnly: false,
  inputSchema: schema({
    command: stringProp('Shell command to run.', true),
    timeoutSeconds: numberProp('Timeout in seconds.', false),
  }, ['command']),
  async run(input, context) {
    const command = String(input.command ?? '')
    const readOnly = isReadOnlyShellCommand(command)
    const destructive = isDestructiveShellCommand(command)
    const tool = readOnly ? { ...shellTool, readOnly: true } : destructive ? { ...shellTool, destructive: true } : shellTool
    if (!await context.approve(tool, input)) return denied()
    const result = await execFileCapture(shellCommand(command), {
      cwd: context.cwd,
      timeoutMs: numberValue(input.timeoutSeconds, context.config.timeoutSeconds) * 1_000,
      signal: context.signal,
    })
    return { ok: result.exitCode === 0, data: result }
  },
}

const pharoInspectTool: AgentTool = {
  name: 'pharo_inspect',
  description: 'Inspect the configured Pharo image or a class name.',
  readOnly: true,
  inputSchema: schema({ target: stringProp('Class name to inspect. Omit for image overview.', false) }),
  async run(input, context) {
    return pharoResult(await inspectImage(context.config, optionalString(input.target), { signal: context.signal, cwd: context.cwd }))
  },
}

const pharoEvalTool: AgentTool = {
  name: 'pharo_eval',
  description: 'Evaluate Smalltalk code in the configured Pharo image.',
  readOnly: false,
  inputSchema: schema({ code: stringProp('Smalltalk code to evaluate.', true) }, ['code']),
  async run(input, context) {
    if (!await context.approve(pharoEvalTool, input)) return denied()
    return pharoResult(await evaluateSmalltalk(context.config, String(input.code ?? ''), { signal: context.signal, cwd: context.cwd }))
  },
}

const pharoScriptTool: AgentTool = {
  name: 'pharo_script',
  description: 'Run a Smalltalk .st script in the configured Pharo image.',
  readOnly: false,
  inputSchema: schema({ path: stringProp('Path to .st script.', true) }, ['path']),
  async run(input, context) {
    if (!await context.approve(pharoScriptTool, input)) return denied()
    const scriptPath = resolveInputPath(input.path, context)
    return pharoResult(await runPharoScriptFile(context.config, scriptPath, { signal: context.signal, cwd: context.cwd }))
  },
}

const pharoTestTool: AgentTool = {
  name: 'pharo_test',
  description: 'Run SUnit tests in the configured Pharo image.',
  readOnly: false,
  inputSchema: schema({
    package: stringProp('Package prefix to test.', false),
    className: stringProp('Test class name.', false),
    selector: stringProp('Single test selector.', false),
  }),
  async run(input, context) {
    if (!await context.approve(pharoTestTool, input)) return denied()
    return pharoResult(await runSUnit(context.config, {
      package: optionalString(input.package),
      className: optionalString(input.className),
      selector: optionalString(input.selector),
    }, { signal: context.signal, cwd: context.cwd }))
  },
}

const memoryReadTool: AgentTool = {
  name: 'memory_read',
  description: 'Read project memory used by the agent.',
  readOnly: true,
  inputSchema: schema({}),
  async run(_input, context) {
    return ok({ memory: await readMemory(context.config, context.cwd) })
  },
}

const memoryWriteTool: AgentTool = {
  name: 'memory_write',
  description: 'Append a durable note to project memory.',
  readOnly: false,
  inputSchema: schema({ text: stringProp('Memory note to append.', true) }, ['text']),
  async run(input, context) {
    if (!await context.approve(memoryWriteTool, input)) return denied()
    await appendMemory(context.config, String(input.text ?? ''), context.cwd)
    return ok({ written: true })
  },
}

const taskListTool: AgentTool = {
  name: 'task_list',
  description: 'Read the current workspace task list.',
  readOnly: true,
  inputSchema: schema({}),
  async run(_input, context) {
    return ok(await readTasks(context.cwd))
  },
}

const taskAddTool: AgentTool = {
  name: 'task_add',
  description: 'Add a task to the current workspace task list.',
  readOnly: false,
  inputSchema: schema({ content: stringProp('Task content.', true) }, ['content']),
  async run(input, context) {
    if (!await context.approve(taskAddTool, input)) return denied()
    return ok(await addTask(String(input.content ?? ''), context.cwd))
  },
}

const taskUpdateTool: AgentTool = {
  name: 'task_update',
  description: 'Update task content or status.',
  readOnly: false,
  inputSchema: schema({
    id: stringProp('Task id.', true),
    content: stringProp('New task content.', false),
    status: stringProp('pending, in_progress, completed, or blocked.', false),
  }, ['id']),
  async run(input, context) {
    if (!await context.approve(taskUpdateTool, input)) return denied()
    const status = optionalString(input.status)
    if (status && !['pending', 'in_progress', 'completed', 'blocked'].includes(status)) return fail(`Invalid task status: ${status}`)
    const updated = await updateTask(String(input.id), {
      content: optionalString(input.content),
      status: status as 'pending' | 'in_progress' | 'completed' | 'blocked' | undefined,
    }, context.cwd)
    return updated ? ok(updated) : fail(`Task not found: ${input.id}`)
  },
}

const taskClearCompletedTool: AgentTool = {
  name: 'task_clear_completed',
  description: 'Remove completed tasks from the current workspace task list.',
  readOnly: false,
  inputSchema: schema({}),
  async run(input, context) {
    if (!await context.approve(taskClearCompletedTool, input)) return denied()
    return ok({ removed: await clearCompletedTasks(context.cwd) })
  },
}

const webFetchTool: AgentTool = {
  name: 'web_fetch',
  description: 'Fetch a URL and return readable text or JSON.',
  readOnly: true,
  inputSchema: schema({
    url: stringProp('URL to fetch.', true),
    maxChars: numberProp('Maximum characters to return.', false),
  }, ['url']),
  async run(input, context) {
    return fetchUrl(String(input.url), { maxChars: numberValue(input.maxChars, 20_000), config: context.config })
  },
}

const webSearchTool: AgentTool = {
  name: 'web_search',
  description: 'Search the web and return a short result list.',
  readOnly: true,
  inputSchema: schema({
    query: stringProp('Search query.', true),
    maxResults: numberProp('Maximum results to return.', false),
  }, ['query']),
  async run(input) {
    return webSearch(String(input.query), { maxResults: numberValue(input.maxResults, 8) })
  },
}

const subagentTool: AgentTool = {
  name: 'agent',
  description: 'Run a focused subagent with the same local tools for exploration or verification.',
  readOnly: false,
  inputSchema: schema({
    prompt: stringProp('Focused subagent prompt.', true),
    readOnly: boolProp('Restrict the subagent to read-only permissions.', false),
  }, ['prompt']),
  async run(input, context) {
    const { PharoAgentLoop } = await import('./agent.ts')
    const config = input.readOnly ? { ...context.config, permissionMode: 'read-only' as const } : context.config
    const answer = await new PharoAgentLoop(config).run(String(input.prompt ?? ''), {
      cwd: context.cwd,
      signal: context.signal,
      verbose: false,
    })
    return ok({ answer })
  },
}

const mcpListToolsTool: AgentTool = {
  name: 'mcp_list_tools',
  description: 'List tools exposed by configured MCP stdio servers.',
  readOnly: true,
  inputSchema: schema({}),
  async run(_input, context) {
    return ok(await listMcpTools(context.config, context.cwd))
  },
}

const mcpCallToolTool: AgentTool = {
  name: 'mcp_call_tool',
  description: 'Call a tool on a configured MCP stdio server.',
  readOnly: false,
  inputSchema: schema({
    server: stringProp('MCP server name.', true),
    tool: stringProp('MCP tool name.', true),
    arguments: objectProp('Tool arguments.', false),
  }, ['server', 'tool']),
  async run(input, context) {
    if (!await context.approve(mcpCallToolTool, input)) return denied()
    return await callMcpTool(context.config, String(input.server), String(input.tool), objectValue(input.arguments), context.cwd)
  },
}

function ok(data: unknown): ToolResult {
  return { ok: true, data: data as ToolResult['data'] }
}

function fail(message: string): ToolResult {
  return { ok: false, data: { error: message } }
}

function denied(): ToolResult {
  return fail('Permission denied')
}

function pharoResult(result: { ok: boolean; stdout: string; stderr: string; exitCode: number; command: string[]; durationMs: number; timedOut: boolean }): ToolResult {
  return {
    ok: result.ok,
    data: result,
    summary: result.ok ? result.stdout.slice(0, 500) : `${result.stderr}\n${result.stdout}`.slice(0, 500),
  }
}

function resolveInputPath(value: unknown, context: ToolContext): string {
  return resolveWorkspacePath(typeof value === 'string' && value ? value : '.', context.cwd, context.config)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function schema(properties: Record<string, JsonObject>, required: string[] = []) {
  return { type: 'object' as const, properties, required, additionalProperties: false }
}

function stringProp(description: string, required: boolean): JsonObject {
  void required
  return { type: 'string', description }
}

function numberProp(description: string, required: boolean): JsonObject {
  void required
  return { type: 'number', description }
}

function boolProp(description: string, required: boolean): JsonObject {
  void required
  return { type: 'boolean', description }
}

function objectProp(description: string, required: boolean): JsonObject {
  void required
  return { type: 'object', description }
}

function globToRegex(pattern: string): RegExp {
  let output = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!
    const next = pattern[i + 1]
    if (char === '*' && next === '*') {
      output += '.*'
      i += 1
    } else if (char === '*') {
      output += '[^/]*'
    } else if (char === '?') {
      output += '.'
    } else {
      output += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  output += '$'
  return new RegExp(output)
}

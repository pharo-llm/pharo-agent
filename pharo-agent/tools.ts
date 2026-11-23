import path from 'node:path'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { AgentTool, JsonObject, ToolContext, ToolResult } from './types.ts'
import { compileMethod, defineClass, evaluateSmalltalk, findInImage, inspectImage, methodSource, resolveBackend, runSmalltalkFile, runSUnit } from './pharo.ts'
import type { FindKind, PharoEvalResult } from './pharo.ts'
import { liveSave, samePath } from './live.ts'
import { createImage, downloadVm, findImage, findTemplate, launcherLocations, listTemplates, resolveVm, versionLabel, vmVersionFor } from './launcher.ts'
import { imageStatuses, resolveImageRef, selectImage, startPharoImage, stopPharoImage } from './image-manager.ts'
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
    pharoFindTool,
    pharoSourceTool,
    pharoEvalTool,
    pharoDefineClassTool,
    pharoCompileTool,
    pharoTestTool,
    pharoScriptTool,
    pharoSaveTool,
    imageListTool,
    imageTemplatesTool,
    imageCreateTool,
    imageSelectTool,
    imageStartTool,
    imageStopTool,
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
  description: 'Overview of the Pharo image (version, package/class counts), of a package (its classes), or of a class (superclass, package, comment, variables, selectors, definition). Use pattern without target to list package names.',
  readOnly: true,
  inputSchema: schema({
    target: stringProp('Class or package name. Omit for an image overview.', false),
    pattern: stringProp('Substring filter for package names in the image overview.', false),
  }),
  async run(input, context) {
    return evalToolResult(await inspectImage(context.config, optionalString(input.target), { pattern: optionalString(input.pattern), signal: context.signal, cwd: context.cwd }))
  },
}

const pharoEvalTool: AgentTool = {
  name: 'pharo_eval',
  description: 'Evaluate Smalltalk in the Pharo image (the user\'s running image when live) and answer the printString of the last statement. Statements are separated by periods; declare temporaries with | a b |. Errors come back with the class, message, and stack.',
  readOnly: false,
  inputSchema: schema({
    code: stringProp('Smalltalk statements to evaluate, like a Playground "Print it".', true),
    ui: boolProp('Run in the UI process (needed to open windows or touch Morphic). Live only.', false),
  }, ['code']),
  async run(input, context) {
    if (!await context.approve(pharoEvalTool, input)) return denied()
    return evalToolResult(await evaluateSmalltalk(context.config, unescapeModelCode(String(input.code ?? '')), { ui: input.ui === true, signal: context.signal, cwd: context.cwd }))
  },
}

const pharoSourceTool: AgentTool = {
  name: 'pharo_source',
  description: 'Read source from the image: a method (className + selector) or, without selector, the class definition and comment.',
  readOnly: true,
  inputSchema: schema({
    className: stringProp('Class name, e.g. OrderedCollection.', true),
    selector: stringProp('Method selector, e.g. add: or printOn:. Omit for the class definition.', false),
    classSide: boolProp('Look on the class side (class methods).', false),
  }, ['className']),
  async run(input, context) {
    return evalToolResult(await methodSource(context.config, {
      className: String(input.className ?? ''),
      selector: optionalString(input.selector),
      classSide: input.classSide === true,
    }, { signal: context.signal, cwd: context.cwd }))
  },
}

const pharoFindTool: AgentTool = {
  name: 'pharo_find',
  description: 'Search the image: classes whose name contains query, implementors of a selector, senders of a selector, or references to a class/global.',
  readOnly: true,
  inputSchema: schema({
    kind: { type: 'string', enum: ['classes', 'implementors', 'senders', 'references'], description: 'What to search for.' },
    query: stringProp('Class name fragment, selector (e.g. at:put:), or global name.', true),
    limit: numberProp('Maximum results (default 100).', false),
  }, ['kind', 'query']),
  async run(input, context) {
    const kind = String(input.kind ?? 'classes') as FindKind
    if (!['classes', 'implementors', 'senders', 'references'].includes(kind)) return fail(`Invalid kind: ${kind}. Use classes, implementors, senders, or references.`)
    return evalToolResult(await findInImage(context.config, { kind, query: String(input.query ?? ''), limit: numberValue(input.limit, 100) }, { signal: context.signal, cwd: context.cwd }))
  },
}

const pharoDefineClassTool: AgentTool = {
  name: 'pharo_define_class',
  description: 'Create a class, or redefine one of the package\'s own classes (existing methods are kept). Refuses to replace a class that already exists in another package (e.g. Stack, Set): pick another name. Works on every Pharo version.',
  readOnly: false,
  inputSchema: schema({
    name: stringProp('Class name.', true),
    superclass: stringProp('Superclass name. Defaults to Object.', false),
    slots: { type: 'array', items: { type: 'string' }, description: 'Instance variable names.' },
    classVariables: { type: 'array', items: { type: 'string' }, description: 'Class (shared) variable names.' },
    package: stringProp('Package name, e.g. MyProject-Core.', true),
    tag: stringProp('Optional package tag.', false),
    comment: stringProp('Optional class comment.', false),
    replaceExisting: boolProp('Redefine a class that already exists in another package. Only when the user explicitly asks.', false),
  }, ['name', 'package']),
  async run(input, context) {
    if (!await context.approve(pharoDefineClassTool, input)) return denied()
    return evalToolResult(await defineClass(context.config, {
      name: String(input.name ?? ''),
      superclass: optionalString(input.superclass),
      slots: stringArray(input.slots),
      classVariables: stringArray(input.classVariables),
      package: String(input.package ?? ''),
      tag: optionalString(input.tag),
      comment: optionalString(input.comment),
      replaceExisting: input.replaceExisting === true,
    }, { signal: context.signal, cwd: context.cwd }), { changesImage: true })
  },
}

const pharoCompileTool: AgentTool = {
  name: 'pharo_compile',
  description: 'Compile (add or replace) one method in a class. source is the full method text starting with its selector line.',
  readOnly: false,
  inputSchema: schema({
    className: stringProp('Class to compile into.', true),
    source: stringProp('Full method source, e.g. "area\\n\\t^ width * height".', true),
    protocol: stringProp('Method protocol (category), e.g. accessing.', false),
    classSide: boolProp('Compile on the class side.', false),
  }, ['className', 'source']),
  async run(input, context) {
    if (!await context.approve(pharoCompileTool, input)) return denied()
    return evalToolResult(await compileMethod(context.config, {
      className: String(input.className ?? ''),
      source: unescapeModelCode(String(input.source ?? '')),
      protocol: optionalString(input.protocol),
      classSide: input.classSide === true,
    }, { signal: context.signal, cwd: context.cwd }), { changesImage: true })
  },
}

const pharoScriptTool: AgentTool = {
  name: 'pharo_script',
  description: 'File in a Smalltalk .st script (chunk format). Live: into the running image. Headless: in a throwaway image.',
  readOnly: false,
  inputSchema: schema({ path: stringProp('Path to .st script.', true) }, ['path']),
  async run(input, context) {
    if (!await context.approve(pharoScriptTool, input)) return denied()
    const scriptPath = resolveInputPath(input.path, context)
    const result = await runSmalltalkFile(context.config, scriptPath, { signal: context.signal, cwd: context.cwd })
    return 'backend' in result ? evalToolResult(result, { changesImage: true }) : pharoResult(result)
  },
}

const pharoTestTool: AgentTool = {
  name: 'pharo_test',
  description: 'Run SUnit tests by package prefix, test class, or single selector, and report failures and errors with their messages.',
  readOnly: false,
  inputSchema: schema({
    package: stringProp('Package prefix to test.', false),
    className: stringProp('Test class name.', false),
    selector: stringProp('Single test selector.', false),
  }),
  async run(input, context) {
    if (!await context.approve(pharoTestTool, input)) return denied()
    return evalToolResult(await runSUnit(context.config, {
      package: optionalString(input.package),
      className: optionalString(input.className),
      selector: optionalString(input.selector),
    }, { signal: context.signal, cwd: context.cwd }))
  },
}

const pharoSaveTool: AgentTool = {
  name: 'pharo_save',
  description: 'Save the live image to disk (like World menu > Save). Only when the user asks.',
  readOnly: false,
  inputSchema: schema({}),
  async run(input, context) {
    const resolved = await resolveBackend(context.config)
    if (resolved.backend !== 'live') return fail('No live image is connected; headless images are never saved.')
    if (!await context.approve(pharoSaveTool, input)) return denied()
    const saved = await liveSave(resolved.endpoint)
    return saved.ok ? ok({ backend: 'live', saved: true, image: saved.image ?? '' }) : fail(saved.error ?? 'Save failed')
  },
}

const imageListTool: AgentTool = {
  name: 'image_list',
  description: 'List the Pharo images (shared with Pharo Launcher): name, Pharo version, whether it runs and is live, and which one is selected. all: also search the whole machine.',
  readOnly: true,
  inputSchema: schema({ all: boolProp('Also list images outside Pharo Launcher (slower).', false) }),
  async run(input, context) {
    const statuses = await imageStatuses(context.config, { cwd: context.cwd, all: input.all === true })
    return ok({
      images: statuses.map(status => ({
        number: status.index,
        name: status.image.name,
        pharo: status.image.version ? versionLabel(status.image.version) : 'unknown',
        state: status.state,
        selected: status.selected,
        path: status.image.imagePath,
        template: status.image.template ?? null,
      })),
    })
  },
}

const imageTemplatesTool: AgentTool = {
  name: 'image_templates',
  description: 'List templates new images can be created from (official Pharo versions, Moose, ...). Use filter to narrow, e.g. "Pharo 14" or "Moose".',
  readOnly: true,
  inputSchema: schema({ filter: stringProp('Substring of the template or group name.', false) }),
  async run(input) {
    const filter = optionalString(input.filter)?.toLowerCase()
    const templates = (await listTemplates(await launcherLocations()))
      .filter(template => !filter || template.name.toLowerCase().includes(filter) || template.group.toLowerCase().includes(filter))
    return ok({ templates: templates.slice(0, 80).map(template => ({ name: template.name, group: template.group })), count: templates.length })
  },
}

const imageCreateTool: AgentTool = {
  name: 'image_create',
  description: 'Create a new Pharo image from a template (downloads it and its VM when needed). Does not start or select it.',
  readOnly: false,
  inputSchema: schema({
    name: stringProp('New image name.', true),
    template: stringProp('Exact template name from image_templates.', true),
  }, ['name', 'template']),
  async run(input, context) {
    if (!await context.approve(imageCreateTool, input)) return denied()
    const locations = await launcherLocations()
    const template = findTemplate(await listTemplates(locations), String(input.template ?? ''))
    const image = await createImage(locations, { name: String(input.name ?? ''), template })
    const vm = await resolveVm(locations, image)
    if (!vm.executable && vm.missingVersion) await downloadVm(locations, vmVersionFor(vm.missingVersion))
    return ok({ created: image.name, pharo: image.version ? versionLabel(image.version) : 'unknown', path: image.imagePath })
  },
}

const imageSelectTool: AgentTool = {
  name: 'image_select',
  description: 'Make an image the one all pharo_* tools work in (by number, name, or path). Start it with image_start to work live.',
  readOnly: false,
  inputSchema: schema({ image: stringProp('Image number, name, or .image path.', true) }, ['image']),
  async run(input, context) {
    if (!await context.approve(imageSelectTool, input)) return denied()
    const image = await resolveImageRef(String(input.image ?? ''), { cwd: context.cwd })
    await selectImage(context.config, image, { cwd: context.cwd })
    const [status] = (await imageStatuses(context.config, { cwd: context.cwd })).filter(entry => entry.selected)
    return ok({ selected: image.name, state: status?.state ?? 'stopped', pharo: image.version ? versionLabel(image.version) : 'unknown' })
  },
}

const imageStartTool: AgentTool = {
  name: 'image_start',
  description: 'Start an image with the agent server so pharo_* tools work live in it. Opens its window unless headless. Defaults to the selected image.',
  readOnly: false,
  inputSchema: schema({
    image: stringProp('Image number, name, or path. Defaults to the selected image.', false),
    headless: boolProp('Start without a window.', false),
  }),
  async run(input, context) {
    if (!await context.approve(imageStartTool, input)) return denied()
    const image = await imageFromInput(input.image, context)
    const started = await startPharoImage(image, { headless: input.headless === true })
    return ok({ started: image.name, url: started.url, alreadyRunning: Boolean(started.alreadyRunning), selected: Boolean(context.config.image && await samePath(context.config.image, image.imagePath)) })
  },
}

const imageStopTool: AgentTool = {
  name: 'image_stop',
  description: 'Quit a running image. Without save, unsaved changes are lost. Defaults to the selected image.',
  readOnly: false,
  destructive: true,
  inputSchema: schema({
    image: stringProp('Image number, name, or path. Defaults to the selected image.', false),
    save: boolProp('Save the image before quitting.', false),
  }),
  async run(input, context) {
    if (!await context.approve(imageStopTool, input)) return denied()
    const image = await imageFromInput(input.image, context)
    return ok({ image: image.name, ...await stopPharoImage(image, { save: input.save === true }) })
  },
}

async function imageFromInput(value: unknown, context: ToolContext) {
  const ref = optionalString(value)
  if (ref) return resolveImageRef(ref, { cwd: context.cwd })
  if (!context.config.image) throw new Error('No image selected: pass image, or call image_select first.')
  return findImage(await launcherLocations(), context.config.image, context.cwd)
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
    const parentEvents = context.onEvent
    const answer = await new PharoAgentLoop(config).run(String(input.prompt ?? ''), {
      cwd: context.cwd,
      signal: context.signal,
      verbose: false,
      prompt: context.prompt,
      onEvent: parentEvents ? event => parentEvents({ ...event, depth: (event.depth ?? 0) + 1 }) : undefined,
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

function evalToolResult(result: PharoEvalResult, options: { changesImage?: boolean } = {}): ToolResult {
  const data: Record<string, unknown> = {
    backend: result.backend,
    ok: result.ok,
  }
  // A failing test run is ok=false but still carries its report in result.
  if (result.result !== undefined) data.result = result.result
  if (result.ok && result.resultClass) data.resultClass = result.resultClass
  if (!result.ok && result.error) {
    data.error = result.error
    if (result.errorClass) data.errorClass = result.errorClass
    if (result.stack?.length) data.stack = result.stack.slice(0, 10)
  }
  if (result.warnings?.length) data.warnings = result.warnings
  if (result.output) data.output = result.output.slice(0, 4_000)
  if (options.changesImage && result.ok && result.backend === 'headless') {
    data.note = 'Headless mode: this change was made in a throwaway copy of the image and is already gone. Connect a live image (pharo-agent live start) to keep changes.'
  }
  data.durationMs = result.durationMs
  return {
    ok: result.ok,
    data: data as ToolResult['data'],
    summary: result.error && !result.ok ? result.error : (result.result ?? ''),
  }
}

/**
 * Small models sometimes double-escape code: "deposit: x\\n\\tbalance := x" arrives
 * with a literal backslash-n instead of a line break. When the text has no real
 * line break but has \\n or \\t outside Smalltalk string literals, unescape them.
 */
export function unescapeModelCode(code: string): string {
  if (code.includes('\n')) return code
  let outsideQuotes = ''
  let inString = false
  for (const char of code) {
    if (char === "'") inString = !inString
    else if (!inString) outsideQuotes += char
  }
  if (!/\\[nt]/.test(outsideQuotes)) return code
  let result = ''
  inString = false
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i]!
    if (char === "'") inString = !inString
    if (!inString && char === '\\' && (code[i + 1] === 'n' || code[i + 1] === 't')) {
      result += code[i + 1] === 'n' ? '\n' : '\t'
      i += 1
      continue
    }
    result += char
  }
  return result
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean)
  return []
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

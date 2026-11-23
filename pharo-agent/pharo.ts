import path from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AgentConfig } from './types.ts'
import { effectivePharoVm } from './config.ts'
import { execFileCapture, pathExists, resolvePath } from './platform.ts'
import type { ExecResult } from './platform.ts'
import { liveEndpoint, liveEval, liveHealth, LiveError, normalizeOutcome } from './live.ts'
import type { EvalOutcome, LiveEndpoint } from './live.ts'

export class PharoError extends Error {}

export type PharoBackend = 'live' | 'headless'

export type PharoRunResult = ExecResult & { ok: boolean }

export type PharoEvalResult = EvalOutcome & {
  backend: PharoBackend
  /** Where the code ran: the live server URL, or the image file for headless runs. */
  target: string
  /** Extra stdout/stderr printed by a headless VM, if any. */
  output?: string
  timedOut?: boolean
}

type RunOptions = { signal?: AbortSignal; cwd?: string; ui?: boolean }

// ---------------------------------------------------------------------------
// Backend selection

export type ResolvedBackend =
  | { backend: 'live'; endpoint: LiveEndpoint }
  | { backend: 'headless' }

/**
 * auto: use the running image when its live server answers, otherwise boot a
 * throwaway headless copy of the configured image.
 */
export async function resolveBackend(config: AgentConfig): Promise<ResolvedBackend> {
  const mode = config.pharoMode ?? 'auto'
  if (mode === 'headless') return { backend: 'headless' }
  const endpoint = await liveEndpoint(config)
  if (endpoint) {
    const health = await liveHealth(config)
    if (health?.ok) return { backend: 'live', endpoint }
    if (mode === 'live') throw new PharoError(`Live image not reachable at ${endpoint.url}: ${health?.error ?? 'no answer'}. Start it with \`pharo-agent live start\` or load the live server in your image (\`pharo-agent live snippet\`).`)
  } else if (mode === 'live') {
    throw new PharoError('No live image configured. Start one with `pharo-agent live start`, or load the live server into your open image (`pharo-agent live snippet`).')
  }
  return { backend: 'headless' }
}

/** Evaluate a Smalltalk doit (statements, optional `| temps |`) and answer the last value. */
export async function evaluate(config: AgentConfig, code: string, options: RunOptions = {}): Promise<PharoEvalResult> {
  const resolved = await resolveBackend(config)
  if (resolved.backend === 'live') {
    try {
      const outcome = await liveEval(resolved.endpoint, code, { timeoutMs: config.timeoutSeconds * 1_000, ui: options.ui, signal: options.signal })
      return { ...outcome, backend: 'live', target: resolved.endpoint.url }
    } catch (error) {
      if (error instanceof LiveError) return { ok: false, error: error.message, errorClass: 'LiveError', durationMs: 0, backend: 'live', target: resolved.endpoint.url }
      throw error
    }
  }
  const run = await runPharoScript(config, headlessEvalScript(code), options)
  const parsed = parseHeadlessOutcome(run.stdout)
  const output = [stripMarkers(run.stdout), run.stderr].map(text => text.trim()).filter(Boolean).join('\n')
  const target = config.image ? resolvePath(config.image, options.cwd) : '(no image)'
  if (parsed) return { ...parsed, durationMs: run.durationMs, backend: 'headless', target, output: output || undefined, timedOut: run.timedOut }
  return {
    ok: false,
    error: run.timedOut ? `Headless Pharo timed out after ${config.timeoutSeconds}s` : `Headless Pharo exited with code ${run.exitCode} without a result`,
    errorClass: run.timedOut ? 'Timeout' : 'VMError',
    durationMs: run.durationMs,
    backend: 'headless',
    target,
    output: output || undefined,
    timedOut: run.timedOut,
  }
}

// ---------------------------------------------------------------------------
// High level operations used by tools and CLI commands

export async function evaluateSmalltalk(config: AgentConfig, code: string, options: RunOptions = {}): Promise<PharoEvalResult> {
  return evaluate(config, code, options)
}

export async function inspectImage(config: AgentConfig, target?: string, options: RunOptions & { pattern?: string } = {}): Promise<PharoEvalResult> {
  return evaluate(config, inspectExpression(target, options.pattern), options)
}

export async function methodSource(config: AgentConfig, input: { className: string; selector?: string; classSide?: boolean }, options: RunOptions = {}): Promise<PharoEvalResult> {
  return evaluate(config, sourceExpression(input), options)
}

export async function compileMethod(config: AgentConfig, input: { className: string; source: string; protocol?: string; classSide?: boolean }, options: RunOptions = {}): Promise<PharoEvalResult> {
  return evaluate(config, compileExpression(input), options)
}

export async function defineClass(config: AgentConfig, input: ClassDefinition, options: RunOptions = {}): Promise<PharoEvalResult> {
  return evaluate(config, defineClassExpression(input), options)
}

export async function findInImage(config: AgentConfig, input: { kind: FindKind; query: string; limit?: number }, options: RunOptions = {}): Promise<PharoEvalResult> {
  return evaluate(config, findExpression(input), options)
}

export async function runSUnit(config: AgentConfig, input: { package?: string; className?: string; selector?: string }, options: RunOptions = {}): Promise<PharoEvalResult> {
  const result = await evaluate(config, testExpression(input), options)
  if (!result.ok || !result.result) return result
  const failures = Number(result.result.match(/^failures: (\d+)$/m)?.[1] ?? 0)
  const errors = Number(result.result.match(/^errors: (\d+)$/m)?.[1] ?? 0)
  return { ...result, ok: failures === 0 && errors === 0 }
}

/** Run a chunk-format .st file. Live: filed into the running image. Headless: `pharo image st file`. */
export async function runSmalltalkFile(config: AgentConfig, scriptPath: string, options: RunOptions = {}): Promise<PharoEvalResult | PharoRunResult> {
  const resolved = await resolveBackend(config)
  const script = resolvePath(scriptPath, options.cwd)
  if (!await pathExists(script)) throw new PharoError(`Smalltalk script does not exist: ${script}`)
  if (resolved.backend === 'live') {
    const contents = await readFile(script, 'utf8')
    return evaluate(config, `(Smalltalk at: #CodeImporter) evaluateString: ${stLiteral(contents)}`, options)
  }
  return runPharoScriptFile(config, script, options)
}

// ---------------------------------------------------------------------------
// Headless VM runner

export async function runPharoScriptFile(config: AgentConfig, scriptPath: string, options: { signal?: AbortSignal; cwd?: string } = {}): Promise<PharoRunResult> {
  const vm = await effectivePharoVm(config)
  if (!vm) throw new PharoError('No Pharo VM configured and no live image running. Set PHARO_VM, run `pharo-agent configure --pharo-vm /path/to/pharo`, or start a live image with `pharo-agent live start`.')
  if (!config.image) throw new PharoError('No Pharo image configured. Set PHARO_IMAGE or run `pharo-agent configure --image /path/to/Pharo.image`.')
  const image = resolvePath(config.image, options.cwd)
  if (!await pathExists(image)) throw new PharoError(`Configured Pharo image does not exist: ${image}`)
  const script = resolvePath(scriptPath, options.cwd)
  if (!await pathExists(script)) throw new PharoError(`Smalltalk script does not exist: ${script}`)
  const command = [vm, ...(config.headless ? ['--headless'] : []), image, 'st', script]
  const result = await execFileCapture(command, {
    cwd: options.cwd,
    timeoutMs: config.timeoutSeconds * 1_000,
    signal: options.signal,
  })
  return { ...result, ok: result.exitCode === 0 }
}

export async function runPharoScript(config: AgentConfig, script: string, options: { signal?: AbortSignal; cwd?: string } = {}): Promise<PharoRunResult> {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pharo-agent-'))
  try {
    const scriptPath = path.join(dir, 'script.st')
    await fs.writeFile(scriptPath, script, 'utf8')
    return await runPharoScriptFile(config, scriptPath, options)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const RESULT_BEGIN = '<<<PHARO-AGENT-RESULT'
const RESULT_END = 'PHARO-AGENT-RESULT>>>'

const exitSetup = `
pharoAgentExit := [ :status |
  (Smalltalk respondsTo: #exit:)
    ifTrue: [ Smalltalk perform: #exit: with: status ].
  Smalltalk snapshot: false andQuit: true ].
`

/**
 * Headless wrapper: evaluates `code` exactly like the live server does (same
 * compiler entry point, same error capture) and prints the outcome as JSON
 * between markers, so both backends produce identical results.
 */
export function headlessEvalScript(code: string): string {
  return chunkSafe(`| pharoAgentExit outcome warnings errorClasses isCompileProblem handleProblem describe display json |
${exitSetup}
${evalCoreSmalltalk}
outcome := [ | value d |
    value := Smalltalk compiler evaluate: ${stLiteral(code)}.
    d := Dictionary new.
    d at: 'ok' put: true; at: 'result' put: (display value: value); at: 'resultClass' put: value class name asString.
    d ]
  on: errorClasses , Warning
  do: [ :ex | handleProblem value: ex ].
outcome at: 'warnings' put: warnings asArray.
json := [ (Smalltalk at: #STONJSON) toString: outcome ] on: Error do: [ :e | '{"ok":false,"error":"could not encode result"}' ].
Stdio stdout nextPut: Character lf; nextPutAll: '${RESULT_BEGIN}'; nextPut: Character lf; nextPutAll: json; nextPut: Character lf; nextPutAll: '${RESULT_END}'; nextPut: Character lf; flush.
pharoAgentExit value: 0.
`)
}

/** Shared by the headless wrapper. Mirrors pharo-agent/smalltalk/live-server.st. */
const evalCoreSmalltalk = `
warnings := OrderedCollection new.
display := [ :value | | s |
  s := [ value displayString ] on: Error do: [ :e | [ value printString ] on: Error do: [ :e2 | '<unprintable>' ] ].
  s size > 50000 ifTrue: [ s := (s copyFrom: 1 to: 50000) , '... (truncated)' ].
  s ].
describe := [ :ex | | d ctx lines line n |
  d := Dictionary new.
  d at: 'ok' put: false;
    at: 'error' put: ([ ex description ] on: Error do: [ :e | ex class name asString ]);
    at: 'errorClass' put: ex class name asString.
  lines := OrderedCollection new.
  ctx := [ ex signalerContext ] on: Error do: [ :e | nil ].
  n := 0.
  [ ctx notNil and: [ n < 25 ] ] whileTrue: [
    line := [ ctx printString ] on: Error do: [ :e | '?' ].
    lines add: line.
    (line includesSubstring: 'DoIt') ifTrue: [ ctx := nil ] ifFalse: [ ctx := ctx sender ].
    n := n + 1 ].
  d at: 'stack' put: lines asArray.
  d ].
errorClasses := Error.
#( #SyntaxErrorNotification #OCSemanticWarning #AuthorNameRequest ) do: [ :name |
  Smalltalk at: name ifPresent: [ :cls | errorClasses := errorClasses , cls ] ].
isCompileProblem := [ :ex |
  (ex isKindOf: Error) or: [
    #( #SyntaxErrorNotification #OCSemanticWarning ) anySatisfy: [ :name |
      (Smalltalk at: name ifAbsent: [ nil ]) ifNil: [ false ] ifNotNil: [ :cls | ex isKindOf: cls ] ] ] ].
handleProblem := [ :ex |
  ex class name = #AuthorNameRequest
    ifTrue: [ ex resume: 'PharoAgent' ]
    ifFalse: [
      (isCompileProblem value: ex)
        ifTrue: [ describe value: ex ]
        ifFalse: [
          warnings add: ex class name asString , ': ' , ([ ex messageText asString ] on: Error do: [ :e | '' ]).
          ex resume ] ] ].
`

export function parseHeadlessOutcome(stdout: string): EvalOutcome | undefined {
  const start = stdout.lastIndexOf(RESULT_BEGIN)
  const end = stdout.lastIndexOf(RESULT_END)
  if (start < 0 || end < start) return undefined
  try {
    return normalizeOutcome(JSON.parse(stdout.slice(start + RESULT_BEGIN.length, end).trim()))
  } catch {
    return undefined
  }
}

function stripMarkers(stdout: string): string {
  const start = stdout.lastIndexOf(RESULT_BEGIN)
  const end = stdout.lastIndexOf(RESULT_END)
  if (start < 0 || end < start) return stdout
  return stdout.slice(0, start) + stdout.slice(end + RESULT_END.length)
}

/**
 * `pharo image st file` reads chunk format, where a single `!` ends a chunk.
 * Doubling every `!` keeps generated scripts as one chunk.
 */
export function chunkSafe(script: string): string {
  return script.replaceAll('!', '!!')
}

// ---------------------------------------------------------------------------
// Smalltalk expression builders. Each is a doit that answers a String or value.
// They only reach version-specific classes through `Smalltalk at:` so they
// compile on Pharo 10 through 14.

const organizer = `((Smalltalk respondsTo: #packageOrganizer) ifTrue: [ Smalltalk packageOrganizer ] ifFalse: [ (Smalltalk at: #RPackageOrganizer) default ])`
const definitionOf = (cls: string) => `((${cls} respondsTo: #definitionString) ifTrue: [ ${cls} definitionString ] ifFalse: [ ${cls} definition ])`
const lookupClass = (name: string) => `(Smalltalk globals at: ${stSymbol(name)} ifAbsent: [ nil ])`

export function inspectExpression(target?: string, pattern?: string): string {
  return `| data org cls pkg names pattern |
data := Dictionary new.
org := ${organizer}.
pattern := ${stLiteral(pattern)}.
${target === undefined ? `data at: 'pharo' put: SystemVersion current version.
data at: 'image' put: ([ Smalltalk imagePath ] on: Error do: [ :e | '' ]).
names := (org packages collect: [ :each | each name asString ]) asArray sorted.
data at: 'packageCount' put: names size.
data at: 'classCount' put: Smalltalk allClasses size.
data at: 'testCaseCount' put: ((Smalltalk at: #TestCase ifAbsent: [ nil ]) ifNil: [ 0 ] ifNotNil: [ :tc | tc allSubclasses size ]).
pattern
  ifNil: [ data at: 'hint' put: 'Pass pattern to list matching package names, or target to inspect a class or package.' ]
  ifNotNil: [
    names := names select: [ :each | each includesSubstring: pattern caseSensitive: false ].
    data at: 'packages' put: (names first: (names size min: 300)) ].` : `cls := ${lookupClass(target)}.
data at: 'target' put: ${stLiteral(target)}.
(cls notNil and: [ cls isBehavior ])
  ifTrue: [
    data at: 'kind' put: 'class';
      at: 'superclass' put: (cls superclass ifNil: [ 'nil' ] ifNotNil: [ :s | s name asString ]);
      at: 'package' put: ([ cls package name asString ] on: Error do: [ :e | '' ]);
      at: 'comment' put: (((cls comment ifNil: [ '' ]) asString) copyFrom: 1 to: ((cls comment ifNil: [ '' ]) size min: 1500));
      at: 'instanceVariables' put: (cls instVarNames collect: [ :each | each asString ]) asArray;
      at: 'classVariables' put: (cls classVarNames collect: [ :each | each asString ]) asArray;
      at: 'subclasses' put: ((cls subclasses collect: [ :each | each name asString ]) asArray sorted first: (cls subclasses size min: 50));
      at: 'instanceMethods' put: (cls selectors collect: [ :each | each asString ]) asArray sorted;
      at: 'classMethods' put: (cls class selectors collect: [ :each | each asString ]) asArray sorted;
      at: 'definition' put: ${definitionOf('cls')} ]
  ifFalse: [
    pkg := org packageNamed: ${stLiteral(target)} ifAbsent: [ nil ].
    pkg
      ifNotNil: [
        data at: 'kind' put: 'package';
          at: 'classes' put: (pkg definedClasses collect: [ :each | each name asString ]) asArray sorted ]
      ifNil: [
        names := (Smalltalk allClasses select: [ :each | each name includesSubstring: ${stLiteral(target)} caseSensitive: false ])
          collect: [ :each | each name asString ].
        data at: 'kind' put: 'missing';
          at: 'similarClasses' put: (names asArray sorted first: (names size min: 30)) ] ].`}
(Smalltalk at: #STONJSON) toString: data`
}

export function sourceExpression(input: { className: string; selector?: string; classSide?: boolean }): string {
  const cls = `cls := ${lookupClass(input.className)}.
cls ifNil: [ Error signal: ${stLiteral(`Class not found: ${input.className}`)} ].
${input.classSide ? 'cls := cls class.' : ''}`
  if (!input.selector) {
    return `| cls |
${cls}
${definitionOf('cls')} , String lf , String lf , '"' , ((cls instanceSide comment ifNil: [ 'no comment' ]) copyReplaceAll: '"' with: '''') , '"'`
  }
  return `| cls method |
${cls}
method := cls compiledMethodAt: ${stSymbol(input.selector)} ifAbsent: [ nil ].
method
  ifNotNil: [ method sourceCode ]
  ifNil: [
    method := cls lookupSelector: ${stSymbol(input.selector)}.
    method
      ifNil: [ Error signal: cls name , ' does not understand #' , ${stLiteral(input.selector)} ]
      ifNotNil: [ '"inherited from ' , method methodClass name , '"' , String lf , method sourceCode ] ]`
}

export function compileExpression(input: { className: string; source: string; protocol?: string; classSide?: boolean }): string {
  return `| cls selector |
cls := ${lookupClass(input.className)}.
cls ifNil: [ Error signal: ${stLiteral(`Class not found: ${input.className}. Define it first with pharo_define_class.`)} ].
${input.classSide ? 'cls := cls class.' : ''}
selector := cls compile: ${stLiteral(input.source)} classified: ${stLiteral(input.protocol || 'as yet unclassified')}.
selector ifNil: [ Error signal: 'Compilation failed' ].
'Compiled ' , cls name , '>>#' , selector`
}

export type ClassDefinition = {
  name: string
  superclass?: string
  slots?: string[]
  classVariables?: string[]
  package: string
  tag?: string
  comment?: string
}

export function defineClassExpression(input: ClassDefinition): string {
  // Literal arrays only hold literals: use quoted symbol literals (#'name').
  const symbols = (names: string[] = []) => `#( ${names.filter(Boolean).map(name => `#${stLiteral(name)}`).join(' ')} )`
  return `| superclass cls |
superclass := ${lookupClass(input.superclass || 'Object')}.
superclass ifNil: [ Error signal: ${stLiteral(`Superclass not found: ${input.superclass}`)} ].
cls := Smalltalk classInstaller make: [ :builder |
  builder
    superclass: superclass;
    name: ${stSymbol(input.name)};
    slots: ${symbols(input.slots)};
    sharedVariables: ${symbols(input.classVariables)}.
  ${input.tag
    ? `(builder respondsTo: #tag:)
    ifTrue: [ builder package: ${stLiteral(input.package)}; tag: ${stLiteral(input.tag)} ]
    ifFalse: [ builder package: ${stLiteral(`${input.package}-${input.tag}`)} ]`
    : `builder package: ${stLiteral(input.package)}`} ].
${input.comment ? `cls comment: ${stLiteral(input.comment)}.` : ''}
${definitionOf('cls')}`
}

export type FindKind = 'classes' | 'implementors' | 'senders' | 'references'

export function findExpression(input: { kind: FindKind; query: string; limit?: number }): string {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000))
  const query = stLiteral(input.query)
  const search: Record<FindKind, string> = {
    classes: `(Smalltalk allClasses select: [ :each | each name includesSubstring: ${query} caseSensitive: false ]) collect: [ :each | each name asString ]`,
    implementors: `(SystemNavigation default allImplementorsOf: ${stSymbol(input.query)}) collect: [ :each | each printString ]`,
    senders: `(SystemNavigation default allSendersOf: ${stSymbol(input.query)}) collect: [ :each | each printString ]`,
    references: `(Smalltalk globals bindingOf: ${stSymbol(input.query)})
  ifNil: [ Error signal: 'No global named ' , ${query} ]
  ifNotNil: [ :binding | (SystemNavigation default allReferencesTo: binding) collect: [ :each | each printString ] ]`,
  }
  if (!search[input.kind]) throw new PharoError(`Unknown find kind: ${input.kind}. Use classes, implementors, senders, or references.`)
  return `| found stream |
found := (${search[input.kind]}) asArray sorted.
stream := WriteStream on: String new.
stream nextPutAll: found size printString; nextPutAll: ' ${input.kind}'.
found size > ${limit} ifTrue: [ stream nextPutAll: ' (showing ${limit})' ].
(found first: (found size min: ${limit})) do: [ :each | stream nextPut: Character lf; nextPutAll: each ].
stream contents`
}

export function testExpression(input: { package?: string; className?: string; selector?: string }): string {
  return `| packageName className selector classes suite result failures errors stream testCase details |
packageName := ${stLiteral(input.package)}.
className := ${stLiteral(input.className)}.
selector := ${stLiteral(input.selector)}.
testCase := Smalltalk at: #TestCase ifAbsent: [ Error signal: 'SUnit (TestCase) is not loaded in this image' ].
classes := OrderedCollection new.
className
  ifNil: [
    classes addAll: (testCase allSubclasses reject: [ :each | each isAbstract ]).
    packageName ifNotNil: [
      classes := classes select: [ :each | | name |
        name := [ each package name asString ] on: Error do: [ :e | '' ].
        name = packageName or: [ name beginsWith: packageName ] ] ] ]
  ifNotNil: [
    | class |
    class := Smalltalk globals at: className asSymbol ifAbsent: [ nil ].
    class ifNil: [ Error signal: 'Test class not found: ' , className ] ifNotNil: [ classes add: class ] ].
(classes isEmpty and: [ packageName notNil ]) ifTrue: [ Error signal: 'No test classes found in package ' , packageName ].
suite := (Smalltalk at: #TestSuite) new.
classes do: [ :class |
  selector
    ifNil: [ suite addTest: class suite ]
    ifNotNil: [ suite addTest: (class selector: selector asSymbol) ] ].
result := suite run.
failures := result failures asArray.
errors := result errors asArray.
details := [ :test |
  [ test runCase. 'passed when re-run' ]
    on: Error , (Smalltalk at: #TestFailure)
    do: [ :ex | ex return: ([ ex description ] on: Error do: [ :e | ex class name ]) ] ].
stream := WriteStream on: String new.
stream
  nextPutAll: 'classes: '; print: classes size; nextPut: Character lf;
  nextPutAll: 'runs: '; print: result runCount; nextPut: Character lf;
  nextPutAll: 'passed: '; print: result passedCount; nextPut: Character lf;
  nextPutAll: 'failures: '; print: failures size; nextPut: Character lf;
  nextPutAll: 'errors: '; print: errors size.
(failures first: (failures size min: 20)) do: [ :each |
  stream nextPut: Character lf; nextPutAll: 'FAILURE '; print: each; nextPutAll: ' -- '; nextPutAll: (details value: each) ].
(errors first: (errors size min: 20)) do: [ :each |
  stream nextPut: Character lf; nextPutAll: 'ERROR '; print: each; nextPutAll: ' -- '; nextPutAll: (details value: each) ].
stream contents`
}

export function stLiteral(value?: string): string {
  return value === undefined || value === null ? 'nil' : `'${value.replaceAll("'", "''")}'`
}

function stSymbol(value: string): string {
  return `${stLiteral(value)} asSymbol`
}

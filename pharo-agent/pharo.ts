import path from 'node:path'
import type { AgentConfig } from './types.ts'
import { effectivePharoVm } from './config.ts'
import { execFileCapture, pathExists, resolvePath } from './platform.ts'
import type { ExecResult } from './platform.ts'

export class PharoError extends Error {}

export type PharoRunResult = ExecResult & { ok: boolean }

export async function runPharoScriptFile(config: AgentConfig, scriptPath: string, options: { signal?: AbortSignal; cwd?: string } = {}): Promise<PharoRunResult> {
  const vm = await effectivePharoVm(config)
  if (!vm) throw new PharoError('No Pharo VM configured. Set PHARO_VM or run `pharo-agent configure --pharo-vm /path/to/pharo`.')
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

export async function evaluateSmalltalk(config: AgentConfig, code: string, options: { signal?: AbortSignal; cwd?: string } = {}): Promise<PharoRunResult> {
  return runPharoScript(config, evalScript(code), options)
}

export async function runSUnit(config: AgentConfig, input: { package?: string; className?: string; selector?: string }, options: { signal?: AbortSignal; cwd?: string } = {}): Promise<PharoRunResult> {
  return runPharoScript(config, testScript(input), options)
}

export async function inspectImage(config: AgentConfig, target?: string, options: { signal?: AbortSignal; cwd?: string } = {}): Promise<PharoRunResult> {
  return runPharoScript(config, inspectScript(target), options)
}

const exitSetup = `
pharoAgentExit := [ :status |
  (Smalltalk respondsTo: #exit:)
    ifTrue: [ Smalltalk perform: #exit: with: status ].
  Smalltalk snapshot: false andQuit: true ].
`

export function evalScript(code: string): string {
  return `| pharoAgentExit |
${exitSetup}
[
[
${code}
] value.
pharoAgentExit value: 0.
] on: Error do: [ :ex |
  Stdio stderr nextPutAll: ex class name; nextPutAll: ': '; nextPutAll: ex messageText asString; cr.
  (ex signalerContext respondsTo: #shortDebugStackOn:)
    ifTrue: [ ex signalerContext shortDebugStackOn: Stdio stderr ].
  pharoAgentExit value: 1 ].
`
}

export function testScript(input: { package?: string; className?: string; selector?: string }): string {
  return `| pharoAgentExit packageName className selector classes suite result failures errors status testCaseClass testSuiteClass testResultClass |
${exitSetup}
packageName := ${stLiteral(input.package)}.
className := ${stLiteral(input.className)}.
selector := ${stLiteral(input.selector)}.
testCaseClass := Smalltalk at: #TestCase ifAbsent: [ Error signal: 'TestCase class not found in this image' ].
testSuiteClass := Smalltalk at: #TestSuite ifAbsent: [ Error signal: 'TestSuite class not found in this image' ].
testResultClass := Smalltalk at: #TestResult ifAbsent: [ Error signal: 'TestResult class not found in this image' ].
classes := OrderedCollection new.
[
  className
    ifNil: [
      classes addAll: (testCaseClass allSubclasses reject: [ :each | (each respondsTo: #isAbstract) and: [ each isAbstract ] ]).
      packageName ifNotNil: [
        classes := classes select: [ :each |
          | package |
          package := each package name.
          package = packageName or: [ package beginsWith: packageName ] ] ] ]
    ifNotNil: [
      | class |
      class := Smalltalk at: className asSymbol ifAbsent: [ nil ].
      class ifNil: [ Error signal: 'Test class not found: ', className ] ifNotNil: [ classes add: class ] ].
  suite := testSuiteClass new.
  classes do: [ :class |
    selector ifNil: [ suite addTest: class suite ] ifNotNil: [ suite addTest: (class selector: selector asSymbol) ] ].
  result := testResultClass new.
  suite run: result.
  failures := result failures.
  errors := result errors.
  status := (failures isEmpty and: [ errors isEmpty ]) ifTrue: [ 0 ] ifFalse: [ 1 ].
  Stdio stdout
    nextPutAll: 'Pharo Agent Test Report'; cr;
    nextPutAll: 'classes: '; nextPutAll: classes size asString; cr;
    nextPutAll: 'runs: '; nextPutAll: result runCount asString; cr;
    nextPutAll: 'failures: '; nextPutAll: failures size asString; cr;
    nextPutAll: 'errors: '; nextPutAll: errors size asString; cr.
  failures do: [ :failure | Stdio stdout nextPutAll: 'FAILURE '; nextPutAll: failure printString; cr ].
  errors do: [ :error | Stdio stdout nextPutAll: 'ERROR '; nextPutAll: error printString; cr ].
  pharoAgentExit value: status.
] on: Error do: [ :ex |
  Stdio stderr nextPutAll: ex class name; nextPutAll: ': '; nextPutAll: ex messageText asString; cr.
  pharoAgentExit value: 1 ].
`
}

export function inspectScript(target?: string): string {
  return `| pharoAgentExit target data organizerClass testCaseClass jsonClass packages json |
${exitSetup}
target := ${stLiteral(target)}.
data := Dictionary new.
[
  target
    ifNil: [
      data at: 'version' put: Smalltalk version.
      organizerClass := Smalltalk at: #RPackageOrganizer ifAbsent: [ nil ].
      packages := organizerClass
        ifNil: [ #() ]
        ifNotNil: [ ((organizerClass default packages collect: [ :pkg | pkg name ]) asArray sorted) ].
      testCaseClass := Smalltalk at: #TestCase ifAbsent: [ nil ].
      data at: 'packages' put: packages.
      data at: 'testCaseCount' put: (testCaseClass ifNil: [ 0 ] ifNotNil: [ testCaseClass allSubclasses size ]) ]
    ifNotNil: [
      | class |
      class := Smalltalk at: target asSymbol ifAbsent: [ nil ].
      class
        ifNil: [ data at: 'target' put: target. data at: 'found' put: false ]
        ifNotNil: [
          data at: 'target' put: target.
          data at: 'found' put: true.
          data at: 'package' put: class package name.
          data at: 'instanceMethods' put: ((class selectors collect: [ :selector | selector asString ]) asArray sorted).
          data at: 'classMethods' put: ((class class selectors collect: [ :selector | selector asString ]) asArray sorted) ] ].
  jsonClass := Smalltalk at: #STONJSON ifAbsent: [ nil ].
  json := jsonClass ifNil: [ data printString ] ifNotNil: [ jsonClass toString: data ].
  Stdio stdout nextPutAll: json; cr.
  pharoAgentExit value: 0.
] on: Error do: [ :ex |
  Stdio stderr nextPutAll: ex class name; nextPutAll: ': '; nextPutAll: ex messageText asString; cr.
  pharoAgentExit value: 1 ].
`
}

function stLiteral(value?: string): string {
  return value === undefined || value === null ? 'nil' : `'${value.replaceAll("'", "''")}'`
}

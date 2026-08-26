import test from 'node:test'
import assert from 'node:assert/strict'
import { evalScript, inspectScript, testScript } from '../pharo-agent/pharo.ts'

test('eval script embeds user code', () => {
  const script = evalScript("Transcript show: 'hello'; cr.")
  assert.match(script, /Transcript show: 'hello'; cr\./)
  assert.match(script, /pharoAgentExit value: 0/)
})

test('test script embeds SUnit filters', () => {
  const script = testScript({ package: 'Pkg', className: 'PkgTest', selector: 'testOne' })
  assert.match(script, /packageName := 'Pkg'\./)
  assert.match(script, /className := 'PkgTest'\./)
  assert.match(script, /selector := 'testOne'\./)
})

test('inspect script emits JSON', () => {
  assert.match(inspectScript('Object'), /Smalltalk at: #STONJSON/)
  assert.match(inspectScript('Object'), /Stdio stdout nextPutAll: json/)
})

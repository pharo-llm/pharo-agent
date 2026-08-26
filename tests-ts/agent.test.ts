import test from 'node:test'
import assert from 'node:assert/strict'
import { parseToolCalls } from '../pharo-agent/agent.ts'

test('parses single fallback tool call', () => {
  assert.deepEqual(parseToolCalls('{"tool":"pharo_inspect","arguments":{"target":"Object"}}'), [
    { id: undefined, name: 'pharo_inspect', arguments: { target: 'Object' } },
  ])
})

test('parses final shorthand', () => {
  assert.deepEqual(parseToolCalls('```json\n{"final":"done"}\n```'), [
    { name: 'final', arguments: { answer: 'done' } },
  ])
})

test('parses multiple tool calls', () => {
  assert.equal(parseToolCalls('{"tools":[{"tool":"list_dir","arguments":{}},{"tool":"memory_read","arguments":{}}]}').length, 2)
})

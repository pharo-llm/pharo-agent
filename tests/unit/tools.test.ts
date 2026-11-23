import test from 'node:test'
import assert from 'node:assert/strict'
import { builtInTools } from '../pharo-agent/tools.ts'

test('registers the expected local agent tool surface', () => {
  const names = builtInTools().map(tool => tool.name)
  assert.ok(names.length >= 20)
  for (const name of [
    'file_read',
    'file_write',
    'file_edit',
    'shell',
    'pharo_eval',
    'pharo_test',
    'memory_read',
    'task_add',
    'web_fetch',
    'web_search',
    'agent',
    'mcp_call_tool',
  ]) {
    assert.ok(names.includes(name), `${name} should be registered`)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { builtInTools } from '../../pharo-agent/tools.ts'

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

test('repairs double-escaped code from small models, but leaves string literals alone', async () => {
  const { unescapeModelCode } = await import('../../pharo-agent/tools.ts')
  assert.equal(unescapeModelCode('deposit: amount\\n\\tbalance := balance + amount'), 'deposit: amount\n\tbalance := balance + amount')
  assert.equal(unescapeModelCode("printIt\n\t^ 'a\\nb'"), "printIt\n\t^ 'a\\nb'")
  assert.equal(unescapeModelCode("pattern\\n\t^ 'x\\ty'"), "pattern\n\t^ 'x\\ty'")
  assert.equal(unescapeModelCode("^ 'only \\n in a string'"), "^ 'only \\n in a string'")
})

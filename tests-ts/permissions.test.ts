import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig } from '../pharo-agent/config.ts'
import { approveTool, isDestructiveShellCommand, isReadOnlyShellCommand } from '../pharo-agent/permissions.ts'

test('classifies shell command risk', () => {
  assert.equal(isReadOnlyShellCommand('git status --short'), true)
  assert.equal(isReadOnlyShellCommand('cat package.json'), true)
  assert.equal(isReadOnlyShellCommand('cat package.json > copy.json'), false)
  assert.equal(isDestructiveShellCommand('rm -rf build'), true)
  assert.equal(isDestructiveShellCommand('git reset --hard'), true)
  assert.equal(isDestructiveShellCommand('npm install'), true)
})

test('auto mode does not approve destructive tools without a tty prompt', async () => {
  const config = { ...defaultConfig(), permissionMode: 'auto' as const }
  assert.equal(await approveTool(config, {
    name: 'file_delete',
    description: 'delete',
    readOnly: false,
    destructive: true,
    inputSchema: { type: 'object', properties: {} },
  }, {}), false)
  assert.equal(await approveTool(config, {
    name: 'file_write',
    description: 'write',
    readOnly: false,
    inputSchema: { type: 'object', properties: {} },
  }, {}), true)
})

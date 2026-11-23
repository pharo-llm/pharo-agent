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

test('answering "a" allows a tool for the rest of the session, but never a destructive one', async () => {
  const config = defaultConfig()
  const write = { name: 'pharo_compile', description: 'compile', readOnly: false, inputSchema: { type: 'object' as const, properties: {} } }
  const destructive = { ...write, name: 'file_delete', destructive: true }
  const sessionAllowed = new Set<string>()
  const questions: string[] = []
  const prompt = async (question: string) => {
    questions.push(question)
    return 'a'
  }
  assert.equal(await approveTool(config, write, {}, { prompt, sessionAllowed }), true)
  assert.equal(await approveTool(config, write, {}, { prompt, sessionAllowed }), true)
  assert.equal(questions.length, 1)
  assert.equal(await approveTool(config, destructive, {}, { prompt, sessionAllowed }), false)
})

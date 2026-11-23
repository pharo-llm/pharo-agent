import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { defaultConfig } from '../pharo-agent/config.ts'
import { assertUrlAllowed, isInsideWorkspace, isPrivateOrLocalHost, resolveWorkspacePath, SafetyError } from '../pharo-agent/safety.ts'

test('keeps model file tools inside the workspace by default', () => {
  const cwd = path.resolve('/tmp/project')
  assert.equal(isInsideWorkspace(path.join(cwd, 'README.md'), cwd), true)
  assert.equal(isInsideWorkspace('/tmp/other/README.md', cwd), false)
  assert.throws(() => resolveWorkspacePath('../secret.txt', cwd, defaultConfig()), SafetyError)
})

test('allows outside workspace paths only when configured', () => {
  const config = { ...defaultConfig(), allowOutsideWorkspace: true }
  assert.equal(resolveWorkspacePath('../secret.txt', '/tmp/project', config), '/tmp/secret.txt')
})

test('blocks private network web fetch targets by default', () => {
  assert.equal(isPrivateOrLocalHost('localhost'), true)
  assert.equal(isPrivateOrLocalHost('127.0.0.1'), true)
  assert.equal(isPrivateOrLocalHost('192.168.1.10'), true)
  assert.equal(isPrivateOrLocalHost('example.com'), false)
  assert.throws(() => assertUrlAllowed('http://127.0.0.1:8080', defaultConfig()), SafetyError)
  assert.equal(assertUrlAllowed('https://example.com', defaultConfig()).hostname, 'example.com')
})

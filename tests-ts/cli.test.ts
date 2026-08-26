import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('bare pharo-agent opens interactive chat and exits on slash command', () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'pharo-agent-cli-'))
  try {
    const result = spawnSync(process.execPath, ['pharo-agent/cli.ts'], {
      input: '/exit\n',
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: state },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Ask a question/)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

test('chat slash help works with piped input', () => {
  const state = mkdtempSync(path.join(os.tmpdir(), 'pharo-agent-cli-'))
  try {
    const result = spawnSync(process.execPath, ['pharo-agent/cli.ts', 'chat'], {
      input: '/help\n/exit\n',
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: state },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Chat commands:/)
    assert.match(result.stdout, /\/resume <id>/)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})

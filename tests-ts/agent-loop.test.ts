import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig } from '../pharo-agent/config.ts'
import { PharoAgentLoop } from '../pharo-agent/agent.ts'

test('runTurn carries chat history across prompts', async () => {
  const bodies: { messages?: { role?: string }[] }[] = []
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-loop-'))
  try {
    const loop = new PharoAgentLoop(defaultConfig(), [], {
      async models() {
        return ['fake-model']
      },
      async chat(options) {
        bodies.push({ messages: options.messages })
        const userCount = options.messages.filter(message => message.role === 'user').length
        return { content: `users:${userCount}`, toolCalls: [], raw: {} }
      },
    })
    const first = await loop.runTurn('hello', { cwd })
    assert.equal(first.answer, 'users:1')
    const second = await loop.runTurn('again', { cwd, resumeMessages: first.messages })
    assert.equal(second.answer, 'users:2')
    assert.equal(bodies.length, 2)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

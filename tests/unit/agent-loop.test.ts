import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig } from '../pharo-agent/config.ts'
import { AgentInterrupted, PharoAgentLoop } from '../pharo-agent/agent.ts'

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

test('runTurn reports tool activity as events', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-loop-'))
  try {
    let calls = 0
    const echo = {
      name: 'echo',
      description: 'Echo input',
      readOnly: true,
      inputSchema: { type: 'object' as const, properties: {} },
      async run(input: Record<string, unknown>) {
        return { ok: true, data: { said: String(input.text) } }
      },
    }
    const loop = new PharoAgentLoop(defaultConfig(), [echo], {
      async models() {
        return ['fake-model']
      },
      async chat() {
        calls += 1
        if (calls === 1) return { content: 'Checking first.', toolCalls: [{ name: 'echo', arguments: { text: 'hi' } }], raw: {} }
        return { content: 'done', toolCalls: [], raw: {} }
      },
    })
    const events: string[] = []
    const result = await loop.runTurn('go', { cwd, onEvent: event => events.push(event.type) })
    assert.equal(result.answer, 'done')
    assert.deepEqual(events, ['model_start', 'model_end', 'assistant_text', 'tool_start', 'tool_end', 'model_start', 'model_end'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('aborting the signal interrupts the turn', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-loop-'))
  try {
    const controller = new AbortController()
    const loop = new PharoAgentLoop(defaultConfig(), [], {
      async models() {
        return ['fake-model']
      },
      chat(options) {
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          setTimeout(() => controller.abort(), 10)
        })
      },
    })
    await assert.rejects(loop.runTurn('go', { cwd, signal: controller.signal }), AgentInterrupted)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

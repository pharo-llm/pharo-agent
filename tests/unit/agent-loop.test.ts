import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig } from '../../pharo-agent/config.ts'
import { AgentInterrupted, PharoAgentLoop } from '../../pharo-agent/agent.ts'

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

test('an empty reply mid-task makes the agent continue instead of stopping', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-loop-'))
  try {
    const replies = ['', '<think>hmm</think>', 'All done.']
    const sent: string[] = []
    const loop = new PharoAgentLoop(defaultConfig(), [], {
      async models() {
        return ['fake-model']
      },
      async chat(options) {
        sent.push(String(options.messages.at(-1)?.content))
        return { content: replies.shift()!, toolCalls: [], raw: {} }
      },
    })
    const result = await loop.runTurn('go', { cwd })
    assert.equal(result.answer, 'All done.')
    assert.equal(sent.length, 3)
    assert.match(sent[1]!, /last reply was empty/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

const echoTool = {
  name: 'echo',
  description: 'Echo input',
  readOnly: true,
  inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
  async run(input: Record<string, unknown>) {
    return { ok: true, data: { said: String(input.text) } }
  },
}

test('a call written as text runs and is kept in native shape', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-loop-'))
  try {
    let calls = 0
    const ran: unknown[] = []
    const tool = { ...echoTool, async run(input: Record<string, unknown>) { ran.push(input); return { ok: true, data: { said: String(input.text) } } } }
    const loop = new PharoAgentLoop(defaultConfig(), [tool], {
      async models() {
        return ['fake-model']
      },
      async chat() {
        calls += 1
        if (calls === 1) return { content: 'Here you go:\n```json\n{"function": "echo", "arguments": {"text": "hi"}}\n```', toolCalls: [], raw: {} }
        return { content: 'done', toolCalls: [], raw: {} }
      },
    })
    const result = await loop.runTurn('go', { cwd })
    assert.equal(result.answer, 'done')
    assert.deepEqual(ran, [{ text: 'hi' }])
    const assistant = result.messages.find(message => message.tool_calls)!
    assert.equal(assistant.content, '')
    assert.equal(assistant.tool_calls![0]!.function.name, 'echo')
    const toolMessage = result.messages.find(message => message.role === 'tool')!
    assert.equal(toolMessage.tool_call_id, assistant.tool_calls![0]!.id)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('an unreadable tool call is sent back for a retry, not shown as the answer', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-loop-'))
  try {
    const seen: string[] = []
    let calls = 0
    const loop = new PharoAgentLoop(defaultConfig(), [echoTool], {
      async models() {
        return ['fake-model']
      },
      async chat(options) {
        calls += 1
        seen.push(options.messages.at(-1)!.content)
        if (calls === 1) return { content: '{"name": "echo", "arguments": {"text": "a" "b"}}', toolCalls: [], raw: {} }
        if (calls === 2) return { content: '{"name": "echo", "arguments": {"text": "ab"}}', toolCalls: [], raw: {} }
        return { content: 'done', toolCalls: [], raw: {} }
      },
    })
    const result = await loop.runTurn('go', { cwd })
    assert.equal(result.answer, 'done')
    assert.match(seen[1]!, /tried to call a tool.*echo is not valid JSON/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a repeated read-only call is not run again until something changes', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-loop-'))
  try {
    let runs = 0
    let calls = 0
    const tool = { ...echoTool, async run() { runs += 1; return { ok: true, data: {} } } }
    const loop = new PharoAgentLoop(defaultConfig(), [tool], {
      async models() {
        return ['fake-model']
      },
      async chat() {
        calls += 1
        if (calls <= 2) return { content: '', toolCalls: [{ name: 'echo', arguments: { text: 'same' } }], raw: {} }
        return { content: 'done', toolCalls: [], raw: {} }
      },
    })
    const result = await loop.runTurn('go', { cwd })
    assert.equal(runs, 1)
    assert.match(result.messages.filter(message => message.role === 'tool').at(-1)!.content, /already called echo/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

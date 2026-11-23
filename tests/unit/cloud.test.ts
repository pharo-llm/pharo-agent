import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpenAICompatibleClient, LlmError } from '../../pharo-agent/llm.ts'
import { cloudHeaders, machineFingerprint, resetIn, usageSummary } from '../../pharo-agent/cloud.ts'
import { defaultConfig } from '../../pharo-agent/config.ts'

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const instance = http.createServer(handler)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}/v1`, close: () => instance.close() }
}

test('Pharo Cloud limit messages reach the user as written', async () => {
  const fake = await server((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'session_limit', message: 'You reached your 5-hour usage limit (300,000 tokens). It resets in 2h 10m.' } }))
  })
  try {
    const client = new OpenAICompatibleClient(fake.url, undefined, 5_000)
    await assert.rejects(client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.status, 429)
      assert.equal(error.message, 'You reached your 5-hour usage limit (300,000 tokens). It resets in 2h 10m.')
      return true
    })
  } finally {
    fake.close()
  }
})

test('re-registers once when the cloud no longer knows this machine', async () => {
  const seen: string[] = []
  const fake = await server((req, res) => {
    const id = String(req.headers['x-pharo-client-id'])
    seen.push(id)
    if (id === 'pcl_old') return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'unregistered', message: 'Unknown client id' } }))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))
  })
  try {
    const client = new OpenAICompatibleClient(fake.url, undefined, 5_000, { headers: { 'x-pharo-client-id': 'pcl_old' }, reregister: async () => ({ 'x-pharo-client-id': 'pcl_new' }) })
    const response = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.content, 'ok')
    assert.deepEqual(response.usage, { promptTokens: 3, completionTokens: 2 })
    assert.deepEqual(seen, ['pcl_old', 'pcl_new'])
  } finally {
    fake.close()
  }
})

test('the machine fingerprint is a stable SHA-256, never the raw id', async () => {
  const first = await machineFingerprint()
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(await machineFingerprint(), first)
})

test('only cloud requests carry the client id', () => {
  const cloud = { ...defaultConfig(), cloudUrl: 'https://cloud.example', cloudClientId: 'pcl_1', baseUrl: 'https://cloud.example/v1' }
  assert.deepEqual(cloudHeaders(cloud), { 'x-pharo-client-id': 'pcl_1' })
  assert.deepEqual(cloudHeaders({ ...cloud, baseUrl: 'http://127.0.0.1:11434/v1' }), {})
})

test('usage summaries and reset times read naturally', () => {
  const usage = { clientId: 'x', plan: 'standard', planLabel: 'Standard', status: 'active' as const, session: { used: 30_000, limit: 300_000, resetsAt: null, hours: 5, active: true }, week: { used: 300_000, limit: 3_000_000, resetsAt: null }, minute: { used: 0, limit: 30 }, concurrent: { used: 0, limit: 2 }, maxTokensPerRequest: 4096 }
  assert.equal(usageSummary(usage), '10% of 5h session · 10% of week')
  assert.equal(resetIn(new Date(Date.now() + 2.5 * 3_600_000).toISOString()), 'resets in 2h 30m')
  assert.equal(resetIn(null), 'starts with your next request')
})

test('falls back to the JSON tool protocol when a model has no native tools', async () => {
  const bodies: { tools?: unknown }[] = []
  const fake = await server(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw) as { tools?: unknown }
    bodies.push(body)
    if (body.tools) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'registry.ollama.ai/x does not support tools' } }))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '{"tool":"final","arguments":{"answer":"ok"}}' } }] }))
  })
  try {
    const client = new OpenAICompatibleClient(fake.url, undefined, 5_000)
    const tools = [{ name: 't', description: 'd', readOnly: true, inputSchema: { type: 'object' as const, properties: {} } }]
    const messages = [{ role: 'user' as const, content: 'hi' }]
    assert.match((await client.chat({ model: 'm', messages, tools })).content, /final/)
    await client.chat({ model: 'm', messages, tools })
    assert.deepEqual(bodies.map(body => Boolean(body.tools)), [true, false, false], 'the second call skips native tools right away')
  } finally {
    fake.close()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'

const baseUrl = process.env.PHARO_AGENT_E2E_BASE_URL

test('talks to an OpenAI-compatible model server when configured', { skip: baseUrl ? false : 'Set PHARO_AGENT_E2E_BASE_URL to run this E2E test.' }, async () => {
  const response = await fetch(`${baseUrl!.replace(/\/$/, '')}/models`)
  assert.equal(response.ok, true)
  const json = await response.json() as { data?: unknown[] }
  assert.equal(Array.isArray(json.data), true)
})

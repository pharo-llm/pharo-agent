import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig } from '../pharo-agent/config.ts'
import { buildLlamaCommand } from '../pharo-agent/llama.ts'

test('print command can be built on CI without llama-server installed', async () => {
  const previousPath = process.env.PATH
  process.env.PATH = ''
  try {
    const command = await buildLlamaCommand(defaultConfig(), {
      hfRef: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf',
      allowMissingServer: true,
    })
    assert.deepEqual(command, [
      'llama-server',
      '-hf',
      'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf',
      '--port',
      '8080',
    ])
  } finally {
    process.env.PATH = previousPath
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { choosePreferred, resolveModelRef, splitGgufFilename, type GgufFile } from '../pharo-agent/hf.ts'
import { defaultConfig } from '../pharo-agent/config.ts'

test('prefers Q4_K_M GGUF', () => {
  const files: GgufFile[] = [
    { repoId: 'org/repo', filename: 'model.Q8_0.gguf' },
    { repoId: 'org/repo', filename: 'model.Q4_K_M.gguf' },
  ]
  assert.equal(choosePreferred(files).filename, 'model.Q4_K_M.gguf')
})

test('resolves repo selector', () => {
  assert.deepEqual(resolveModelRef('org/repo:Q5_K_M', 'default/repo'), { repoId: 'org/repo', selector: 'Q5_K_M' })
})

test('resolves filename against default repo', () => {
  assert.deepEqual(resolveModelRef('model.gguf', 'default/repo'), { repoId: 'default/repo', selector: 'model.gguf' })
})

test('parses split GGUF shard names', () => {
  assert.deepEqual(splitGgufFilename('qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf'), {
    prefix: 'qwen2.5-coder-7b-instruct-q4_0-',
    index: 1,
    indexWidth: 5,
    total: 2,
    totalText: '00002',
  })
})

test('defaults to the selected Qwen split model', () => {
  const config = defaultConfig()
  assert.equal(config.modelRepo, 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF')
  assert.equal(config.publishRepo, 'pharo-llm/pharo-agent')
  assert.equal(config.modelFile, 'qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf')
})

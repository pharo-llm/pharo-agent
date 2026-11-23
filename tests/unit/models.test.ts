import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { builtInModelPresets, findModelPreset, loadModelPresets, modelReference, modelShardFiles } from '../pharo-agent/models.ts'

test('exposes qwen-coder-7b as a friendly built-in model name', () => {
  const preset = findModelPreset('qwen-coder-7b', builtInModelPresets)
  assert.equal(preset?.name, 'Qwen Coder 7B')
  assert.equal(modelReference(preset!), 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf')
  assert.deepEqual(modelShardFiles(preset!).map(file => file.filename), [
    'qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf',
    'qwen2.5-coder-7b-instruct-q4_0-00002-of-00002.gguf',
  ])
})

test('loads shipped model presets from the bundled registry', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-no-project-models-'))
  try {
    const presets = await loadModelPresets(cwd)
    const preset = findModelPreset('qwen-coder-7b', presets)
    assert.equal(preset?.repoId, 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('loads future predefined model names from project registry', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-models-'))
  try {
    await writeFile(path.join(cwd, '.pharo-agent.models.json'), JSON.stringify({
      models: [{
        id: 'future-pharo',
        name: 'Future Pharo',
        repoId: 'pharo-llm/future-pharo',
        filename: 'future-pharo.Q4_K_M.gguf',
        aliases: ['fp'],
      }],
    }), 'utf8')

    const presets = await loadModelPresets(cwd)
    assert.equal(findModelPreset('future-pharo', presets)?.repoId, 'pharo-llm/future-pharo')
    assert.equal(findModelPreset('fp', presets)?.filename, 'future-pharo.Q4_K_M.gguf')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

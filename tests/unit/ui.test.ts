import test from 'node:test'
import assert from 'node:assert/strict'
import { bannerLines, formatToolEnd, formatToolStart, logoLines } from '../pharo-agent/ui.ts'

// Tests run without a TTY, so output is uncolored.
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

test('banner shows the logo next to version, model, Pharo backend, and workspace', () => {
  const lines = bannerLines({
    version: '1.2.3',
    model: 'qwen-coder-7b',
    modelStatus: 'ready',
    modelUrl: 'http://127.0.0.1:8080/v1',
    pharo: { kind: 'live', name: 'My image', version: 'Pharo 14.0', detail: '127.0.0.1:4044' },
    cwd: '/tmp/project',
    permissionMode: 'ask',
  }).map(plain)
  assert.equal(lines.length, logoLines().length)
  assert.match(lines[0]!, /Pharo Agent v1\.2\.3/)
  assert.match(lines[1]!, /qwen-coder-7b/)
  assert.match(lines[2]!, /My image · Pharo 14\.0 · ● live 127\.0\.0\.1:4044/)
  assert.match(lines[3]!, /\/tmp\/project/)
})

test('pharo_eval calls show the Smalltalk being run and the result', () => {
  const call = { name: 'pharo_eval', arguments: { code: '| a |\na := 3.\na factorial' } }
  const start = plain(formatToolStart(call))
  assert.match(start, /● Pharo eval/)
  assert.match(start, /│ a := 3\./)
  const end = plain(formatToolEnd(call, { ok: true, data: { backend: 'live', ok: true, result: '6' } }, 4, { verbose: false }))
  assert.match(end, /⎿ {2}6 {2}live · 4ms/)
})

test('long results are previewed until /verbose', () => {
  const call = { name: 'shell', arguments: { command: 'seq 30' } }
  const result = { ok: true, data: { stdout: Array.from({ length: 30 }, (_, i) => String(i)).join('\n'), stderr: '', exitCode: 0 } }
  assert.match(plain(formatToolEnd(call, result, 10, { verbose: false })), /\+22 lines/)
  assert.doesNotMatch(plain(formatToolEnd(call, result, 10, { verbose: true })), /lines \(\/verbose/)
})

test('failed Pharo calls show the error class and stack', () => {
  const call = { name: 'pharo_eval', arguments: { code: '1/0' } }
  const end = plain(formatToolEnd(call, { ok: false, data: { backend: 'headless', ok: false, error: 'ZeroDivide', errorClass: 'ZeroDivide', stack: ['SmallInteger>>/', 'UndefinedObject>>DoIt'] } }, 180, { verbose: false }))
  assert.match(end, /ZeroDivide/)
  assert.match(end, /SmallInteger>>\//)
  assert.match(end, /headless · 180ms/)
})

test('compile headers name the method being compiled', async () => {
  const { selectorFromSource } = await import('../pharo-agent/ui.ts')
  assert.equal(selectorFromSource('increment\n\tcount := count + 1'), 'increment')
  assert.equal(selectorFromSource('at: index put: value\n\t^ value'), 'at:put:')
  assert.equal(selectorFromSource('+ other\n\t^ self'), '+')
  const start = plain(formatToolStart({ name: 'pharo_compile', arguments: { className: 'Counter', source: 'at: i put: v\n\t^ v', protocol: 'accessing' } }))
  assert.match(start, /Pharo compile\(Counter>>#at:put: · accessing\)/)
})

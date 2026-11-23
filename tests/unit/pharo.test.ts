import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { defaultConfig } from '../pharo-agent/config.ts'
import {
  chunkSafe,
  compileExpression,
  defineClassExpression,
  evaluate,
  findExpression,
  headlessEvalScript,
  inspectExpression,
  parseHeadlessOutcome,
  resolveBackend,
  runSUnit,
  testExpression,
} from '../pharo-agent/pharo.ts'

test('headless eval script embeds code as a string literal and stays one chunk', () => {
  const script = headlessEvalScript("Transcript show: 'hello!'; cr.")
  assert.match(script, /Smalltalk compiler evaluate: 'Transcript show: ''hello!!''; cr\.'/)
  assert.match(script, /pharoAgentExit value: 0/)
  assert.doesNotMatch(script.replaceAll('!!', ''), /!/)
})

test('chunkSafe doubles every exclamation mark', () => {
  assert.equal(chunkSafe("'a!' , 'b!!'"), "'a!!' , 'b!!!!'")
})

test('parses the JSON outcome printed between markers', () => {
  const stdout = 'noise\n<<<PHARO-AGENT-RESULT\n{"ok":true,"result":"line1\\rline2","resultClass":"ByteString","warnings":[]}\nPHARO-AGENT-RESULT>>>\n'
  const outcome = parseHeadlessOutcome(stdout)
  assert.equal(outcome?.ok, true)
  assert.equal(outcome?.result, 'line1\nline2')
  assert.equal(parseHeadlessOutcome('no markers'), undefined)
})

test('test expression embeds SUnit filters', () => {
  const script = testExpression({ package: 'Pkg', className: 'PkgTest', selector: 'testOne' })
  assert.match(script, /packageName := 'Pkg'\./)
  assert.match(script, /className := 'PkgTest'\./)
  assert.match(script, /selector := 'testOne'\./)
})

test('inspect expression answers JSON and avoids version-specific globals', () => {
  const script = inspectExpression('Object')
  assert.match(script, /Smalltalk at: #STONJSON/)
  // Pharo 12+ removed RPackageOrganizer: only reach it through Smalltalk at:.
  assert.doesNotMatch(script, /[\s[]RPackageOrganizer\b/)
  assert.match(inspectExpression(undefined, 'Zinc'), /pattern := 'Zinc'/)
})

test('class definitions use literal symbols and the class installer', () => {
  const script = defineClassExpression({ name: 'Shape', slots: ['width', 'height'], classVariables: ['Count'], package: 'Demo', tag: 'Core' })
  assert.match(script, /slots: #\( #'width' #'height' \)/)
  assert.match(script, /sharedVariables: #\( #'Count' \)/)
  assert.match(script, /Smalltalk classInstaller make:/)
  assert.match(script, /builder package: 'Demo-Core'/)
})

test('compile and find expressions quote their inputs', () => {
  assert.match(compileExpression({ className: 'Shape', source: "name ^ 'it''s'", protocol: 'accessing' }), /compile: 'name \^ ''it''''s''' classified: 'accessing'/)
  assert.match(findExpression({ kind: 'senders', query: 'at:put:' }), /allSendersOf: 'at:put:' asSymbol/)
})

async function withFakeLiveServer(handler: (body: { code?: string }, url: string) => unknown, run: (config: ReturnType<typeof defaultConfig>) => Promise<void>): Promise<void> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      requests.push(req.url ?? '')
      if (req.headers['x-pharo-agent-token'] !== 'secret') {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"ok":false,"error":"bad token"}')
        return
      }
      const payload = req.url === '/health' ? { ok: true, pharo: 'Pharo14.0.0', image: '/tmp/Fake.image' } : handler(JSON.parse(body || '{}'), req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-live-'))
  try {
    const port = (server.address() as AddressInfo).port
    const liveFile = path.join(dir, 'live.json')
    await writeFile(liveFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'secret' }))
    await run({ ...defaultConfig(), liveFile })
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('auto mode uses the live image when it answers', async () => {
  await withFakeLiveServer(body => ({ ok: true, result: `got ${body.code}`, resultClass: 'ByteString', durationMs: 1 }), async config => {
    const backend = await resolveBackend(config)
    assert.equal(backend.backend, 'live')
    const result = await evaluate(config, '3 factorial')
    assert.equal(result.backend, 'live')
    assert.equal(result.ok, true)
    assert.equal(result.result, 'got 3 factorial')
  })
})

test('headless mode ignores a running live image', async () => {
  await withFakeLiveServer(() => ({ ok: true }), async config => {
    assert.equal((await resolveBackend({ ...config, pharoMode: 'headless' })).backend, 'headless')
  })
})

test('live mode fails clearly when no image is running', async () => {
  const config = { ...defaultConfig(), pharoMode: 'live' as const, liveFile: path.join(os.tmpdir(), 'pharo-agent-missing-live.json') }
  await assert.rejects(resolveBackend(config), /No live image configured/)
})

test('a failing SUnit report is not ok but keeps the report', async () => {
  const report = 'classes: 1\nruns: 2\npassed: 1\nfailures: 1\nerrors: 0\nFAILURE ShapeTest>>#testArea -- TestFailure: Got 6 instead of 7.'
  await withFakeLiveServer(() => ({ ok: true, result: report, durationMs: 3 }), async config => {
    const result = await runSUnit(config, { className: 'ShapeTest' })
    assert.equal(result.ok, false)
    assert.match(result.result ?? '', /Got 6 instead of 7/)
  })
})

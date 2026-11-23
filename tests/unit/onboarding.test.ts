import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { isTrustedFolder, loadConfig, trustFolder } from '../../pharo-agent/config.ts'
import { detectModelServers } from '../../pharo-agent/onboarding.ts'
import { loadMcpConfig } from '../../pharo-agent/mcp.ts'
import { defaultConfig } from '../../pharo-agent/config.ts'

test('a trusted folder covers its subfolders, not its siblings', () => {
  assert.equal(isTrustedFolder('/work/app', ['/work/app']), true)
  assert.equal(isTrustedFolder('/work/app/src', ['/work/app']), true)
  assert.equal(isTrustedFolder('/work/app-other', ['/work/app']), false)
  assert.equal(isTrustedFolder('/work', ['/work/app']), false)
})

test('a project .pharo-agent.json only applies once its folder is trusted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-trust-'))
  try {
    const project = path.join(root, 'project')
    await mkdir(project)
    // A malicious project tries to loosen permissions and trust itself.
    await writeFile(path.join(project, '.pharo-agent.json'), JSON.stringify({ permissionMode: 'dangerous', trustedFolders: [project] }))
    const globalFile = path.join(root, 'config.json')
    await writeFile(globalFile, '{}')
    assert.equal((await loadConfig({ configPath: globalFile, cwd: project })).permissionMode, 'ask')
    await trustFolder(project, globalFile)
    const trusted = await loadConfig({ configPath: globalFile, cwd: project })
    assert.equal(trusted.permissionMode, 'dangerous')
    assert.deepEqual(trusted.trustedFolders, [path.resolve(project)])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('finds running model servers and leaves out embedding models', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'qwen3:4b' }, { id: 'nomic-embed-text:latest' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    const found = (await detectModelServers([url])).find(entry => entry.baseUrl === url)
    assert.deepEqual(found?.models, ['qwen3:4b', 'nomic-embed-text:latest'])
  } finally {
    server.close()
  }
})

test('reads .mcp.json with either mcpServers or servers, and honours MCP off', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-mcp-'))
  try {
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ servers: { pharo: { command: 'npx', args: ['x'] } } }))
    assert.deepEqual(Object.keys((await loadMcpConfig(defaultConfig(), dir)).mcpServers ?? {}), ['pharo'])
    assert.deepEqual(await loadMcpConfig({ ...defaultConfig(), mcpEnabled: false }, dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

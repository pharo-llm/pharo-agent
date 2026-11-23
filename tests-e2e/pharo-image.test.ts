import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pharoVm = process.env.PHARO_VM
const pharoImage = process.env.PHARO_IMAGE
const sunitEnabled = process.env.PHARO_AGENT_E2E_RUN_SUNIT === '1'

test('evaluates Smalltalk in a configured Pharo image', { skip: pharoVm && pharoImage ? false : 'Set PHARO_VM and PHARO_IMAGE to run this E2E test.' }, () => {
  const result = spawnSync(process.execPath, [
    'pharo-agent/cli.ts',
    'eval',
    '--pharo-mode',
    'headless',
    '--pharo-vm',
    pharoVm!,
    '--image',
    pharoImage!,
    "| a | a := 'one!'. a , ' two'",
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.equal(result.stdout.trim(), 'one! two')
})

test('runs SUnit in a configured Pharo image when explicitly enabled', { skip: pharoVm && pharoImage && sunitEnabled ? false : 'Set PHARO_VM, PHARO_IMAGE, and PHARO_AGENT_E2E_RUN_SUNIT=1 to run this E2E test.' }, () => {
  const args = [
    'pharo-agent/cli.ts',
    'test',
    '--pharo-mode',
    'headless',
    '--pharo-vm',
    pharoVm!,
    '--image',
    pharoImage!,
  ]
  if (process.env.PHARO_AGENT_E2E_TEST_PACKAGE) args.push('--package', process.env.PHARO_AGENT_E2E_TEST_PACKAGE)
  if (process.env.PHARO_AGENT_E2E_TEST_CLASS) args.push('--class', process.env.PHARO_AGENT_E2E_TEST_CLASS)
  if (process.env.PHARO_AGENT_E2E_TEST_SELECTOR) args.push('--selector', process.env.PHARO_AGENT_E2E_TEST_SELECTOR)
  const result = spawnSync(process.execPath, [
    ...args,
  ], { encoding: 'utf8' })

  assert.match(`${result.stdout}\n${result.stderr}`, /runs: \d+|Error|Exception/)
})

test('inspects a class in a configured Pharo image', { skip: pharoVm && pharoImage ? false : 'Set PHARO_VM and PHARO_IMAGE to run this E2E test.' }, () => {
  const result = spawnSync(process.execPath, [
    'pharo-agent/cli.ts',
    'inspect',
    '--pharo-mode',
    'headless',
    '--pharo-vm',
    pharoVm!,
    '--image',
    pharoImage!,
    'Object',
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.match(result.stdout, /"kind":"class"/)
})

test('live mode keeps state between calls in a running image', { skip: pharoVm && pharoImage ? false : 'Set PHARO_VM and PHARO_IMAGE to run this E2E test.', timeout: 120_000 }, () => {
  // Isolated HOME: the live server writes its token to ~/.pharo-agent/live.json.
  const home = mkdtempSync(path.join(os.tmpdir(), 'pharo-agent-live-e2e-'))
  const port = String(4300 + Math.floor(Math.random() * 500))
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), PHARO_VM: pharoVm!, PHARO_IMAGE: pharoImage! }
  const cli = (...args: string[]) => spawnSync(process.execPath, ['pharo-agent/cli.ts', ...args], { encoding: 'utf8', env })
  try {
    const started = cli('live', 'start', '--headless', '--port', port)
    assert.equal(started.status, 0, `${started.stderr}\n${started.stdout}`)
    assert.equal(cli('eval', '--pharo-mode', 'live', "Smalltalk at: #PharoAgentE2E put: 41").status, 0)
    const second = cli('eval', '--pharo-mode', 'live', 'PharoAgentE2E + 1')
    assert.equal(second.stdout.trim(), '42', second.stderr)
  } finally {
    cli('eval', '--pharo-mode', 'live', '[ Smalltalk snapshot: false andQuit: true ] forkAt: Processor userBackgroundPriority')
    rmSync(home, { recursive: true, force: true })
  }
})

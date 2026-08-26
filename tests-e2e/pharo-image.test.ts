import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const pharoVm = process.env.PHARO_VM
const pharoImage = process.env.PHARO_IMAGE
const sunitEnabled = process.env.PHARO_AGENT_E2E_RUN_SUNIT === '1'

test('evaluates Smalltalk in a configured Pharo image', { skip: pharoVm && pharoImage ? false : 'Set PHARO_VM and PHARO_IMAGE to run this E2E test.' }, () => {
  const result = spawnSync(process.execPath, [
    'pharo-agent/cli.ts',
    'eval',
    '--pharo-vm',
    pharoVm!,
    '--image',
    pharoImage!,
    "Stdio stdout nextPutAll: (1 + 1) asString; cr",
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.match(result.stdout, /2/)
})

test('runs SUnit in a configured Pharo image when explicitly enabled', { skip: pharoVm && pharoImage && sunitEnabled ? false : 'Set PHARO_VM, PHARO_IMAGE, and PHARO_AGENT_E2E_RUN_SUNIT=1 to run this E2E test.' }, () => {
  const args = [
    'pharo-agent/cli.ts',
    'test',
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

  assert.match(`${result.stdout}\n${result.stderr}`, /Pharo Agent Test Report|Error|Exception/)
})

test('inspects a class in a configured Pharo image', { skip: pharoVm && pharoImage ? false : 'Set PHARO_VM and PHARO_IMAGE to run this E2E test.' }, () => {
  const result = spawnSync(process.execPath, [
    'pharo-agent/cli.ts',
    'inspect',
    '--pharo-vm',
    pharoVm!,
    '--image',
    pharoImage!,
    'Object',
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.match(result.stdout, /"found":true/)
})

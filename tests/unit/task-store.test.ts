import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { addTask, clearCompletedTasks, readTasks, updateTask } from '../pharo-agent/task-store.ts'

test('stores project tasks in XDG state', async () => {
  const oldState = process.env.XDG_STATE_HOME
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'pharo-agent-tasks-'))
  const cwd = path.join(stateDir, 'project')
  process.env.XDG_STATE_HOME = stateDir

  try {
    const task = await addTask('Port agent loop', cwd)
    assert.equal(task.status, 'pending')

    const updated = await updateTask(task.id, { status: 'completed' }, cwd)
    assert.equal(updated?.status, 'completed')

    assert.equal((await readTasks(cwd)).length, 1)
    assert.equal(await clearCompletedTasks(cwd), 1)
    assert.deepEqual(await readTasks(cwd), [])
  } finally {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = oldState
    await rm(stateDir, { recursive: true, force: true })
  }
})

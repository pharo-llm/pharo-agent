import path from 'node:path'
import { readJsonFile, writeJsonFile, xdgStateDir } from './platform.ts'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export type TaskItem = {
  id: string
  content: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export function taskFile(cwd = process.cwd()): string {
  const key = Buffer.from(cwd).toString('base64url')
  return path.join(xdgStateDir(), 'tasks', `${key}.json`)
}

export async function readTasks(cwd = process.cwd()): Promise<TaskItem[]> {
  return await readJsonFile<TaskItem[]>(taskFile(cwd), [])
}

export async function writeTasks(tasks: TaskItem[], cwd = process.cwd()): Promise<void> {
  await writeJsonFile(taskFile(cwd), tasks)
}

export async function addTask(content: string, cwd = process.cwd()): Promise<TaskItem> {
  const tasks = await readTasks(cwd)
  const now = new Date().toISOString()
  const item = {
    id: Math.random().toString(36).slice(2, 10),
    content,
    status: 'pending' as const,
    createdAt: now,
    updatedAt: now,
  }
  tasks.push(item)
  await writeTasks(tasks, cwd)
  return item
}

export async function updateTask(id: string, updates: Partial<Pick<TaskItem, 'content' | 'status'>>, cwd = process.cwd()): Promise<TaskItem | undefined> {
  const tasks = await readTasks(cwd)
  const item = tasks.find(task => task.id === id)
  if (!item) return undefined
  if (updates.content !== undefined) item.content = updates.content
  if (updates.status !== undefined) item.status = updates.status
  item.updatedAt = new Date().toISOString()
  await writeTasks(tasks, cwd)
  return item
}

export async function clearCompletedTasks(cwd = process.cwd()): Promise<number> {
  const tasks = await readTasks(cwd)
  const kept = tasks.filter(task => task.status !== 'completed')
  await writeTasks(kept, cwd)
  return tasks.length - kept.length
}

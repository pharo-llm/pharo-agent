import path from 'node:path'
import { appendFile, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { ChatMessage, SessionEvent, SessionRecord } from './types.ts'
import { ensureDir, xdgStateDir } from './platform.ts'

export class SessionRecorder {
  id: string
  file: string

  constructor(id: string, file: string) {
    this.id = id
    this.file = file
  }

  static async create(title?: string): Promise<SessionRecorder> {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`
    const file = path.join(sessionsDir(), `${id}.jsonl`)
    await ensureDir(path.dirname(file))
    await writeFile(file, `${JSON.stringify({ type: 'meta', id, title, timestamp: new Date().toISOString() })}\n`, 'utf8')
    return new SessionRecorder(id, file)
  }

  async record(event: SessionEvent): Promise<void> {
    await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8')
  }
}

export function sessionsDir(): string {
  return path.join(xdgStateDir(), 'sessions')
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureDir(sessionsDir())
  const files = await readdir(sessionsDir()).catch(() => [])
  const records: SessionRecord[] = []
  for (const file of files.filter(name => name.endsWith('.jsonl'))) {
    const full = path.join(sessionsDir(), file)
    const stats = await stat(full)
    const first = (await readFile(full, 'utf8')).split('\n')[0]
    let title: string | undefined
    try {
      const meta = JSON.parse(first)
      title = meta.title
    } catch {
      title = undefined
    }
    records.push({
      id: file.replace(/\.jsonl$/, ''),
      path: full,
      createdAt: stats.birthtime.toISOString(),
      updatedAt: stats.mtime.toISOString(),
      title,
    })
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function loadSessionMessages(idOrPath: string): Promise<ChatMessage[]> {
  const file = idOrPath.includes('/') ? idOrPath : path.join(sessionsDir(), `${idOrPath}.jsonl`)
  const text = await readFile(file, 'utf8')
  const messages: ChatMessage[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (event.type === 'message' && event.message) messages.push(event.message)
  }
  return messages
}

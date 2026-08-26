import path from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { execFileCapture } from './platform.ts'

export async function workspaceContext(cwd = process.cwd()): Promise<string> {
  const [git, files] = await Promise.all([gitContext(cwd), topFiles(cwd)])
  return `# Workspace
CWD: ${cwd}
${git}

Top-level files:
${files.map(file => `- ${file}`).join('\n')}`
}

export async function topFiles(cwd = process.cwd()): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true })
    return entries
      .filter(entry => !['.git', 'node_modules', '.cache', '.venv'].includes(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 80)
      .map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
  } catch {
    return []
  }
}

export async function gitContext(cwd = process.cwd()): Promise<string> {
  const inside = await execFileCapture(['git', 'rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 5_000 })
  if (inside.exitCode !== 0) return 'Git: not a git repository'
  const branch = await execFileCapture(['git', 'branch', '--show-current'], { cwd, timeoutMs: 5_000 })
  const status = await execFileCapture(['git', 'status', '--short'], { cwd, timeoutMs: 5_000 })
  return `Git: ${branch.stdout.trim() || 'detached'}
Status:
${status.stdout.trim() || 'clean'}`
}

export async function collectFiles(root: string, options: { maxFiles?: number; includeHidden?: boolean } = {}): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 500
  const result: string[] = []
  async function walk(dir: string): Promise<void> {
    if (result.length >= maxFiles) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (result.length >= maxFiles) return
      if (!options.includeHidden && entry.name.startsWith('.')) continue
      if (['.git', 'node_modules', 'dist', 'build', '__pycache__'].includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else result.push(full)
    }
  }
  await walk(root)
  return result
}

export async function readTextSlice(file: string, offset = 0, limit = 20_000): Promise<{ content: string; size: number; truncated: boolean }> {
  const content = await readFile(file, 'utf8')
  const sliced = content.slice(offset, offset + limit)
  return { content: sliced, size: content.length, truncated: offset + limit < content.length }
}

export async function isTextFile(file: string): Promise<boolean> {
  const stats = await stat(file).catch(() => undefined)
  if (!stats?.isFile()) return false
  const sample = await readFile(file).then(buffer => buffer.subarray(0, 4096)).catch(() => Buffer.alloc(0))
  return !sample.includes(0)
}

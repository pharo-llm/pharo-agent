import net from 'node:net'
import path from 'node:path'
import type { AgentConfig } from './types.ts'
import { resolvePath } from './platform.ts'

export class SafetyError extends Error {}

export function resolveWorkspacePath(value: string, cwd: string, config: AgentConfig): string {
  const resolved = resolvePath(value, cwd)
  if (config.allowOutsideWorkspace || config.permissionMode === 'dangerous') return resolved
  if (!isInsideWorkspace(resolved, cwd)) {
    throw new SafetyError(`Path is outside the workspace: ${resolved}. Set allowOutsideWorkspace or use dangerous mode to allow it.`)
  }
  return resolved
}

export function isInsideWorkspace(target: string, cwd: string): boolean {
  const root = path.resolve(cwd)
  const relative = path.relative(root, path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function isWorkspaceRoot(target: string, cwd: string): boolean {
  return path.resolve(target) === path.resolve(cwd)
}

export function assertUrlAllowed(rawUrl: string, config: AgentConfig): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SafetyError(`Invalid URL: ${rawUrl}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SafetyError(`Only http and https URLs are allowed: ${url.protocol}`)
  }
  if (!config.allowPrivateNetwork && config.permissionMode !== 'dangerous' && isPrivateOrLocalHost(url.hostname)) {
    throw new SafetyError(`Private or local network URLs are blocked for web_fetch: ${url.hostname}`)
  }
  return url
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  const family = net.isIP(host)
  if (family === 4) return isPrivateIpv4(host)
  if (family === 6) return host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
  return false
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
}


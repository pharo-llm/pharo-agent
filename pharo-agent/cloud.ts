/**
 * Pharo Cloud: hosted models for pharo-agent. No login: this machine registers
 * once with a hashed fingerprint and gets a client ID, which is sent with every
 * request (X-Pharo-Client-Id) so the cloud can apply usage limits per machine.
 */
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import type { AgentConfig } from './types.ts'
import { execFileCapture, xdgConfigDir } from './platform.ts'
import { VERSION } from './version.ts'

/** Where Pharo Cloud runs. Override with PHARO_CLOUD_URL or `pharo-agent cloud connect <url>`. */
export const DEFAULT_CLOUD_URL = process.env.PHARO_CLOUD_URL ?? 'http://127.0.0.1:8000'

export class CloudError extends Error {}

export type CloudUsage = {
  clientId: string
  plan: string
  planLabel: string
  status: 'active' | 'blocked'
  session: { used: number; limit: number | null; resetsAt: string | null; hours: number; active: boolean }
  week: { used: number; limit: number | null; resetsAt: string | null }
  minute: { used: number; limit: number | null }
  concurrent: { used: number; limit: number | null }
  maxTokensPerRequest: number | null
  last7Days?: { day: string; tokens: number; requests: number }[]
}

export type CloudStatus = { ok: boolean; version?: string; models: string[]; defaultModel?: string | null; engines?: { healthy: number; total: number }; queue?: { running: number; waiting: number } }

export function isCloud(config: AgentConfig): boolean {
  return Boolean(config.cloudUrl && config.cloudClientId && config.baseUrl.startsWith(config.cloudUrl))
}

export function cloudHeaders(config: AgentConfig): Record<string, string> {
  return isCloud(config) ? { 'x-pharo-client-id': config.cloudClientId! } : {}
}

/** The OS machine id, never sent anywhere: only its SHA-256 is. */
async function machineId(): Promise<string> {
  try {
    if (process.platform === 'darwin') {
      const out = await execFileCapture(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], { timeoutMs: 5_000 })
      const match = /"IOPlatformUUID" = "([^"]+)"/.exec(out.stdout)
      if (match) return match[1]!
    } else if (process.platform === 'win32') {
      const out = await execFileCapture(['reg', 'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { timeoutMs: 5_000 })
      const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out.stdout)
      if (match) return match[1]!
    } else {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        const text = (await readFile(file, 'utf8').catch(() => '')).trim()
        if (text) return text
      }
    }
  } catch {
    // fall back below
  }
  // No OS id available (containers): a random one, kept so it stays stable.
  const file = path.join(xdgConfigDir(), 'machine-id')
  const saved = (await readFile(file, 'utf8').catch(() => '')).trim()
  if (saved) return saved
  const created = randomUUID()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, created, { mode: 0o600 })
  return created
}

export async function machineFingerprint(): Promise<string> {
  return createHash('sha256').update(`pharo-cloud:${await machineId()}`).digest('hex')
}

async function cloudFetch<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 10_000) })
  } catch (error) {
    throw new CloudError(`Could not reach Pharo Cloud at ${new URL(url).origin}: ${(error as Error).message}`)
  }
  const data = await response.json().catch(() => ({})) as T & { error?: { message?: string } }
  if (!response.ok) throw new CloudError(data.error?.message ?? `Pharo Cloud answered HTTP ${response.status}`)
  return data
}

export async function cloudStatus(url: string, timeoutMs = 3_000): Promise<CloudStatus | undefined> {
  try {
    return await cloudFetch<CloudStatus>(`${url.replace(/\/$/, '')}/v1/status`, { timeoutMs })
  } catch {
    return undefined
  }
}

/** Register this machine (idempotent: the same machine always gets the same id). */
export async function registerMachine(url: string): Promise<{ clientId: string; defaultModel: string | null; usage: CloudUsage }> {
  return cloudFetch(`${url.replace(/\/$/, '')}/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fingerprint: await machineFingerprint(), os: `${process.platform} ${os.release()}`, clientVersion: VERSION }),
  })
}

export async function cloudUsage(config: AgentConfig, timeoutMs = 5_000): Promise<CloudUsage> {
  if (!config.cloudUrl || !config.cloudClientId) throw new CloudError('Pharo Cloud is not set up. Run pharo-agent setup and choose Pharo Cloud.')
  return cloudFetch(`${config.cloudUrl}/v1/usage`, { headers: { 'x-pharo-client-id': config.cloudClientId }, timeoutMs })
}

/** "12% of your 5-hour session" style summary for banners. */
export function usageSummary(usage: CloudUsage): string {
  const parts: string[] = []
  if (usage.session.limit) parts.push(`${Math.round((usage.session.used / usage.session.limit) * 100)}% of ${usage.session.hours}h session`)
  if (usage.week.limit) parts.push(`${Math.round((usage.week.used / usage.week.limit) * 100)}% of week`)
  return parts.join(' · ') || 'no limits'
}

export function resetIn(iso: string | null): string {
  if (!iso) return 'starts with your next request'
  const seconds = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000))
  if (seconds < 90) return `resets in ${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `resets in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `resets in ${hours}h ${minutes % 60}m` : `resets in ${Math.round(hours / 24)} days`
}

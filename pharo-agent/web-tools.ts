import type { ToolResult } from './types.ts'
import type { AgentConfig } from './types.ts'
import { assertUrlAllowed } from './safety.ts'

export async function fetchUrl(url: string, options: { maxChars?: number; config?: AgentConfig } = {}): Promise<ToolResult> {
  const target = options.config ? assertUrlAllowed(url, options.config) : new URL(url)
  const response = await fetch(target, {
    headers: {
      'user-agent': 'pharo-agent/0.1 (+https://github.com/pharo-llm/pharo-agent)',
      accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.8',
    },
  })
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  const cleaned = contentType.includes('html') ? htmlToText(text) : text
  const maxChars = options.maxChars ?? 20_000
  return {
    ok: response.ok,
    data: {
      url: response.url,
      status: response.status,
      contentType,
      content: cleaned.slice(0, maxChars),
      truncated: cleaned.length > maxChars,
    },
  }
}

export async function webSearch(query: string, options: { maxResults?: number } = {}): Promise<ToolResult> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    headers: {
      'user-agent': 'pharo-agent/0.1',
      accept: 'text/html',
    },
  })
  const html = await response.text()
  const results = parseDuckDuckGo(html).slice(0, options.maxResults ?? 8)
  return {
    ok: response.ok,
    data: {
      query,
      status: response.status,
      results,
    },
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s+\n/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function parseDuckDuckGo(html: string): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = []
  const chunks = html.split(/class="result(?:__body)?"/)
  for (const chunk of chunks) {
    const link = chunk.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!link) continue
    const snippet = chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/)
    results.push({
      url: decodeHtml(link[1]!),
      title: htmlToText(link[2]!),
      snippet: htmlToText(snippet?.[1] ?? snippet?.[2] ?? ''),
    })
  }
  return results
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
}

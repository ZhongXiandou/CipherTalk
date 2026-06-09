/**
 * 联网搜索服务 —— AI Agent 的 web_search 工具用的 Tavily 后端。
 * 配置存 ConfigService.webSearchConfig；HTTP 走系统代理（undici ProxyAgent），主进程与 AI 子进程都能用。
 */
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { ConfigService } from '../config'
import { getResolvedProxyUrl } from './proxyFetch'

export interface WebSearchConfig {
  enabled: boolean
  apiKey: string
  maxResults: number
}

export interface WebSearchResult {
  title: string
  url: string
  content: string
}

export interface WebSearchResponse {
  answer?: string
  results: WebSearchResult[]
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

/** 读取持久化的联网搜索配置。 */
export function getWebSearchConfig(): WebSearchConfig {
  const cs = new ConfigService()
  try {
    return cs.get('webSearchConfig')
  } finally {
    cs.close()
  }
}

/** 写入联网搜索配置（部分字段合并）。 */
export function saveWebSearchConfig(patch: Partial<WebSearchConfig>): WebSearchConfig {
  const cs = new ConfigService()
  try {
    const next = { ...cs.get('webSearchConfig'), ...patch }
    cs.set('webSearchConfig', next)
    return next
  } finally {
    cs.close()
  }
}

/** 联网搜索是否可用：启用且配了 key。buildTools / 提示词据此决定是否挂 web_search。 */
export function isWebSearchAvailable(cfg: WebSearchConfig = getWebSearchConfig()): boolean {
  return cfg.enabled && Boolean(cfg.apiKey)
}

/** 调 Tavily 搜索。key 缺失/网络异常抛错，由工具层兜成 {error} 回给模型。 */
export async function tavilySearch(
  query: string,
  options: { apiKey?: string; maxResults?: number; signal?: AbortSignal } = {},
): Promise<WebSearchResponse> {
  const cfg = getWebSearchConfig()
  const apiKey = options.apiKey || cfg.apiKey
  if (!apiKey) throw new Error('未配置 Tavily API Key')
  const maxResults = Math.min(Math.max(options.maxResults ?? cfg.maxResults ?? 5, 1), 10)

  const proxyUrl = getResolvedProxyUrl()
  const dispatcher = proxyUrl && /^https?:\/\//i.test(proxyUrl) ? new ProxyAgent(proxyUrl) : undefined

  const response = await undiciFetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: true,
    }),
    signal: options.signal,
    dispatcher,
  } as any)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Tavily 请求失败：HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  }

  const data = (await response.json()) as {
    answer?: string
    results?: Array<{ title?: string; url?: string; content?: string }>
  }
  const results: WebSearchResult[] = Array.isArray(data.results)
    ? data.results.map((item) => ({
        title: String(item.title || '').trim(),
        url: String(item.url || '').trim(),
        content: String(item.content || '').trim(),
      })).filter((item) => item.url)
    : []
  return { answer: data.answer ? String(data.answer).trim() : undefined, results }
}

/** 测试连接：用一个固定查询验证 key 可用。 */
export async function testWebSearchConfig(cfg: WebSearchConfig): Promise<{ success: boolean; resultCount?: number; error?: string }> {
  try {
    const res = await tavilySearch('Tavily connectivity test', { apiKey: cfg.apiKey, maxResults: 1 })
    return { success: true, resultCount: res.results.length }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 把 provider 配置变成 AI SDK 的 LanguageModel —— 纯函数，不依赖 Electron app/ConfigService，
 * 可在 AI 子进程内调用。逻辑对齐 ai/providers/base.ts 的 getModelProvider()。
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createProxyFetch } from '../ai/proxyFetch'
import type { AgentProviderConfig } from './types'

/**
 * 部分第三方 Claude 代理（如 right.codes/claude-aws）会强制返回 thinking 块却漏掉 signature 字段，
 * 触发 @ai-sdk/anthropic 的 schema 校验失败（Invalid JSON response）。这里在非流式 JSON 响应里
 * 剔除「缺 signature 的 thinking 块」，让合规的 text/tool_use 块照常解析；合规响应原样返回。
 */
function sanitizeAnthropicThinking(bodyText: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return bodyText
  }
  if (!parsed || parsed.type !== 'message' || !Array.isArray(parsed.content)) return bodyText
  const cleaned = parsed.content.filter(
    (b: any) => !(b && b.type === 'thinking' && (typeof b.signature !== 'string' || b.signature.length === 0)),
  )
  // 剔光会让 content 变空（不该发生，总有 text 块），保险起见保持原样
  if (cleaned.length === parsed.content.length || cleaned.length === 0) return bodyText
  parsed.content = cleaned
  return JSON.stringify(parsed)
}

/** 给 anthropic 的 fetch 包一层：只清洗非流式 JSON 响应，流式(SSE)与非 2xx 一律透传。 */
function withAnthropicSanitizer(baseFetch: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
  const f = baseFetch ?? (globalThis.fetch as typeof globalThis.fetch)
  return (async (input: any, init?: any) => {
    const res = await f(input, init)
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !contentType.includes('application/json')) return res
    const text = await res.text()
    const fixed = sanitizeAnthropicThinking(text)
    if (fixed === text) {
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
    }
    const headers = new Headers(res.headers)
    headers.delete('content-length') // 重写 body 后旧长度失效
    headers.delete('content-encoding') // undici 已解压，别让下游再按 gzip 解
    return new Response(fixed, { status: res.status, statusText: res.statusText, headers })
  }) as typeof globalThis.fetch
}

export function createLanguageModel(config: AgentProviderConfig): LanguageModel {
  const { providerKind, name, apiKey, baseURL, model, headers, proxyUrl } = config
  const fetch = createProxyFetch(proxyUrl)

  if (providerKind === 'anthropic') {
    return createAnthropic({ apiKey, baseURL, name, headers, fetch: withAnthropicSanitizer(fetch) })(model as any)
  }
  if (providerKind === 'google') {
    return createGoogle({ apiKey, baseURL, name, headers, fetch })(model as any)
  }
  if (providerKind === 'openai-responses') {
    return createOpenAI({ apiKey, baseURL, name, headers, fetch }).responses(model as any)
  }

  return createOpenAICompatible({ name, apiKey, baseURL, headers, includeUsage: true, fetch }).chatModel(model)
}

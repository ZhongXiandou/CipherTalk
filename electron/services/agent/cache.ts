import { createHash } from 'crypto'
import type { ProviderOptions, SystemModelMessage } from '@ai-sdk/provider-utils'
import type { ToolSet } from 'ai'
import type { AgentReasoningEffort, AgentRunInput } from './types'

export interface AgentPromptParts {
  cacheableSystem: string
  dynamicSystem: string
  /** 每轮必变（当前时间、按问题挑选的技能等）；不进 instructions，由 engine 注入消息尾部以保住前缀缓存。 */
  turnSystem: string
}

const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral', ttl: '5m' } as const
const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4

const CACHEABLE_BUILTIN_TOOL_NAMES = new Set([
  'list_contacts',
  'search_messages',
  'semantic_search',
  'get_context',
  'get_timeline',
  'chat_stats',
  'list_groups',
  'group_members',
  'group_member_ranking',
  'search_moments',
  'moments_stats',
  'query_sql',
  'update_plan',
  'remember',
  'recall',
  'list_memories',
  'forget',
  'consolidate_memory',
  'delegate_analysis',
  'export_chat',
])

function toCamelCase(value: string): string {
  return value.replace(/[-_\s]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function hostFromUrl(url: string): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function isOfficialOpenAIResponsesEndpoint(input: AgentRunInput): boolean {
  return input.providerConfig.providerKind === 'openai-responses' &&
    hostFromUrl(input.providerConfig.baseURL) === 'api.openai.com'
}

function isDeepSeekProvider(input: AgentRunInput): boolean {
  if (input.providerConfig.providerKind !== 'openai-compatible') return false
  const text = [input.providerConfig.name, input.providerConfig.baseURL, input.providerConfig.model]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return text.includes('deepseek')
}

function supportsOpenAI24hPromptCache(model: string): boolean {
  return /\b5\.1\b/.test(model.toLowerCase())
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function stableToolSignature(tools: ToolSet): string {
  const items = Object.entries(tools)
    .filter(([name]) => CACHEABLE_BUILTIN_TOOL_NAMES.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, tool]) => ({
      name,
      description: tool.description || '',
      title: tool.title || '',
    }))
  return JSON.stringify(items)
}

export function buildPromptCacheKey(parts: AgentPromptParts, tools: ToolSet): string {
  return `ciphertalk:agent:${shortHash(parts.cacheableSystem)}:${shortHash(stableToolSignature(tools))}`
}

function isReasoningEffortSet(effort?: AgentReasoningEffort): effort is Exclude<AgentReasoningEffort, 'auto'> {
  return Boolean(effort && effort !== 'auto')
}

export function buildReasoningOption(config: { reasoningEffort?: AgentReasoningEffort }): Exclude<AgentReasoningEffort, 'auto'> | undefined {
  return isReasoningEffortSet(config.reasoningEffort) ? config.reasoningEffort : undefined
}

function toAnthropicEffort(effort: Exclude<AgentReasoningEffort, 'auto'>): 'low' | 'medium' | 'high' {
  if (effort === 'minimal') return 'low'
  if (effort === 'xhigh') return 'high' // Anthropic 无 xhigh 档，封顶到 high
  return effort
}

function toGoogleThinkingConfig(
  effort: Exclude<AgentReasoningEffort, 'auto'>,
  model: string,
): Record<string, unknown> | undefined {
  const normalizedModel = model.toLowerCase()
  if (normalizedModel.includes('gemini-3')) {
    // Gemini 3 的 thinkingLevel 只认 low/high，xhigh 封顶到 high
    return { thinkingLevel: effort === 'xhigh' ? 'high' : effort, includeThoughts: true }
  }
  if (!normalizedModel.includes('gemini-2.5')) {
    return undefined
  }

  const thinkingBudgetByEffort: Record<Exclude<AgentReasoningEffort, 'auto'>, number> = {
    minimal: 1024,
    low: 2048,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
  }
  return { thinkingBudget: thinkingBudgetByEffort[effort], includeThoughts: true }
}

export function buildProviderOptions(input: AgentRunInput, promptCacheKey: string): ProviderOptions | undefined {
  const effort = input.providerConfig.reasoningEffort
  const options: Record<string, Record<string, unknown>> = {}

  if (input.providerConfig.providerKind === 'openai-responses' || input.providerConfig.providerKind === 'openai-compatible') {
    const option: Record<string, unknown> = {}
    if (isReasoningEffortSet(effort)) option.reasoningEffort = effort
    if (input.providerConfig.providerKind === 'openai-responses') {
      // 让 OpenAI 返回思考摘要（推理模型才有内容，非推理模型会被忽略）；下游 engine 已透传 reasoning 块
      option.reasoningSummary = 'auto'
      option.store = isOfficialOpenAIResponsesEndpoint(input)
      if (option.store) {
        option.promptCacheKey = promptCacheKey
        if (supportsOpenAI24hPromptCache(input.providerConfig.model)) {
          option.promptCacheRetention = '24h'
        }
      }
    } else {
      // @ai-sdk/openai-compatible 只校验 camelCase 标准项；厂商扩展字段要用请求体原名透传。
      // 这里恢复 AI SDK 6 时代 OpenAI-compatible 服务常用的 prompt_cache_key 行为。
      option.prompt_cache_key = promptCacheKey
    }
    if (Object.keys(option).length > 0) {
      const keys = new Set(['openai'])
      if (input.providerConfig.providerKind === 'openai-compatible') {
        keys.add(input.providerConfig.name)
        keys.add(toCamelCase(input.providerConfig.name))
      }
      for (const key of keys) options[key] = option
    }
  }

  if (input.providerConfig.providerKind === 'anthropic' && isReasoningEffortSet(effort)) {
    options.anthropic = {
      effort: toAnthropicEffort(effort),
    }
  }

  if (input.providerConfig.providerKind === 'google' && isReasoningEffortSet(effort)) {
    const thinkingConfig = toGoogleThinkingConfig(effort, input.providerConfig.model)
    if (thinkingConfig) {
      options.google = { thinkingConfig }
    }
  }

  return Object.keys(options).length > 0 ? options as ProviderOptions : undefined
}

export type AgentProviderCacheStatus = {
  providerKind: AgentRunInput['providerConfig']['providerKind']
  providerName: string
  model: string
  promptCacheKey: string
  promptCacheRetention?: '24h'
  promptCacheEnabled: boolean
  promptCacheProvider: 'openai-responses' | 'anthropic' | 'google' | 'openai-compatible' | 'none'
  requestBodyPromptCacheField?: 'prompt_cache_key' | 'promptCacheKey'
  reason?: string
}

export function buildProviderCacheStatus(input: AgentRunInput, promptCacheKey: string): AgentProviderCacheStatus {
  const base = {
    providerKind: input.providerConfig.providerKind,
    providerName: input.providerConfig.name,
    model: input.providerConfig.model,
    promptCacheKey,
  }
  if (isOfficialOpenAIResponsesEndpoint(input)) {
    return {
      ...base,
      ...(supportsOpenAI24hPromptCache(input.providerConfig.model) ? { promptCacheRetention: '24h' as const } : {}),
      promptCacheEnabled: true,
      promptCacheProvider: 'openai-responses',
      requestBodyPromptCacheField: 'promptCacheKey',
    }
  }
  if (input.providerConfig.providerKind === 'anthropic') {
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'anthropic',
    }
  }
  if (input.providerConfig.providerKind === 'google') {
    return {
      ...base,
      promptCacheEnabled: false,
      promptCacheProvider: 'google',
      reason: 'Google 需要预先创建 cachedContent，当前仅读取返回的 cachedContentTokenCount，尚未创建 cachedContent。',
    }
  }
  if (input.providerConfig.providerKind === 'openai-compatible') {
    if (isDeepSeekProvider(input)) {
      return {
        ...base,
        promptCacheEnabled: true,
        promptCacheProvider: 'openai-compatible',
        requestBodyPromptCacheField: 'prompt_cache_key',
        reason: 'DeepSeek 上下文硬盘缓存默认开启；当前通过隐藏 system 历史消息保持多轮前缀可复现，并读取 prompt_cache_hit_tokens / prompt_cache_miss_tokens。',
      }
    }
    return {
      ...base,
      promptCacheEnabled: true,
      promptCacheProvider: 'openai-compatible',
      requestBodyPromptCacheField: 'prompt_cache_key',
      reason: '已通过 AI SDK openai-compatible 的 transformRequestBody 注入 prompt_cache_key；是否命中取决于服务商是否支持并返回 cached_tokens。',
    }
  }
  return {
    ...base,
    promptCacheEnabled: false,
    promptCacheProvider: 'none',
    reason: '当前 provider 不支持可控 prompt cache 参数。',
  }
}

function withAnthropicCacheControl(providerOptions?: ProviderOptions): ProviderOptions {
  return {
    ...(providerOptions || {}),
    anthropic: {
      ...((providerOptions?.anthropic as Record<string, unknown> | undefined) || {}),
      cacheControl: ANTHROPIC_CACHE_CONTROL,
    },
  }
}

export function applyAnthropicCacheControl(
  messages: SystemModelMessage[],
  tools: ToolSet,
): { messages: SystemModelMessage[]; tools: ToolSet } {
  let remainingBreakpoints = MAX_ANTHROPIC_CACHE_BREAKPOINTS
  const takeBreakpoint = () => {
    if (remainingBreakpoints <= 0) return false
    remainingBreakpoints -= 1
    return true
  }
  const nextMessages = messages.map((message, index) => (
    index === 0 && takeBreakpoint()
      ? { ...message, providerOptions: withAnthropicCacheControl(message.providerOptions) }
      : message
  ))

  const nextTools: ToolSet = {}
  for (const [name, item] of Object.entries(tools)) {
    nextTools[name] = CACHEABLE_BUILTIN_TOOL_NAMES.has(name) && takeBreakpoint()
      ? { ...item, providerOptions: withAnthropicCacheControl(item.providerOptions) } as typeof item
      : item
  }

  return { messages: nextMessages, tools: nextTools }
}

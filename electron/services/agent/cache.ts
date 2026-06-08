import { createHash } from 'crypto'
import type { ProviderOptions, SystemModelMessage } from '@ai-sdk/provider-utils'
import type { ToolSet } from 'ai'
import type { AgentRunInput } from './types'

export interface AgentPromptParts {
  cacheableSystem: string
  dynamicSystem: string
}

const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral', ttl: '5m' } as const

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
    input.providerConfig.name !== 'custom' &&
    hostFromUrl(input.providerConfig.baseURL) === 'api.openai.com'
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

export function buildProviderOptions(input: AgentRunInput, promptCacheKey: string): ProviderOptions | undefined {
  const effort = input.providerConfig.reasoningEffort
  const isOpenAIProtocol = input.providerConfig.providerKind === 'openai-responses' || input.providerConfig.providerKind === 'openai-compatible'
  if (!isOpenAIProtocol) {
    return undefined
  }

  const option: Record<string, unknown> = {}
  if (effort && effort !== 'auto') option.reasoningEffort = effort
  if (input.providerConfig.providerKind === 'openai-responses') {
    option.store = isOfficialOpenAIResponsesEndpoint(input)
    if (option.store) option.promptCacheKey = promptCacheKey
  }
  if (Object.keys(option).length === 0) return undefined

  const keys = new Set(['openai'])
  if (input.providerConfig.providerKind === 'openai-compatible') {
    keys.add(input.providerConfig.name)
    keys.add(toCamelCase(input.providerConfig.name))
  }

  return Object.fromEntries([...keys].map((key) => [key, option])) as ProviderOptions
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
  const nextMessages = messages.map((message, index) => (
    index === 0
      ? { ...message, providerOptions: withAnthropicCacheControl(message.providerOptions) }
      : message
  ))

  const nextTools: ToolSet = {}
  for (const [name, item] of Object.entries(tools)) {
    nextTools[name] = CACHEABLE_BUILTIN_TOOL_NAMES.has(name)
      ? { ...item, providerOptions: withAnthropicCacheControl(item.providerOptions) } as typeof item
      : item
  }

  return { messages: nextMessages, tools: nextTools }
}

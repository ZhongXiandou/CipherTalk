/**
 * 在主进程解析当前 AI provider 配置，注入给 AI 子进程（子进程不依赖 ConfigService/catalog）。
 * 复用现有 ConfigService + catalog，不新增配置来源。
 */
import { ConfigService } from '../config'
import { getProviderDefinition, normalizeProviderId } from '../ai/providers/catalog'
import { getResolvedProxyUrl } from '../ai/proxyFetch'
import type { AgentProviderConfig, AgentProviderConfigOverride } from './types'

export function resolveProviderConfig(override?: AgentProviderConfigOverride | null): AgentProviderConfig {
  const config = new ConfigService()
  try {
    const name = normalizeProviderId(override?.provider || config.getAICurrentProvider() || 'deepseek')
    const def = getProviderDefinition(name)
    if (!def) throw new Error(`不支持的 AI 服务商: ${name}`)

    const providerConfig = {
      ...(config.getAIProviderConfig(name) || {}),
      ...(override || {}),
    }
    const apiKey = providerConfig?.apiKey || ''
    const model = providerConfig?.model || def.models?.[0] || ''
    if (!apiKey && def.protocol !== 'codex-subscription') throw new Error('未配置 AI 服务商的 API Key，请先在设置中配置')
    if (!model) throw new Error('未选择模型，请先在设置中选择模型')

    // 模型上下文窗口（token），供引擎 >90% 自动压缩判断用；自定义/未知模型取不到则留空，引擎兜默认值
    const contextWindow = def.modelDetails?.find((item) => item.id === model)?.limits?.context

    return {
      providerKind: providerConfig?.protocol || def.protocol || 'openai-compatible',
      name,
      apiKey,
      baseURL: providerConfig?.baseURL || def.baseURL || '',
      model,
      reasoningEffort: providerConfig?.reasoningEffort,
      proxyUrl: getResolvedProxyUrl() || undefined,
      contextWindow: typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined,
      anthropicCacheTtl: config.get('anthropicCacheTtl') === '1h' ? '1h' : '5m',
    }
  } finally {
    config.close()
  }
}

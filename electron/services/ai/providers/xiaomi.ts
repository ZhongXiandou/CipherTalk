import OpenAI from 'openai'
import { BaseAIProvider, type AIStreamEvent, type ChatOptions } from './base'

const XIAOMI_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const XIAOMI_TOKEN_PLAN_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'

function normalizeApiKey(apiKey: string): string {
  return String(apiKey || '').trim()
}

function isTokenPlanApiKey(apiKey: string): boolean {
  return normalizeApiKey(apiKey).startsWith('tp-')
}

/**
 * Xiaomi MiMo提供商元数据
 */
export const XiaomiMetadata = {
  id: 'xiaomi',
  name: 'xiaomi',
  displayName: 'Xiaomi MiMo',
  description: '小米大模型',
  models: [
    'mimo-v2.5-pro',
    'mimo-v2.5',
    'mimo-v2-pro',
    'mimo-v2-omni',
    'mimo-v2-tts',
    'mimo-v2-flash'
  ],
  pricing: '免费',
  pricingDetail: {
    input: 0.0,
    output: 0.0
  },
  website: 'https://api.xiaomimimo.com/',
  logo: './AI-logo/xiaomimimo.svg'
}

/**
 * Xiaomi MiMo提供商
 */
export class XiaomiProvider extends BaseAIProvider {
  name = XiaomiMetadata.name
  displayName = XiaomiMetadata.displayName
  models = XiaomiMetadata.models
  pricing = XiaomiMetadata.pricingDetail

  constructor(apiKey: string) {
    const normalizedApiKey = normalizeApiKey(apiKey)
    const useTokenPlan = isTokenPlanApiKey(normalizedApiKey)

    super(
      normalizedApiKey,
      useTokenPlan ? XIAOMI_TOKEN_PLAN_BASE_URL : XIAOMI_DEFAULT_BASE_URL
    )
  }

  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onEvent: (event: AIStreamEvent) => void
  ): Promise<void> {
    const client = await this.getClient()
    const enableThinking = options?.enableThinking !== false
    const model = this.resolveModelId(options?.model || this.models[0])

    const requestParams: any = {
      model,
      messages,
      temperature: options?.temperature || 0.7,
      max_tokens: options?.maxTokens,
      stream: true,
    }

    // 小米 API 只接受 'low' | 'medium' | 'high'，不支持 'none' 和 thinking 对象
    if (enableThinking) {
      requestParams.reasoning_effort = 'medium'
    }

    const stream = await client.chat.completions.create(requestParams) as any

    let contentText = ''
    let reasoningText = ''
    let finishReason: string | null = null

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      finishReason = choice?.finish_reason || finishReason
      const delta = choice?.delta
      const content = delta?.content || ''
      const reasoning = delta?.reasoning_content || ''

      if (reasoning) {
        reasoningText += reasoning
        onEvent({ type: 'reasoning_delta', text: reasoning })
      }
      if (content) {
        contentText += content
        onEvent({ type: 'content_delta', text: content })
      }
    }

    onEvent({
      type: 'message_done',
      content: contentText,
      reasoningContent: reasoningText || undefined,
      finishReason
    })
  }
}

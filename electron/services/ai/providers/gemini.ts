import { BaseAIProvider, type AIStreamEvent } from './base'
import OpenAI from 'openai'

/**
 * Gemini 提供商元数据
 */
export const GeminiMetadata = {
  id: 'gemini',
  name: 'gemini',
  displayName: 'Gemini',
  description: 'Google 最新的多模态 AI 模型',
  models: [
    'Gemini 3.1 Pro',
    'Gemini 3 Pro Preview',
    'Gemini 3 Flash Preview',
    'Gemini 2.5 Flash',
    'Gemini 2.5 Flash Lite',
    'Gemini 2.5 Pro',
    'Gemini 2.0 Flash',
    'Gemini 2.0 Flash Lite'
  ],
  pricing: '按量计费',
  pricingDetail: {
    input: 0.00015,   // gemini-1.5-flash 输入价格 $0.15/1M tokens
    output: 0.0006    // gemini-1.5-flash 输出价格 $0.60/1M tokens
  },
  website: 'https://ai.google.dev/',
  logo: './AI-logo/gemini-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  'Gemini 3.1 Pro': 'gemini-3.1-pro-preview',
  'Gemini 3 Pro Preview': 'gemini-3-pro-preview',
  'Gemini 3 Flash Preview': 'gemini-3-flash-preview',
  'Gemini 2.5 Flash': 'gemini-2.5-flash',
  'Gemini 2.5 Flash Lite': 'gemini-2.5-flash-lite',
  'Gemini 2.5 Pro': 'gemini-2.5-pro',
  'Gemini 2.0 Flash': 'gemini-2.0-flash',
  'Gemini 2.0 Flash Lite': 'gemini-2.0-flash-lite'
}

/**
 * Gemini 提供商
 * 使用 OpenAI 兼容的 API 格式
 */
export class GeminiProvider extends BaseAIProvider {
  name = GeminiMetadata.name
  displayName = GeminiMetadata.displayName
  models = GeminiMetadata.models
  pricing = GeminiMetadata.pricingDetail

  constructor(apiKey: string) {
    // 使用 OpenAI 兼容的端点
    super(apiKey, 'https://generativelanguage.googleapis.com/v1beta/openai')
  }

  /**
   * 获取真实模型ID
   */
  private getModelId(displayName: string): string {
    return MODEL_MAPPING[displayName] || displayName
  }

  protected resolveModelId(displayName: string): string {
    return this.getModelId(displayName)
  }

  /**
   * 重写 chat 方法以使用映射后的模型ID
   */
  async chat(messages: any[], options?: any): Promise<string> {
    const modelId = this.getModelId(options?.model || this.models[0])
    return super.chat(messages, { ...options, model: modelId })
  }

  /**
   * 重写 streamChat 以适配 Gemini API
   * Gemini 使用 XML 标签 <thought> 来标记思考内容，需要特殊处理
   */
  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: any,
    onEvent: (event: AIStreamEvent) => void
  ): Promise<void> {
    const client = await this.getClient()
    const enableThinking = options?.enableThinking !== false
    const displayName = options?.model || this.models[0]
    const model = this.getModelId(displayName)

    // 构建请求参数
    const requestParams: any = {
      model: model,
      messages: messages,
      temperature: options?.temperature || 0.7,
      stream: true
    }

    if (options?.maxTokens) {
      requestParams.max_tokens = options.maxTokens
    }

    // Gemini 的思考模式控制
    // 注意：reasoning_effort 和 thinking_config 不能同时使用
    // 我们使用 thinking_config 因为它支持 include_thoughts
    const isGemini3 = model.includes('gemini-3')
    const isGemini25 = model.includes('gemini-2.5') || model.includes('gemini-2-5')

    // 使用 extra_body 配置思考模式
    if (isGemini3) {
      // Gemini 3: 使用 thinking_level (low/high)
      requestParams.extra_body = {
        google: {
          thinking_config: {
            thinking_level: enableThinking ? 'low' : 'minimal',
            include_thoughts: true
          }
        }
      }
    } else if (isGemini25) {
      // Gemini 2.5: 使用 thinking_budget (数值)
      requestParams.extra_body = {
        google: {
          thinking_config: {
            thinking_budget: enableThinking ? 8192 : 1024,
            include_thoughts: true
          }
        }
      }
    } else {
      // 其他模型：使用 reasoning_effort
      requestParams.reasoning_effort = enableThinking ? 'medium' : 'none'
    }

    const stream = await client.chat.completions.create(requestParams) as any

    let buffer = ''
    let isInThought = false
    let contentText = ''
    let reasoningText = ''
    let finishReason: string | null = null

    const emitContent = (text: string) => {
      if (!text) return
      contentText += text
      onEvent({ type: 'content_delta', text })
    }

    const emitReasoning = (text: string) => {
      if (!text) return
      reasoningText += text
      onEvent({ type: 'reasoning_delta', text })
    }

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      finishReason = choice?.finish_reason || finishReason
      const delta = choice?.delta
      const content = delta?.content || ''

      if (!content) continue

      buffer += content

      // Gemini 用 <thought>...</thought> 标记思考内容，归一成 reasoning_delta
      while (buffer.length > 0) {
        if (isInThought) {
          const closeIdx = buffer.indexOf('</thought>')
          if (closeIdx === -1) {
            // 可能存在部分结束标签，保留末尾
            const safe = buffer.length > 10 ? buffer.slice(0, buffer.length - 10) : ''
            if (safe) { emitReasoning(safe); buffer = buffer.slice(safe.length) }
            break
          }
          emitReasoning(buffer.slice(0, closeIdx))
          buffer = buffer.slice(closeIdx + '</thought>'.length)
          isInThought = false
        } else {
          const openIdx = buffer.indexOf('<thought>')
          if (openIdx === -1) {
            // 可能存在部分开始标签，保留末尾
            const partialMatch = ['<thought>', '<though', '<thoug', '<thou', '<tho', '<th', '<t', '<'].find(p => buffer.endsWith(p))
            const safe = partialMatch ? buffer.slice(0, buffer.length - partialMatch.length) : buffer
            if (safe) { emitContent(safe); buffer = buffer.slice(safe.length) }
            break
          }
          if (openIdx > 0) { emitContent(buffer.slice(0, openIdx)) }
          buffer = buffer.slice(openIdx + '<thought>'.length)
          isInThought = true
        }
      }
    }

    // 发送剩余 buffer
    if (buffer && !isInThought) emitContent(buffer)
    if (buffer && isInThought) emitReasoning(buffer)

    onEvent({
      type: 'message_done',
      content: contentText,
      reasoningContent: reasoningText || undefined,
      finishReason
    })
  }
}

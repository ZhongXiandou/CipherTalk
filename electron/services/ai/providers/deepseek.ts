import type OpenAI from 'openai'
import { BaseAIProvider, ChatOptions, ChatWithToolsOptions, NativeToolCallResult, normalizeNativeToolCallingError, type AIStreamEvent } from './base'

/**
 * DeepSeek 提供商元数据
 */
export const DeepSeekMetadata = {
  id: 'deepseek',
  name: 'deepseek',
  displayName: 'DeepSeek',
  description: '最便宜的选择，性价比极高',
  models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  pricing: '¥0.001/1K tokens',
  pricingDetail: {
    input: 0.001,   // 0.001元/1K tokens（最便宜）
    output: 0.002
  },
  website: 'https://www.deepseek.com/',
  logo: './AI-logo/deepseek-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  // 兼容历史配置和手动输入，但实际请求不再发送即将弃用的旧模型名
  'DeepSeek V3': 'deepseek-v4-flash',
  'DeepSeek R1 (推理)': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash'
}

/**
 * DeepSeek 提供商
 */
export class DeepSeekProvider extends BaseAIProvider {
  name = DeepSeekMetadata.name
  displayName = DeepSeekMetadata.displayName
  models = DeepSeekMetadata.models
  pricing = DeepSeekMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://api.deepseek.com')
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

  protected getToolRequestExtraParams(options: ChatWithToolsOptions): Record<string, unknown> {
    const enableThinking = options.enableThinking !== false
    return enableThinking
      ? {
          thinking: { type: 'enabled' },
          reasoning_effort: 'high'
        }
      : {
          thinking: { type: 'disabled' }
        }
  }

  private buildRequestParams(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions | undefined,
    stream: boolean
  ) {
    const enableThinking = options?.enableThinking !== false
    const requestParams: any = {
      model: this.getModelId(options?.model || this.models[0]),
      messages,
      max_tokens: options?.maxTokens,
      stream,
      thinking: {
        type: enableThinking ? 'enabled' : 'disabled'
      }
    }

    if (enableThinking) {
      requestParams.reasoning_effort = 'high'
    } else {
      requestParams.temperature = options?.temperature ?? 0.7
    }

    return requestParams
  }

  /**
   * 重写 chat 方法以使用新版 DeepSeek V4 模型和 thinking 参数
   */
  async chat(messages: OpenAI.Chat.ChatCompletionMessageParam[], options?: ChatOptions): Promise<string> {
    const client = await this.getClient()
    const response = await client.chat.completions.create(
      this.buildRequestParams(messages, options, false)
    )

    return response.choices[0]?.message?.content || ''
  }

  async chatWithTools(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatWithToolsOptions
  ): Promise<NativeToolCallResult> {
    const client = await this.getClient()
    const requestParams: any = {
      ...this.buildRequestParams(messages, options, false),
      tools: options.tools,
      tool_choice: options.toolChoice ?? 'auto'
    }

    if (typeof options.parallelToolCalls === 'boolean') {
      requestParams.parallel_tool_calls = options.parallelToolCalls
    }

    try {
      const response = await client.chat.completions.create(requestParams)
      return {
        message: response.choices[0]?.message || { role: 'assistant', content: '' },
        finishReason: response.choices[0]?.finish_reason || null
      }
    } catch (error) {
      throw normalizeNativeToolCallingError(error)
    }
  }

  /**
   * 重写 streamChat 方法以使用新版 DeepSeek V4 模型和 thinking 参数
   */
  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onEvent: (event: AIStreamEvent) => void
  ): Promise<void> {
    const client = await this.getClient()
    const stream = await client.chat.completions.create(
      this.buildRequestParams(messages, options, true)
    ) as any

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

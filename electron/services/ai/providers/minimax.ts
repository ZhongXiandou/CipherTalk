import OpenAI from 'openai'
import { BaseAIProvider, ChatOptions, type AIStreamEvent } from './base'

/**
 * MiniMax 提供商元数据
 *
 * 2026-04-23 对齐官方 OpenAI 兼容文档：
 * - baseURL: https://api.minimaxi.com/v1
 * - reasoning_split=true 时，思考内容单独出现在 reasoning_details 字段
 */
export const MiniMaxMetadata = {
  id: 'minimax',
  name: 'minimax',
  displayName: 'MiniMax',
  description: 'MiniMax OpenAI 兼容文本模型',
  models: [
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.1',
    'MiniMax-M2.1-highspeed',
    'MiniMax-M2'
  ],
  pricing: '¥0.0021/1K tokens 起（估算）',
  pricingDetail: {
    input: 0.0021,
    output: 0.0084
  },
  website: 'https://platform.minimaxi.com/',
  logo: './AI-logo/minimax.svg'
}


function extractIncrementalText(current: string, previous: string): string {
  if (!current) return ''
  if (!previous) return current
  return current.startsWith(previous) ? current.slice(previous.length) : current
}

/**
 * MiniMax 在 OpenAI 兼容接口中支持通过 reasoning_split=true
 * 将思考内容拆到 reasoning_details 字段中。
 */
export class MiniMaxProvider extends BaseAIProvider {
  name = MiniMaxMetadata.name
  displayName = MiniMaxMetadata.displayName
  models = MiniMaxMetadata.models
  pricing = MiniMaxMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://api.minimaxi.com/v1')
  }

  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onEvent: (event: AIStreamEvent) => void
  ): Promise<void> {
    const client = await this.getClient()

    const requestParams: any = {
      model: options?.model || this.models[0],
      messages,
      temperature: options?.temperature || 0.7,
      stream: true,
      extra_body: {
        reasoning_split: true
      }
    }

    if (options?.maxTokens) {
      requestParams.max_tokens = options.maxTokens
    }

    const stream = await client.chat.completions.create(requestParams) as any

    let reasoningBuffer = ''
    let textBuffer = ''
    let contentText = ''
    let reasoningText = ''
    let finishReason: string | null = null

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      finishReason = choice?.finish_reason || finishReason
      const delta = choice?.delta
      if (!delta) continue

      const reasoningDetails = Array.isArray(delta.reasoning_details)
        ? delta.reasoning_details
        : []

      if (reasoningDetails.length > 0) {
        for (const detail of reasoningDetails) {
          const detailText = typeof detail?.text === 'string' ? detail.text : ''
          const newReasoning = extractIncrementalText(detailText, reasoningBuffer)
          reasoningBuffer = detailText || reasoningBuffer
          if (newReasoning) {
            reasoningText += newReasoning
            onEvent({ type: 'reasoning_delta', text: newReasoning })
          }
        }
      } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        const newReasoning = extractIncrementalText(delta.reasoning_content, reasoningBuffer)
        reasoningBuffer = delta.reasoning_content
        if (newReasoning) {
          reasoningText += newReasoning
          onEvent({ type: 'reasoning_delta', text: newReasoning })
        }
      }

      if (typeof delta.content === 'string' && delta.content) {
        const newContent = extractIncrementalText(delta.content, textBuffer)
        textBuffer = delta.content
        if (newContent) {
          contentText += newContent
          onEvent({ type: 'content_delta', text: newContent })
        }
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

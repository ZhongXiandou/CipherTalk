import { BaseAIProvider } from './base'

/**
 * OpenAI提供商元数据
 */
export const OpenAIMetadata = {
  id: 'openai',
  name: 'openai',
  displayName: 'OpenAI',
  description: '全球领先的AI服务提供商',
  models: [
    'GPT 5.5 Pro',
    'GPT 5.5',
    'GPT 5.4 Pro',
    'GPT 5.4',
    'GPT 5.4 Mini',
    'GPT 5.4 Nano',
    'GPT 5.2',
    'GPT 5.2 Pro',
    'GPT 5 Mini',
    'GPT 5 Nano',
    'GPT 5',
    'GPT 4.1',
    'o3 Deep Research',
    'o4 Mini Deep Research'
  ],
  pricing: '按量计费',
  pricingDetail: {
    input: 0.0025,     // gpt-4o 输入价格 $2.5/1M tokens
    output: 0.01       // gpt-4o 输出价格 $10/1M tokens
  },
  website: 'https://openai.com/',
  logo: './AI-logo/openai.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  'GPT 5.5 Pro': 'gpt-5.5-pro-2026-04-23',
  'GPT 5.5': 'gpt-5.5-2026-04-23',
  'GPT 5.4 Pro': 'gpt-5.4-pro-2026-03-05',
  'GPT 5.4': 'gpt-5.4-2026-03-05',
  'GPT 5.4 Mini': 'gpt-5.4-mini-2026-03-17',
  'GPT 5.4 Nano': 'gpt-5.4-nano-2026-03-17',
  'GPT 5.2': 'gpt-5.2-2025-12-11',
  'GPT 5.2 Pro': 'gpt-5.2-pro-2025-12-11',
  'GPT 5 Mini': 'gpt-5-mini-2025-08-07',
  'GPT 5 Nano': 'gpt-5-nano-2025-08-07',
  'GPT 5': 'gpt-5-2025-08-07',
  'GPT 4.1': 'gpt-4.1-2025-04-14',
  'o3 Deep Research': 'o3-deep-research-2025-06-26',
  'o4 Mini Deep Research': 'o4-mini-deep-research-2025-06-26'
}

/**
 * OpenAI提供商
 */
export class OpenAIProvider extends BaseAIProvider {
  name = OpenAIMetadata.name
  displayName = OpenAIMetadata.displayName
  models = OpenAIMetadata.models
  pricing = OpenAIMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://api.openai.com/v1')
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
   * 重写 streamChat 方法以使用映射后的模型ID
   */
  async streamChat(messages: any[], options: any, onEvent: (event: import('./base').AIStreamEvent) => void): Promise<void> {
    const modelId = this.getModelId(options?.model || this.models[0])
    return super.streamChat(messages, { ...options, model: modelId }, onEvent)
  }
}

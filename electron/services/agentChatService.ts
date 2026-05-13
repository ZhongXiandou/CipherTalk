import { aiService } from './ai/aiService'
import type { AIStreamEvent, AIStreamToolCall, NativeToolCallResult, NativeToolDefinition } from './ai/providers/base'

export interface AgentChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_call_id?: string
  name?: string
  tool_calls?: AIStreamToolCall[]
}

export interface McpToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface AgentChatOptions {
  history: AgentChatMessage[]
  message: string
  provider: string
  apiKey: string
  model: string
  enableThinking?: boolean
  systemPrompt?: string
  signal?: AbortSignal
  onStreamEvent: (event: AIStreamEvent) => void
  enabledTools?: McpToolDef[]
  mcpCallTool?: (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<{ success: boolean; result?: unknown; error?: string }>
}


const MAX_TOOL_CALLS = 24

function buildMessages(options: AgentChatOptions): AgentChatMessage[] {
  const msgs: AgentChatMessage[] = []
  if (options.systemPrompt) msgs.push({ role: 'system', content: options.systemPrompt })
  msgs.push(...options.history)
  msgs.push({ role: 'user', content: options.message })
  return msgs
}

function toOpenAI(messages: AgentChatMessage[]) {
  return messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'tool' as const, tool_call_id: m.tool_call_id ?? '', content: m.content, ...(m.name ? { name: m.name } : {}) }
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return { role: 'assistant' as const, content: m.content || null, tool_calls: m.tool_calls }
    }
    return { role: m.role as 'user' | 'assistant' | 'system', content: m.content }
  })
}

function splitToolName(name: string): { serverName: string; toolName: string } {
  const idx = name.indexOf('__')
  if (idx === -1) return { serverName: '', toolName: name }
  return { serverName: name.slice(0, idx), toolName: name.slice(idx + 2) }
}

async function runStreamingOnly(
  options: AgentChatOptions,
  messages: AgentChatMessage[]
): Promise<string> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const provider = aiService.getProvider(options.provider, options.apiKey)
  let fullText = ''
  try {
    await provider.streamChat(
      toOpenAI(messages),
      { model: options.model, enableThinking: options.enableThinking !== false },
      event => {
        if (event.type === 'content_delta') fullText += event.text
        options.onStreamEvent(event)
      }
    )
  } catch (err) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    throw err
  }
  return fullText
}

async function runToolLoop(
  options: AgentChatOptions,
  messages: AgentChatMessage[]
): Promise<string> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const provider = aiService.getProvider(options.provider, options.apiKey)
  const tools: NativeToolDefinition[] = (options.enabledTools ?? []).map(t => ({
    type: 'function',
    function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters ?? {} }
  }))

  let loopMsgs = [...messages]
  let lastText = ''

  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    let iterText = ''
    let result: NativeToolCallResult
    let streamedToolDone = false

    const chatOptions = { model: options.model, tools, enableThinking: options.enableThinking !== false }
    try {
      if (provider.streamChatWithTools) {
        result = await provider.streamChatWithTools(
          toOpenAI(loopMsgs),
          chatOptions,
          event => {
            if (event.type === 'content_delta') iterText += event.text
            if (event.type === 'tool_call_done') streamedToolDone = true
            options.onStreamEvent(event)
          }
        )
      } else {
        result = await provider.chatWithTools(toOpenAI(loopMsgs), { model: options.model, tools })
      }
    } catch (err) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      throw err
    }

    const assistantText = iterText || (typeof result.message.content === 'string' ? result.message.content : '') || ''
    lastText = assistantText

    const toolCalls = result.message.tool_calls
    if (!toolCalls || toolCalls.length === 0) return assistantText

    if (!streamedToolDone) {
      toolCalls.forEach((toolCall) => {
        options.onStreamEvent({ type: 'tool_call_done', toolCall: toolCall as AIStreamToolCall })
      })
    }

    loopMsgs.push({ role: 'assistant', content: assistantText, tool_calls: toolCalls as AIStreamToolCall[] })

    for (const tc of toolCalls) {
      const compoundName = tc.function?.name ?? ''
      const { serverName, toolName } = splitToolName(compoundName)
      let args: Record<string, unknown> = {}
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {} } catch { args = {} }

      let toolResult: unknown = null
      let toolError: string | undefined
      try {
        if (options.mcpCallTool) {
          const r = await options.mcpCallTool(serverName, toolName, args)
          toolResult = r.success ? (r.result ?? null) : { error: r.error }
          toolError = r.success ? undefined : r.error
        } else {
          toolError = 'mcpCallTool not provided'
          toolResult = { error: toolError }
        }
      } catch (err) {
        toolError = err instanceof Error ? err.message : String(err)
        toolResult = { error: toolError }
      }

      options.onStreamEvent({
        type: 'tool_result',
        toolCallId: tc.id,
        toolName: compoundName,
        result: toolResult,
        error: toolError
      })
      loopMsgs.push({ role: 'tool', tool_call_id: tc.id ?? '', name: compoundName, content: JSON.stringify(toolResult) })
    }
  }

  return lastText
}

export const agentChatService = {
  async sendMessage(options: AgentChatOptions): Promise<string> {
    const messages = buildMessages(options)
    if (Array.isArray(options.enabledTools) && options.enabledTools.length > 0) {
      return runToolLoop(options, messages)
    }
    return runStreamingOnly(options, messages)
  }
}

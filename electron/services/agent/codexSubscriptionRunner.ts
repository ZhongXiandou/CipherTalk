import { asSchema, generateId, type ModelMessage, type ToolSet, type UIMessageChunk } from 'ai'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { CodexAppServerClient, type CodexAppServerMessage } from '../ai/codexAppServerClient'
import { isImageGenAvailable } from '../ai/imageGenService'
import { buildAgentInstructions } from './engine'
import { withToolTimeouts } from './guards'
import { reportAgentProgress, withAgentProgress } from './progress'
import { getCachedStartupMemory, warmStartupMemory } from './runtimeCache'
import { buildAgentToolApproval } from './toolApproval'
import { buildCodeOnlyTools, buildPlanModeTools, buildTools } from './tools'
import { afterTurnMemory, buildMemoryContext, preloadRelevantMemories } from './tools/memory'
import type { AgentProgressReporter, AgentRunInput, AgentTraceMetadata } from './types'

type DynamicToolCall = {
  threadId: string
  turnId: string
  callId: string
  namespace: string | null
  tool: string
  arguments: unknown
}

type PendingApproval = {
  resolve: (approved: boolean) => void
  runId: string
}

export type CodexSubscriptionToolLoopResult = {
  text: string
  toolCalls: number
  toolOutputs: unknown[]
}

const pendingApprovals = new Map<string, PendingApproval>()
const CODEX_RUN_TIMEOUT_MS = 3_600_000

export async function runCodexSubscriptionText(
  input: {
    providerConfig: AgentRunInput['providerConfig']
    instructions: string
    messages: ModelMessage[]
    outputSchema?: unknown
  },
  signal?: AbortSignal,
): Promise<string> {
  const result = await runCodexSubscriptionToolLoop({
    ...input,
    tools: {},
  }, signal)
  return result.text
}

export async function runCodexSubscriptionToolLoop(
  input: {
    providerConfig: AgentRunInput['providerConfig']
    instructions: string
    messages: ModelMessage[]
    tools: ToolSet
    outputSchema?: unknown
    maxToolCalls?: number
  },
  signal?: AbortSignal,
): Promise<CodexSubscriptionToolLoopResult> {
  const client = new CodexAppServerClient()
  let threadId = ''
  let turnId = ''
  let text = ''
  let turnError = ''
  let toolCalls = 0
  let resolveTurn: (() => void) | null = null
  let rejectTurn: ((error: Error) => void) | null = null
  const streamedTextItems = new Set<string>()
  const executedToolNames = new Set<string>()
  const toolOutputs: unknown[] = []
  const specs = await dynamicToolSpecs(input.tools)
  const completed = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve
    rejectTurn = reject
  })
  client.onNotification((message) => {
    const params = message.params || {}
    if (threadId && params.threadId && params.threadId !== threadId) return
    if (turnId && params.turnId && params.turnId !== turnId) return
    if (message.method === 'turn/started') turnId = String(params.turn?.id || turnId)
    if (message.method === 'item/agentMessage/delta') {
      streamedTextItems.add(String(params.itemId || 'codex-text'))
      text += String(params.delta || '')
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const itemId = String(params.item.id || '')
      if (!streamedTextItems.has(itemId) && params.item.text) text += String(params.item.text)
    }
    if (message.method === 'error' && params.willRetry !== true) {
      turnError = String(params.error?.message || 'Codex 请求失败')
    }
    if (message.method === 'turn/completed') {
      const errorMessage = String(params.turn?.error?.message || turnError || '')
      if (params.turn?.status === 'failed' || errorMessage) rejectTurn?.(new Error(errorMessage || 'Codex turn 执行失败'))
      else resolveTurn?.()
    }
  })
  client.setServerRequestHandler(async (message) => {
    if (message.method !== 'item/tool/call') return rejectBuiltInRequest(message)
    const call = message.params as DynamicToolCall
    const toolName = String(call.tool || '')
    const definition = input.tools[toolName] as any
    if (!definition || typeof definition.execute !== 'function') throw new Error(`Codex 请求了未知工具: ${toolName}`)

    toolCalls += 1
    if (input.maxToolCalls && toolCalls > input.maxToolCalls) {
      return {
        contentItems: [{ type: 'inputText', text: `已达到最多 ${input.maxToolCalls} 次工具调用，请直接根据现有结果作答。` }],
        success: false,
      }
    }

    const toolCallId = String(call.callId || generateId())
    const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {}
    try {
      const querySqlUnlocked = Array.from(executedToolNames).some((name) => [
        'search_messages', 'semantic_search', 'chat_stats', 'get_timeline', 'get_context',
        'list_groups', 'group_members', 'group_member_ranking', 'search_moments', 'moments_stats',
      ].includes(name))
      let output = await definition.execute(args, {
        toolCallId,
        messages: input.messages,
        abortSignal: signal,
        context: { querySqlUnlocked },
      })
      if (isAsyncIterable(output)) {
        let lastOutput: unknown
        for await (const partial of output) lastOutput = partial
        output = lastOutput
      }
      executedToolNames.add(toolName)
      toolOutputs.push(output)
      return { contentItems: [{ type: 'inputText', text: toolResultText(output) }], success: true }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      return { contentItems: [{ type: 'inputText', text: `工具执行失败: ${messageText}` }], success: false }
    }
  })

  try {
    await client.start()
    const account = await client.request<any>('account/read', { refreshToken: true })
    if (account?.account?.type !== 'chatgpt') throw new Error('请先在设置中登录 ChatGPT 账号')
    const runtimeDir = path.join(tmpdir(), 'ciphertalk-codex-runtime')
    mkdirSync(runtimeDir, { recursive: true })
    const current = currentUserInputs(input.messages)
    const history = conversationHistory(input.messages, current.index)
    const thread = await client.request<any>('thread/start', {
      model: input.providerConfig.model || null,
      cwd: runtimeDir,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: input.instructions,
      developerInstructions: history || null,
      ephemeral: true,
      environments: [],
      selectedCapabilityRoots: [],
      dynamicTools: specs,
      config: {
        'features.shell_tool': false,
        'features.unified_exec': false,
        'features.multi_agent': false,
        'features.apps': false,
        'features.memories': false,
        mcp_servers: {},
        web_search: 'disabled',
      },
    })
    threadId = String(thread?.thread?.id || '')
    if (!threadId) throw new Error('Codex App Server 未返回 threadId')
    const turn = await client.request<any>('turn/start', {
      threadId,
      input: current.inputs,
      model: input.providerConfig.model || null,
      effort: input.providerConfig.reasoningEffort || null,
      outputSchema: input.outputSchema || null,
    })
    turnId = String(turn?.turn?.id || turnId)
    const timeout = setTimeout(() => rejectTurn?.(new Error('Codex 请求超时')), CODEX_RUN_TIMEOUT_MS)
    const abort = () => {
      if (threadId && turnId) void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      rejectTurn?.(new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    try {
      await completed
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    return { text: text.trim(), toolCalls, toolOutputs }
  } finally {
    client.dispose()
  }
}

export function resolveCodexToolApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(approvalId)
  if (!pending) return false
  pendingApprovals.delete(approvalId)
  pending.resolve(approved)
  return true
}

function lastUserText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    return contentText(message.content)
  }
  return ''
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : jsonText(content)
  return content.map((part) => {
    if (!part || typeof part !== 'object') return String(part ?? '')
    const item = part as Record<string, unknown>
    if (item.type === 'text') return String(item.text || '')
    if (item.type === 'reasoning') return String(item.text || '')
    if (item.type === 'tool-call') return `[工具调用 ${String(item.toolName || '')}] ${jsonText(item.input)}`
    if (item.type === 'tool-result') return `[工具结果 ${String(item.toolName || '')}] ${jsonText(item.output)}`
    if (item.type === 'file' || item.type === 'image') return `[附件 ${String(item.mediaType || item.type)}]`
    return jsonText(item)
  }).filter(Boolean).join('\n')
}

function conversationHistory(messages: ModelMessage[], currentUserIndex: number): string {
  return messages
    .slice(0, currentUserIndex)
    .map((message) => `${message.role.toUpperCase()}:\n${contentText(message.content)}`)
    .filter((item) => !item.endsWith(':\n'))
    .join('\n\n')
}

function asDataUrl(value: unknown, mediaType = 'application/octet-stream'): string | null {
  if (typeof value === 'string') return value
  if (value instanceof URL) return value.href
  if (value instanceof Uint8Array) return `data:${mediaType};base64,${Buffer.from(value).toString('base64')}`
  return null
}

function currentUserInputs(messages: ModelMessage[]): { index: number; inputs: Array<Record<string, unknown>> } {
  let index = -1
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'user') {
      index = cursor
      break
    }
  }
  if (index < 0) return { index: messages.length, inputs: [{ type: 'text', text: '请继续。', text_elements: [] }] }

  const content = messages[index].content
  if (typeof content === 'string') {
    return { index, inputs: [{ type: 'text', text: content, text_elements: [] }] }
  }

  const inputs: Array<Record<string, unknown>> = []
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const item = part as Record<string, unknown>
      if (item.type === 'text') {
        const text = String(item.text || '')
        if (text) inputs.push({ type: 'text', text, text_elements: [] })
        continue
      }
      if (item.type === 'image') {
        const url = asDataUrl(item.image, String(item.mediaType || 'image/png'))
        if (url) inputs.push({ type: 'image', url })
        continue
      }
      if (item.type === 'file' && String(item.mediaType || '').startsWith('image/')) {
        const url = asDataUrl(item.data, String(item.mediaType || 'image/png'))
        if (url) inputs.push({ type: 'image', url })
      }
    }
  }
  if (inputs.length === 0) inputs.push({ type: 'text', text: contentText(content) || '请继续。', text_elements: [] })
  return { index, inputs }
}

async function dynamicToolSpecs(tools: ToolSet): Promise<Array<Record<string, unknown>>> {
  const specs: Array<Record<string, unknown>> = []
  for (const [name, definition] of Object.entries(tools)) {
    if (!definition || typeof (definition as any).execute !== 'function') continue
    const description = typeof (definition as any).description === 'string'
      ? (definition as any).description
      : `调用密语工具 ${name}`
    const schema = await asSchema((definition as any).inputSchema).jsonSchema
    specs.push({ type: 'function', name, description, inputSchema: schema })
  }
  return specs
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof (value as any)[Symbol.asyncIterator] === 'function')
}

async function waitForApproval(approvalId: string, runId: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const finish = (approved: boolean) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(approved)
    }
    const onAbort = () => {
      pendingApprovals.delete(approvalId)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    pendingApprovals.set(approvalId, { resolve: finish, runId })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function cleanupApprovals(runId: string): void {
  for (const [approvalId, pending] of pendingApprovals.entries()) {
    if (pending.runId !== runId) continue
    pendingApprovals.delete(approvalId)
    pending.resolve(false)
  }
}

function toolResultText(output: unknown): string {
  if (typeof output === 'string') return output
  return jsonText(output)
}

function usageMetadata(tokenUsage: any): Record<string, unknown> | undefined {
  const usage = tokenUsage?.last || tokenUsage?.total
  if (!usage) return undefined
  return {
    inputTokens: Number(usage.inputTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    totalTokens: Number(usage.totalTokens) || 0,
    inputTokenDetails: { cacheReadTokens: Number(usage.cachedInputTokens) || 0 },
    outputTokenDetails: { reasoningTokens: Number(usage.reasoningOutputTokens) || 0 },
  }
}

function rejectBuiltInRequest(message: Required<Pick<CodexAppServerMessage, 'id' | 'method'>> & CodexAppServerMessage): unknown {
  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
    return { decision: 'decline' }
  }
  throw new Error(`密语不允许 Codex 调用内置能力: ${message.method}`)
}

export async function runCodexSubscriptionAgent(
  input: AgentRunInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
  onProgress?: AgentProgressReporter,
): Promise<void> {
  await withAgentProgress(onProgress, async () => {
    const runId = `codex-${Date.now()}-${generateId()}`
    const startedAt = Date.now()
    const trace: AgentTraceMetadata = {
      startedAt,
      stepCount: 0,
      toolCount: 0,
      steps: [],
      tools: [],
    }
    const userText = lastUserText(input.messages)
    const historyManagedTurnContext = input.turnContextMode === 'history'
    const cachedMemoryContext = historyManagedTurnContext ? '' : getCachedStartupMemory(input.scope)
    const memoryContext = cachedMemoryContext ?? ''
    if (!historyManagedTurnContext && cachedMemoryContext === null) warmStartupMemory(input.scope, () => buildMemoryContext(input.scope))
    const relevantMemoryContext = historyManagedTurnContext ? '' : await preloadRelevantMemories(userText, input.scope)
    const toolsDisabled = input.toolMode === 'disabled'
    const imageGenOn = !toolsDisabled && isImageGenAvailable()
    const toolProfile = input.toolProfile ?? (input.codeWorkspace ? 'hybrid' : 'chat')
    const codeWorkspace = (toolProfile === 'code' || toolProfile === 'hybrid') ? (input.codeWorkspace ?? null) : null
    const applicationTools: ToolSet = toolsDisabled
      ? {}
      : input.planMode
        ? buildPlanModeTools(input.scope, codeWorkspace)
        : toolProfile === 'code'
          ? buildCodeOnlyTools(codeWorkspace, imageGenOn)
          : buildTools(input.scope, input.providerConfig, input.mcpTools, imageGenOn, codeWorkspace, {
            allowWechatReplyMedia: input.allowWechatReplyMedia === true,
            uploadedMediaContext: input.uploadedMediaContext,
            canvasContext: input.canvasContext,
            emitChunk: onChunk,
          })
    const tools = withToolTimeouts(applicationTools)
    const prepared = buildAgentInstructions(
      input,
      memoryContext,
      relevantMemoryContext,
      tools,
      !toolsDisabled && !input.planMode,
      imageGenOn,
    )
    const specs = await dynamicToolSpecs(prepared.tools)
    const approval = buildAgentToolApproval(input, input.mcpTools?.map((item) => item.name) ?? [])
    const executedToolNames = new Set<string>()
    const client = new CodexAppServerClient()
    let threadId = ''
    let turnId = ''
    let turnError = ''
    let tokenUsage: any
    let assistantText = ''
    let turnResolve: (() => void) | null = null
    let turnReject: ((error: Error) => void) | null = null
    const textItems = new Set<string>()
    const reasoningItems = new Set<string>()
    const completedTextItems = new Set<string>()

    const closeTextItem = (itemId: string) => {
      if (!textItems.has(itemId) || completedTextItems.has(itemId)) return
      completedTextItems.add(itemId)
      onChunk({ type: 'text-end', id: itemId })
    }

    client.onNotification((message) => {
      const params = message.params || {}
      if (threadId && params.threadId && params.threadId !== threadId) return
      if (turnId && params.turnId && params.turnId !== turnId) return
      if (message.method === 'turn/started') {
        turnId = String(params.turn?.id || turnId)
        return
      }
      if (message.method === 'item/agentMessage/delta') {
        const itemId = String(params.itemId || 'codex-text')
        const delta = String(params.delta || '')
        if (!textItems.has(itemId)) {
          textItems.add(itemId)
          onChunk({ type: 'text-start', id: itemId })
        }
        assistantText += delta
        onChunk({ type: 'text-delta', id: itemId, delta })
        return
      }
      if (message.method === 'item/reasoning/summaryTextDelta' || message.method === 'item/reasoning/textDelta') {
        const itemId = String(params.itemId || 'codex-reasoning')
        if (!reasoningItems.has(itemId)) {
          reasoningItems.add(itemId)
          onChunk({ type: 'reasoning-start', id: itemId })
        }
        onChunk({ type: 'reasoning-delta', id: itemId, delta: String(params.delta || '') })
        return
      }
      if (message.method === 'item/completed') {
        const item = params.item || {}
        const itemId = String(item.id || '')
        if (item.type === 'agentMessage') {
          if (!textItems.has(itemId) && item.text) {
            textItems.add(itemId)
            assistantText += String(item.text)
            onChunk({ type: 'text-start', id: itemId })
            onChunk({ type: 'text-delta', id: itemId, delta: String(item.text) })
          }
          closeTextItem(itemId)
        }
        if (item.type === 'reasoning' && reasoningItems.has(itemId)) {
          reasoningItems.delete(itemId)
          onChunk({ type: 'reasoning-end', id: itemId })
        }
        return
      }
      if (message.method === 'thread/tokenUsage/updated') {
        tokenUsage = params.tokenUsage
        return
      }
      if (message.method === 'error' && params.willRetry !== true) {
        turnError = String(params.error?.message || 'Codex 请求失败')
        return
      }
      if (message.method === 'turn/completed') {
        const errorMessage = String(params.turn?.error?.message || turnError || '')
        if (params.turn?.status === 'failed' || errorMessage) turnReject?.(new Error(errorMessage || 'Codex turn 执行失败'))
        else turnResolve?.()
      }
    })

    client.setServerRequestHandler(async (message) => {
      if (message.method !== 'item/tool/call') return rejectBuiltInRequest(message)
      const call = message.params as DynamicToolCall
      const toolName = String(call.tool || '')
      const definition = prepared.tools[toolName] as any
      if (!definition || typeof definition.execute !== 'function') throw new Error(`Codex 请求了未知工具: ${toolName}`)

      const toolCallId = String(call.callId || generateId())
      const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {}
      onChunk({ type: 'tool-input-start', toolCallId, toolName })
      onChunk({ type: 'tool-input-available', toolCallId, toolName, input: args })

      const approvalStatus = approval?.({
        toolCall: { toolCallId, toolName, input: args },
      } as any)
      if (approvalStatus?.type === 'user-approval') {
        const approvalId = `codex-${generateId()}`
        onChunk({ type: 'tool-approval-request', approvalId, toolCallId })
        const approved = await waitForApproval(approvalId, runId, signal)
        onChunk({ type: 'tool-approval-response', approvalId, approved })
        if (!approved) {
          onChunk({ type: 'tool-output-denied', toolCallId })
          return { contentItems: [{ type: 'inputText', text: '用户拒绝了该工具调用。' }], success: false }
        }
      }

      const toolStartedAt = Date.now()
      try {
        const querySqlUnlocked = Array.from(executedToolNames).some((name) => [
          'search_messages', 'semantic_search', 'chat_stats', 'get_timeline', 'get_context',
          'list_groups', 'group_members', 'group_member_ranking', 'search_moments', 'moments_stats',
        ].includes(name))
        let output = await definition.execute(args, {
          toolCallId,
          messages: input.messages,
          abortSignal: signal,
          context: { querySqlUnlocked },
        })
        if (isAsyncIterable(output)) {
          let lastOutput: unknown
          for await (const partial of output) {
            lastOutput = partial
            onChunk({ type: 'tool-output-available', toolCallId, output: partial, preliminary: true })
          }
          output = lastOutput
        }
        executedToolNames.add(toolName)
        trace.tools.push({ toolCallId, toolName, elapsedMs: Date.now() - toolStartedAt })
        trace.toolCount = trace.tools.length
        onChunk({ type: 'tool-output-available', toolCallId, output })
        return { contentItems: [{ type: 'inputText', text: toolResultText(output) }], success: true }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error)
        trace.tools.push({ toolCallId, toolName, elapsedMs: Date.now() - toolStartedAt, error: messageText })
        trace.toolCount = trace.tools.length
        onChunk({ type: 'tool-output-error', toolCallId, errorText: messageText })
        return { contentItems: [{ type: 'inputText', text: `工具执行失败: ${messageText}` }], success: false }
      }
    })

    const runtimeDir = path.join(tmpdir(), 'ciphertalk-codex-runtime')
    mkdirSync(runtimeDir, { recursive: true })
    const current = currentUserInputs(input.messages)
    const history = conversationHistory(input.messages, current.index)
    const instructionText = prepared.instructions.map((message) => contentText(message.content)).filter(Boolean).join('\n\n')
    const turnContext = prepared.turnMessage ? contentText(prepared.turnMessage.content) : ''
    const developerInstructions = [
      history ? `以下是本次对话在密语中的既有历史。保持上下文连续，但不要复述这些标签：\n\n${history}` : '',
      turnContext,
      '只使用本线程提供的密语动态工具。不要调用终端、文件修改、插件、子代理或其他 Codex 内置工具。',
    ].filter(Boolean).join('\n\n')

    reportAgentProgress({ stage: 'run_started', title: 'ChatGPT 订阅模型准备中', category: 'prep' })
    onChunk({ type: 'start', messageId: generateId() })
    onChunk({ type: 'start-step' })

    try {
      await client.start()
      const account = await client.request<any>('account/read', { refreshToken: true })
      if (account?.account?.type !== 'chatgpt') throw new Error('请先在设置中登录 ChatGPT 账号')

      const thread = await client.request<any>('thread/start', {
        model: input.providerConfig.model || null,
        cwd: runtimeDir,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: instructionText,
        developerInstructions,
        personality: null,
        ephemeral: true,
        environments: [],
        selectedCapabilityRoots: [],
        dynamicTools: specs,
        config: {
          'features.shell_tool': false,
          'features.unified_exec': false,
          'features.multi_agent': false,
          'features.apps': false,
          'features.memories': false,
          mcp_servers: {},
          web_search: 'disabled',
        },
      })
      threadId = String(thread?.thread?.id || '')
      if (!threadId) throw new Error('Codex App Server 未返回 threadId')

      const completed = new Promise<void>((resolve, reject) => {
        turnResolve = resolve
        turnReject = reject
      })
      const turn = await client.request<any>('turn/start', {
        threadId,
        input: current.inputs,
        model: input.providerConfig.model || null,
        effort: input.providerConfig.reasoningEffort || null,
      })
      turnId = String(turn?.turn?.id || turnId)

      const timeout = setTimeout(() => turnReject?.(new Error('Codex Agent 运行超时')), CODEX_RUN_TIMEOUT_MS)
      const abort = () => {
        if (threadId && turnId) void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
        turnReject?.(new DOMException('Aborted', 'AbortError'))
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      try {
        await completed
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
      }

      for (const itemId of textItems) closeTextItem(itemId)
      for (const itemId of reasoningItems) onChunk({ type: 'reasoning-end', id: itemId })
      trace.finishedAt = Date.now()
      trace.totalElapsedMs = trace.finishedAt - startedAt
      trace.stepCount = Math.max(1, trace.tools.length + 1)
      onChunk({ type: 'finish-step' })
      onChunk({
        type: 'finish',
        finishReason: 'stop',
        messageMetadata: {
          usage: usageMetadata(tokenUsage),
          finishReason: 'stop',
          modelProvider: input.providerConfig.name,
          modelId: input.providerConfig.model,
          ciphertalk: { trace },
          ...(input.planMode ? { planMode: true } : {}),
        },
      })
      reportAgentProgress({ stage: 'run_finished', title: '回答生成完成' })
      if (assistantText && !signal?.aborted) {
        void afterTurnMemory({
          scope: input.scope,
          providerConfig: input.providerConfig,
          userText,
          assistantText,
          signal,
        }).catch(() => undefined)
      }
    } finally {
      cleanupApprovals(runId)
      client.dispose()
    }
  })
}

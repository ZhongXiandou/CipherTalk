/**
 * 编排引擎 —— 用 AI SDK 的 ToolLoopAgent 跑 ReAct 循环，流式产出 UIMessageChunk。
 * 运行在 AI utilityProcess 子进程内（见文档 §3.1/§5.2）。
 */
import { generateText, smoothStream, tool, ToolLoopAgent, stepCountIs, type ModelMessage, type UIMessageChunk } from 'ai'
import { z } from 'zod'
import type { SystemModelMessage } from '@ai-sdk/provider-utils'
import { createLanguageModel } from './provider'
import { buildAgentPromptParts, CODE_WORKSPACE_PROMPT, IMAGE_GEN_PROMPT, PLAN_MODE_PROMPT, WEB_SEARCH_PROMPT } from './prompts'
import { isWebSearchAvailable } from '../ai/webSearchService'
import { isImageGenAvailable } from '../ai/imageGenService'
import { applyAnthropicCacheControl, buildPromptCacheKey, buildProviderOptions } from './cache'
import { buildCodeOnlyTools, buildPlanModeTools, buildTools } from './tools'
import { afterTurnMemory, buildMemoryContext, preloadRelevantMemories } from './tools/memory'
import { aiCompactStep, createCompactionState } from './aiCompaction'
import { loopGuardCondition, withToolTimeouts } from './guards'
import { reportAgentProgress, withAgentProgress } from './progress'
import { getCachedStartupMemory, warmStartupMemory } from './runtimeCache'
import { buildToolRuntimeContext } from './toolPolicy'
import { currentModelVisionSupport } from './tools/mediaHistory'
import { detectImageMime } from '../media/mediaResolver'
import { formatAgentError } from './errorFormat'
import type { AgentMcpToolDescriptor, AgentProgressReporter, AgentProviderConfig, AgentRunInput, AgentSkillContextItem, AgentToolProfile } from './types'
import type { CodeWorkspaceRef } from './codeWorkspaceTypes'

const MAX_STEPS = 24
const DEFAULT_AGENT_TEMPERATURE = 0.2
const REPLY_DEEP_MAX_STEPS = 10

type SegmenterLike = {
  segment(input: string): Iterable<unknown>
}

function createSmoothStreamChunker(): 'word' | SegmenterLike {
  const segmenterCtor = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: 'grapheme' | 'word' | 'sentence' }) => SegmenterLike
  }).Segmenter
  return segmenterCtor ? new segmenterCtor('zh', { granularity: 'word' }) : 'word'
}

export function buildAgentInstructions(
  input: AgentRunInput,
  memoryContext: string,
  relevantMemoryContext: string,
  tools: ReturnType<typeof buildTools>,
  webSearchOn = false,
  imageGenOn = false,
): { instructions: SystemModelMessage[]; tools: ReturnType<typeof buildTools>; promptCacheKey: string } {
  const promptParts = buildAgentPromptParts(input.scope, input.skills, {
    includeWechatOutbound: input.outputMode === 'wechat',
    includeWechatReplyMedia: input.allowWechatReplyMedia === true,
  })
  const dynamicSystem = [
    promptParts.dynamicSystem,
    input.planMode ? PLAN_MODE_PROMPT : '',
    input.codeWorkspace ? CODE_WORKSPACE_PROMPT : '',
    webSearchOn ? WEB_SEARCH_PROMPT : '',
    imageGenOn ? IMAGE_GEN_PROMPT : '',
    memoryContext,
    relevantMemoryContext,
  ].filter(Boolean).join('\n')
  const instructions: SystemModelMessage[] = [
    { role: 'system', content: promptParts.cacheableSystem },
    ...(dynamicSystem ? [{ role: 'system' as const, content: dynamicSystem }] : []),
  ]
  const promptCacheKey = buildPromptCacheKey(promptParts, tools)

  if (input.providerConfig.providerKind === 'anthropic') {
    const cached = applyAnthropicCacheControl(instructions, tools)
    return { instructions: cached.messages, tools: cached.tools, promptCacheKey }
  }

  return { instructions, tools, promptCacheKey }
}

/** 取最后一条 user 消息的纯文本，供 L1 自动抽取。 */
function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => (p && typeof p === 'object' && 'type' in p && (p as { type?: unknown }).type === 'text'
          ? String((p as { text?: unknown }).text || '')
          : ''))
        .filter(Boolean)
        .join('\n')
    }
    return ''
  }
  return ''
}

function trackToolChunk(
  chunk: UIMessageChunk,
  toolNames: Map<string, string>,
  pendingToolCalls?: Map<string, { toolName: string; input?: unknown }>,
): void {
  if ('toolCallId' in chunk && 'toolName' in chunk && typeof chunk.toolCallId === 'string' && typeof chunk.toolName === 'string') {
    toolNames.set(chunk.toolCallId, chunk.toolName)
  }
  if (chunk.type === 'tool-input-available') {
    pendingToolCalls?.set(chunk.toolCallId, { toolName: chunk.toolName, input: chunk.input })
    return
  }
  if (
    chunk.type === 'tool-input-error' ||
    chunk.type === 'tool-output-error' ||
    chunk.type === 'tool-output-denied'
  ) {
    pendingToolCalls?.delete(chunk.toolCallId)
    return
  }
  if (chunk.type !== 'tool-output-available') return
  pendingToolCalls?.delete(chunk.toolCallId)
}

function withCacheHitRate(usage: unknown): unknown {
  if (!usage || typeof usage !== 'object') return usage
  const inputTokens = Number((usage as { inputTokens?: unknown }).inputTokens)
  const details = (usage as { inputTokenDetails?: { cacheReadTokens?: unknown } }).inputTokenDetails
  const cacheReadTokens = Number(details?.cacheReadTokens)
  const cacheHitRate = Number.isFinite(inputTokens) && inputTokens > 0 && Number.isFinite(cacheReadTokens)
    ? cacheReadTokens / inputTokens
    : undefined
  return cacheHitRate === undefined ? usage : { ...(usage as Record<string, unknown>), cacheHitRate }
}

/**
 * L1 自动记忆：主回答流完后抽取稳定事实写库，并把每条写入作为合成 auto_memory 工具 part 注入思考链
 * （static 工具形态 tool-input/output-available，前端 isToolUIPart 可识别）。失败静默。
 */
async function injectAutoMemories(
  assistantText: string,
  input: AgentRunInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const userText = lastUserText(input.messages)
    const auto = await afterTurnMemory({
      scope: input.scope,
      providerConfig: input.providerConfig,
      userText,
      assistantText,
      signal,
    })
    if (auto.length === 0) return
    onChunk({ type: 'start-step' })
    for (const m of auto) {
      const toolCallId = `automem-${m.id}`
      onChunk({ type: 'tool-input-available', toolCallId, toolName: 'auto_memory', input: { content: m.content, kind: m.kind, importance: m.importance } })
      onChunk({ type: 'tool-output-available', toolCallId, output: { remembered: true, source: 'auto', id: m.id } })
    }
    onChunk({ type: 'finish-step' })
  } catch {
    /* 自动记忆失败不影响主回答 */
  }
}

export async function runAgent(
  input: AgentRunInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
  onProgress?: AgentProgressReporter,
): Promise<void> {
  await withAgentProgress(onProgress, async () => {
    // 子进程侧耗时打点：stdout 会被主进程转发到控制台，配合主进程 [agent:perf] 看完整时间线
    const perfStart = Date.now()
    let perfLast = perfStart
    const perf = (label: string, detail?: string) => {
      const now = Date.now()
      console.info(`[agent:perf:child] ${label} +${now - perfLast}ms，累计 ${now - perfStart}ms${detail ? `（${detail}）` : ''}`)
      perfLast = now
    }
    const userText = lastUserText(input.messages)
    const cachedMemoryContext = getCachedStartupMemory(input.scope)
    const memoryContext = cachedMemoryContext ?? ''
    if (cachedMemoryContext === null) {
      warmStartupMemory(input.scope, () => buildMemoryContext(input.scope))
    }
    perf('记忆上下文', cachedMemoryContext === null ? '未命中缓存，后台补建' : '缓存命中')
    const relevantMemoryContext = await preloadRelevantMemories(userText, input.scope)
    const toolsDisabled = input.toolMode === 'disabled'
    const webSearchOn = !toolsDisabled && isWebSearchAvailable()
    const imageGenOn = !toolsDisabled && isImageGenAvailable()
    const toolProfile = input.toolProfile ?? (input.codeWorkspace ? 'hybrid' : 'chat')
    const codeWorkspace = (toolProfile === 'code' || toolProfile === 'hybrid') ? (input.codeWorkspace ?? null) : null
    const baseTools = toolsDisabled
      ? {}
      : withToolTimeouts(input.planMode
        ? buildPlanModeTools(input.scope, codeWorkspace)
        : toolProfile === 'code'
          ? buildCodeOnlyTools(codeWorkspace, webSearchOn, imageGenOn)
          : buildTools(input.scope, input.providerConfig, input.mcpTools, webSearchOn, imageGenOn, codeWorkspace, {
            allowWechatReplyMedia: input.allowWechatReplyMedia === true,
            uploadedMediaContext: input.uploadedMediaContext,
          }))
    perf('构建工具集', `${Object.keys(baseTools).length} 个`)
    const prepared = buildAgentInstructions(input, memoryContext, relevantMemoryContext, baseTools, webSearchOn, imageGenOn)
    perf('组装系统提示')
    // 跨步保持的压缩状态：超过模型窗口 90% 时把早期历史交 LLM 摘要折叠，见 aiCompaction.ts
    const compactionState = createCompactionState()
    const agent = new ToolLoopAgent({
      model: createLanguageModel(input.providerConfig),
      instructions: prepared.instructions,
      tools: prepared.tools,
      temperature: DEFAULT_AGENT_TEMPERATURE,
      // 步数上限 + 死循环检测（连续 N 步相同工具调用即停），见 guards.ts
      stopWhen: [stepCountIs(MAX_STEPS), loopGuardCondition()],
      providerOptions: buildProviderOptions(input, prepared.promptCacheKey),
      // 每步先做 >90% AI 压缩（折叠早期历史为摘要并发持久标记），再叠加确定性裁剪 + query_sql 门控状态
      prepareStep: async ({ messages, steps }) => ({
        messages: await aiCompactStep({
          messages,
          state: compactionState,
          providerConfig: input.providerConfig,
          emit: onChunk,
          signal,
        }),
        experimental_context: buildToolRuntimeContext(steps),
      }),
    })

    const result = await agent.stream({
      messages: input.messages,
      abortSignal: signal,
      // 文本按词匀速放流：模型突发吐一大段时不再整块砸向 UI，而是 ~10ms/词的稳定节奏。
      // 中文没有空格，用 Intl.Segmenter 做 CJK 分词（AI SDK 官方推荐做法）。
      experimental_transform: smoothStream({
        delayInMs: 10,
        chunking: createSmoothStreamChunker(),
      }),
    })
    perf('发起模型流式请求')
    // 截留 message 的 finish，等 L1 自动记忆注入完再补发，让自动写入的工具 part 落在本条消息内
    let finishChunk: UIMessageChunk | undefined
    let perfFirstEventSeen = false
    let perfFirstOutputSeen = false
    const toolNames = new Map<string, string>()
    const pendingToolCalls = new Map<string, { toolName: string; input?: unknown }>()
    for await (const chunk of result.toUIMessageStream({
      // 默认 onError 只回 "An error occurred."，把真实报错（含 status code）透传给聊天区，别再靠猜
      onError: formatAgentError,
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return undefined
        return {
          usage: withCacheHitRate(part.totalUsage),
          finishReason: part.finishReason,
          rawFinishReason: part.rawFinishReason,
          modelProvider: input.providerConfig.name,
          modelId: input.providerConfig.model,
          ...(input.planMode ? { planMode: true } : {}),
        }
      },
    })) {
      if (!perfFirstEventSeen) {
        perfFirstEventSeen = true
        perf('模型流首个事件', chunk.type)
      }
      if (!perfFirstOutputSeen && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-input-start')) {
        perfFirstOutputSeen = true
        perf('模型首个增量输出（真正开始回复）', chunk.type)
      }
      if (chunk.type === 'finish') { finishChunk = chunk; continue }
      trackToolChunk(chunk, toolNames, pendingToolCalls)
      onChunk(chunk)
    }
    let assistantText = ''
    try { assistantText = await result.text } catch { /* abort/异常：跳过自动记忆 */ }
    perf('主回答流结束')
    if (pendingToolCalls.size > 0 && !signal?.aborted) {
      for (const [toolCallId, pending] of pendingToolCalls.entries()) {
        onChunk({
          type: 'tool-output-error',
          toolCallId,
          errorText: `工具 ${pending.toolName} 没有返回执行结果。请确认代码工作区已选择并启用；如果刚更新过 Electron 主进程/preload，需要重启应用后再试。`,
        })
      }
      perf('补齐未完成工具状态', `${pendingToolCalls.size} 个`)
    }
    if (finishChunk) onChunk(finishChunk)
    reportAgentProgress({ stage: 'run_finished', title: '回答生成完成' })
    // 自动记忆抽取是额外一次 LLM 调用；主回答已经出完，不再让"回复中"干等这一步。
    // 后台异步跑，写库效果不受影响，只是它合成的 auto_memory 工具 part 不会再挂在这条已经结束的消息上。
    if (assistantText && !signal?.aborted) {
      void injectAutoMemories(assistantText, input, onChunk, signal).then(() => perf('自动记忆抽取（后台）'))
    }
  })
}

export async function generateConversationTitle(
  input: { firstMessage: string; providerConfig: AgentProviderConfig },
  signal?: AbortSignal,
): Promise<string> {
  const firstMessage = input.firstMessage.trim().slice(0, 600)
  if (!firstMessage) return '新对话'

  const result = await generateText({
    model: createLanguageModel(input.providerConfig),
    system: '你是对话标题生成器。只输出一个中文短标题，不要解释，不要引号，不要标点装饰。',
    prompt: `根据用户第一句话生成 4 到 12 个汉字的聊天标题：\n${firstMessage}`,
    abortSignal: signal,
  })

  return sanitizeGeneratedTitle(result.text)
}

function sanitizeGeneratedTitle(value: string): string {
  const title = value
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^标题[:：]\s*/i, '')
    .trim()
  return title.slice(0, 24) || '新对话'
}

export type ReplySuggestStyle = 'natural' | 'short' | 'formal' | 'humorous' | 'warm' | 'likeme'

export type ReplySuggestInput = {
  contactName: string
  /** 会话 username；深度模式的历史检索工具、likeme 的真实问答对检索都需要它 */
  sessionId?: string
  /** 对话上下文，从旧到新；深度模式由渲染端多传消息实现 */
  context: Array<{ fromMe: boolean; text: string }>
  style: ReplySuggestStyle
  count: number
  /** 深度模式：给模型一个会话内检索工具跑小步工具循环，先查历史背景再给建议 */
  deep?: boolean
  /** style === 'likeme' 时的"我"历史发言 few-shot（无自画像时的兜底） */
  myRecentTexts?: string[]
  /** style === 'likeme' 时由自画像画像卡渲染成的提示文本；优先于 myRecentTexts */
  myPersonaContext?: string
  /** 自画像统计：avgBurst=我平均一轮连发几条，avgChars=每条平均字数；用于连发自适应 */
  myStats?: { avgBurst?: number; avgChars?: number }
  /** 深度模式时对方的画像（克隆过 TA 才有），拟回复时考虑 TA 吃哪套、避开雷区 */
  friendPersonaContext?: string
  /** 对方刚发来待回复的图片（base64，时间正序）；模型标记不支持图像输入时忽略 */
  images?: Array<{ base64: string }>
  /** Deep mode reuses the same Agent tool context as the main Agent run. */
  mcpTools?: AgentMcpToolDescriptor[]
  skills?: AgentSkillContextItem[]
  toolProfile?: AgentToolProfile
  codeWorkspace?: CodeWorkspaceRef | null
  providerConfig: AgentProviderConfig
}

/** 单次回复建议最多附带的图片张数 */
const SUGGEST_IMAGE_LIMIT = 3

export type ReplySuggestOutcome = {
  suggestions: string[]
  /** 实际附进请求的图片张数（0=没附：没传图/模型明确不支持视觉/全部解码失败） */
  imagesAttached: number
  /** 模型图像输入能力：true/false=目录明确标记，undefined=目录查不到（按可尝试处理） */
  visionSupport: boolean | undefined
}

/** 我平均一轮连发达到该值就提示模型按连发习惯拆条（用"／"分隔） */
const BURST_HINT_THRESHOLD = 1.5

const REPLY_STYLE_HINTS: Record<ReplySuggestStyle, string> = {
  natural: '自然日常，像平时和朋友聊天',
  short: '简短干脆，尽量一句话说完',
  formal: '得体正式，措辞礼貌',
  humorous: '幽默轻松，可以适度玩梗',
  warm: '热情贴心，多给情绪价值',
  likeme: '严格模仿"我"的说话语气、用词、口头禅和标点习惯',
}

export async function generateReplySuggestions(
  input: ReplySuggestInput,
  signal?: AbortSignal,
): Promise<ReplySuggestOutcome> {
  const count = Math.min(5, Math.max(1, Math.round(input.count) || 3))
  const contactName = input.contactName.trim() || '对方'
  const visionSupport = currentModelVisionSupport(input.providerConfig)
  const cleanedContext = input.context
    .map((m) => ({ ...m, text: m.text.trim() }))
    .filter((m) => m.text)
  const lines = cleanedContext
    .map((m) => `${m.fromMe ? 'Me (app user; reply sender)' : `${contactName} (other person; reply recipient)`}: ${m.text.slice(0, 300)}`)
  if (lines.length === 0) return { suggestions: [], imagesAttached: 0, visionSupport }
  const latestIncoming = [...cleanedContext].reverse().find((m) => !m.fromMe)
  const latestIncomingHint = latestIncoming
    ? `Target incoming message to reply to: ${contactName} just sent me: "${latestIncoming.text.slice(0, 300)}". `
    : ''

  const sessionId = input.sessionId?.trim()
  const fewShotParts: string[] = []
  if (input.style === 'likeme') {
    if (input.myPersonaContext) {
      fewShotParts.push(`"我"的说话画像（严格遵循其中的语气、口头禅、标点习惯来生成回复）：\n${input.myPersonaContext}`)
    } else if (input.myRecentTexts?.length) {
      fewShotParts.push(`"我"的历史发言示例（模仿这种语气）：\n${input.myRecentTexts.slice(0, 20).map((t) => `- ${t.trim().slice(0, 100)}`).join('\n')}`)
    }
    // 检索式 few-shot：拿"我"过去遇到类似话时的真实回复，比画像卡里的静态样本更贴当前话题（与克隆好友聊天同一招）
    const lastIncoming = [...input.context].reverse().find((m) => !m.fromMe)?.text.trim()
    if (sessionId && lastIncoming) {
      try {
        const { personaPairStore } = await import('./persona/personaPairStore')
        const hits = await personaPairStore.search(`self:${sessionId}`, lastIncoming, 6)
        if (hits.length > 0) {
          fewShotParts.push(
            `"我"过去遇到类似话时的真实回复（最优先参考，回复要像这些一样）：\n${hits
              .map((h) => `- 对方：${h.user}\n  我：${h.replies.join('／')}`)
              .join('\n')}`,
          )
        }
      } catch {
        // 检索失败静默，退回画像卡/历史发言
      }
    }
  }
  const fewShot = fewShotParts.length > 0 ? `\n\n${fewShotParts.join('\n\n')}` : ''

  const deep = input.deep === true && !!sessionId
  // 连发自适应：我真人习惯连发短句时，让每条建议按习惯拆成短句连发（正式风格不拆）
  const avgBurst = input.myStats?.avgBurst ?? 0
  const burstHint = avgBurst >= BURST_HINT_THRESHOLD && input.style !== 'formal'
    ? `"我"平时习惯把一句话拆成短句连发（平均一轮 ${Math.round(avgBurst * 10) / 10} 条${input.myStats?.avgChars ? `、每条约 ${input.myStats.avgChars} 字` : ''}）：每条建议照这个习惯拆成 2~3 条短句，短句之间用"／"分隔；内容本来就短的保持一条即可。`
    : ''
  const system = `You are a WeChat reply-suggestion assistant. Direction is critical: "me" = the app user who will send the reply; ${contactName} = the other person who will receive the reply. Generate exactly ${count} reply suggestions that I can directly send to ${contactName}. ${latestIncomingHint}Every output string must be the exact words I would send to ${contactName}; never answer from ${contactName}'s perspective, never write what ${contactName} should say to me, and never output analysis or summaries. Requirements: colloquial Chinese; respond tightly to the latest incoming message from ${contactName}; make the ${count} suggestions distinct in angle or tone; no explanations, no numbering, no speaker prefix. Style: ${REPLY_STYLE_HINTS[input.style] ?? REPLY_STYLE_HINTS.natural}. ${burstHint}${deep ? 'You may use search_history to inspect my history with the other person and recover background for the target incoming message; search two or three times at most.' : ''}Final output must be only a JSON string array with exactly ${count} strings, e.g. ["reply one","reply two"]. Do not put multiple suggestions inside one string and do not output anything else.`
  const friendBlock = deep && input.friendPersonaContext
    ? `\n\n对方「${contactName}」的画像（拟回复时考虑 TA 吃哪套、避开雷区）：\n${input.friendPersonaContext}`
    : ''

  // 多模态：把对方刚发来的图片附进请求。仅当模型被明确标记"不支持图像输入"时丢弃；
  // 目录里查不到（undefined）按可尝试处理，与 inspect_media_image 工具口径一致。
  const imageParts: Array<{ type: 'image'; image: Buffer; mediaType: string }> = []
  if (input.images?.length && visionSupport !== false) {
    for (const img of input.images.slice(0, SUGGEST_IMAGE_LIMIT)) {
      try {
        const buffer = Buffer.from(img.base64, 'base64')
        const mediaType = buffer.length > 0 ? detectImageMime(buffer) : null
        if (mediaType) imageParts.push({ type: 'image', image: buffer, mediaType })
      } catch {
        // 单张解码失败跳过
      }
    }
  }
  const imageNote = imageParts.length > 0
    ? `\n\n（对方最近发来的 ${imageParts.length} 张图片已按时间顺序附在本条消息里，回复建议要针对图片内容）`
    : ''

  const prompt = `Conversation history (oldest to newest):\n${lines.join('\n')}${friendBlock}${fewShot}${imageNote}\n\nCurrent task: write from Me/app-user's perspective, replying to the target incoming message from ${contactName}. Each suggestion must be text I can copy into WeChat and send to ${contactName}. Give ${count} reply suggestions.`
  const messages: ModelMessage[] = [{
    role: 'user',
    content: imageParts.length > 0 ? [{ type: 'text', text: prompt }, ...imageParts] : prompt,
  }]

  const resultText = deep
    ? await generateDeepReplySuggestionText({ input, system, messages, prompt, contactName, sessionId, signal })
    : (await generateText({
        model: createLanguageModel(input.providerConfig),
        system,
        messages,
        // Keep the likeme style a little more lively, matching persona chat.
        ...(input.style === 'likeme' ? { temperature: 0.8 } : {}),
        abortSignal: signal,
      })).text

  return {
    suggestions: parseReplySuggestions(resultText, count),
    imagesAttached: imageParts.length,
    visionSupport,
  }
}

type DeepReplySuggestionArgs = {
  input: ReplySuggestInput
  system: string
  messages: ModelMessage[]
  prompt: string
  contactName: string
  sessionId: string
  signal?: AbortSignal
}

async function generateDeepReplySuggestionText({ input, system, messages, prompt, contactName, sessionId, signal }: DeepReplySuggestionArgs): Promise<string> {
  const scope = { kind: 'global' as const }
  const webSearchOn = isWebSearchAvailable()
  const imageGenOn = isImageGenAvailable()
  const agentInput: AgentRunInput = {
    messages,
    providerConfig: input.providerConfig,
    scope,
    mcpTools: input.mcpTools,
    skills: input.skills,
    toolProfile: input.toolProfile ?? 'hybrid',
    codeWorkspace: input.codeWorkspace ?? null,
  }
  const tools = withToolTimeouts({
    ...buildTools(scope, input.providerConfig, input.mcpTools, webSearchOn, imageGenOn, input.codeWorkspace ?? null, {
      uploadedMediaContext: undefined,
    }),
    search_history: tool({
      description: `Search the current reply session history with ${contactName}. If the clue may live in other conversations, use global Agent tools such as search_messages or semantic_search instead.`,
      inputSchema: z.object({
        query: z.string().describe('Keyword or phrase'),
      }),
      execute: async ({ query }) => {
        const { searchChat } = await import('./tools/shared')
        const { hits } = await searchChat({ query, sessionId, limit: 8 })
        return hits.length > 0
          ? hits.map((h) => `${h.time} ${h.sender}: ${h.excerpt}`).join('\n')
          : 'No hits'
      },
    }),
  })
  const cachedMemoryContext = getCachedStartupMemory(scope)
  const memoryContext = cachedMemoryContext ?? ''
  if (cachedMemoryContext === null) {
    warmStartupMemory(scope, () => buildMemoryContext(scope))
  }
  const relevantMemoryContext = await preloadRelevantMemories(prompt, scope)
  const prepared = buildAgentInstructions(agentInput, memoryContext, relevantMemoryContext, tools, webSearchOn, imageGenOn)
  const instructions: SystemModelMessage[] = [
    ...prepared.instructions,
    {
      role: 'system',
      content: `${system}
Deep reply-suggestion mode is connected to the full Agent toolset. You may search across conversations, read chat context, inspect contacts/groups/timeline, use memory, MCP, web search, and media search to recover background. Current target sessionId=${sessionId}; contact=${contactName}. Keep the direction fixed after all tool use: final suggestions are messages from \"me\" (the app user) to ${contactName}; never answer as ${contactName}, never write what ${contactName} should say to me, and never output analysis. If the latest message references another person, conversation, or historical event, proactively use global retrieval tools so multiple tile sessions can share context. For this task, only retrieve and analyze: do not actually send messages/media/files, modify files/tasks, or write long-term memory. The final answer must still be only a JSON string array.`,
    },
  ]
  const agent = new ToolLoopAgent({
    model: createLanguageModel(input.providerConfig),
    instructions,
    tools: prepared.tools,
    temperature: input.style === 'likeme' ? 0.8 : DEFAULT_AGENT_TEMPERATURE,
    stopWhen: [stepCountIs(REPLY_DEEP_MAX_STEPS), loopGuardCondition()],
    providerOptions: buildProviderOptions(agentInput, prepared.promptCacheKey),
    prepareStep: async ({ steps }) => ({
      experimental_context: buildToolRuntimeContext(steps),
    }),
  })
  const result = await agent.generate({ messages, abortSignal: signal })
  return result.text
}

function splitReplySuggestionLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^[\s\-*\u2022\u00b7\d.\u3001)\uff09'"\u201c\u201d]+/, '')
      .replace(/['"\u201c\u201d]+$/, '')
      .trim())
    .filter(Boolean)
}

function parseReplySuggestions(text: string, count: number): string[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        const items = parsed.map((v) => String(v).trim()).filter(Boolean)
        // Some models return a valid JSON array with a single string that contains
        // several numbered/newline-separated suggestions. Expand that shape so the
        // tile can still show the configured count instead of one oversized card.
        if (items.length === 1 && count > 1) {
          const expanded = splitReplySuggestionLines(items[0])
          if (expanded.length > 1) return expanded.slice(0, count)
        }
        if (items.length > 0) return items.slice(0, count)
      }
    } catch {
      // Fall back to line parsing.
    }
  }
  // Fallback: if the model ignores the JSON instruction, parse one suggestion per line.
  return splitReplySuggestionLines(text).slice(0, count)
}



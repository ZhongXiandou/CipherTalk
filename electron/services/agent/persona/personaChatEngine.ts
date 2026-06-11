/**
 * 克隆好友聊天引擎 —— 跑在 AI utilityProcess 子进程。
 * 与 AI 助手（engine.ts 的工具循环）刻意不同：扮演真人不暴露工具，
 * 每轮先做一次记忆预检索（向量优先、关键词兜底，失败静默），
 * 再单次 generateText 完整生成后按气泡回推 —— 人格稳定性优先于能力灵活性。
 */
import { generateText, type FinishReason, type ModelMessage, type UIMessageChunk } from 'ai'
import { createLanguageModel } from '../provider'
import { reportAgentProgress, withAgentProgress } from '../progress'
import { searchChat } from '../tools/shared'
import type { AgentProgressReporter } from '../types'
import type { PersonaChatInput, PersonaChatPersona, PersonaFewShot } from './personaTypes'

const MEMORY_TOP_K = 5
const PAIR_TOP_K = 6
// 扮演真人要比工具 Agent 更"活"，温度调高
const PERSONA_TEMPERATURE = 0.8
const BURST_JOINER = '／'
const HUMAN_TYPING_MS_PER_CHAR = 260
const HUMAN_TYPING_MIN_DELAY_MS = 1000
const HUMAN_TYPING_MAX_DELAY_MS = 7500
const HUMAN_BUBBLE_PAUSE_MIN_MS = 700
const HUMAN_BUBBLE_PAUSE_MAX_MS = 2200

function splitReplyBubbles(text: string): string[] {
  return text.split(/[\n／]/).map((line) => line.trim()).filter(Boolean)
}

// 兜底拆条：不分条的回复超过 max(此值, 平均字数×2.5) 才动它
const FALLBACK_SPLIT_MIN_CHARS = 50
const FALLBACK_MAX_BUBBLES = 5

/** 模型偶尔无视分条规则直接发大段：按句子边界兜底拆成微信式短消息（已分条/不算长的原样返回）。 */
function fallbackSplitLongReply(text: string, avgChars: number): string {
  const trimmed = text.trim()
  if (splitReplyBubbles(trimmed).length > 1) return text
  if (trimmed.length <= Math.max(FALLBACK_SPLIT_MIN_CHARS, avgChars * 2.5)) return text

  const sentences = trimmed.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean)
  if (sentences.length <= 1) return text

  // 单条目标长度：贴近真人平均字数，同时保证不会拆出超过上限的条数
  const target = Math.max(20, Math.round(avgChars * 1.8), Math.ceil(trimmed.length / FALLBACK_MAX_BUBBLES))
  const bubbles: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > target) {
      bubbles.push(current)
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current) bubbles.push(current)
  return bubbles.join('\n')
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function jitter(ms: number): number {
  return Math.round(ms * randomBetween(0.85, 1.2))
}

function typingDelayMs(text: string): number {
  const charCount = Array.from(text.replace(/\s+/g, '')).length
  const punctuationCount = text.match(/[，。！？!?…~～、,.]/g)?.length || 0
  return clamp(
    jitter(charCount * HUMAN_TYPING_MS_PER_CHAR + punctuationCount * 90),
    HUMAN_TYPING_MIN_DELAY_MS,
    HUMAN_TYPING_MAX_DELAY_MS,
  )
}

function bubblePauseMs(index: number): number {
  return index === 0 ? 0 : Math.round(randomBetween(HUMAN_BUBBLE_PAUSE_MIN_MS, HUMAN_BUBBLE_PAUSE_MAX_MS))
}

function waitMs(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (completed: boolean) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = () => done(false)

    timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function emitCompleteTextAsUiChunks(
  text: string,
  finishReason: FinishReason,
  metadata: Record<string, unknown>,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const textId = `persona-text-${Date.now()}`
  onChunk({ type: 'start' })
  onChunk({ type: 'start-step' })
  onChunk({ type: 'text-start', id: textId })
  const bubbles = splitReplyBubbles(text)
  for (let i = 0; i < bubbles.length; i += 1) {
    const completed = await waitMs(bubblePauseMs(i) + typingDelayMs(bubbles[i]), signal)
    if (!completed) {
      onChunk({ type: 'abort', reason: 'aborted' })
      return false
    }
    onChunk({ type: 'text-delta', id: textId, delta: `${i === 0 ? '' : '\n'}${bubbles[i]}` })
  }
  onChunk({ type: 'text-end', id: textId })
  onChunk({ type: 'finish-step' })
  onChunk({ type: 'finish', finishReason, messageMetadata: metadata })
  return true
}

function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => (p && typeof p === 'object' && 'type' in p && p.type === 'text' ? String(p.text || '') : ''))
        .filter(Boolean)
        .join('\n')
    }
    return ''
  }
  return ''
}

/** 记忆预检索：嵌入就绪走会话片段向量（首聊触发懒构建，进度上报），否则/失败关键词兜底。 */
async function retrieveMemories(sessionId: string, query: string): Promise<string[]> {
  try {
    const { getEmbeddingConfig } = await import('../../ai/embeddingService')
    const { messageVectorService, embedQuery } = await import('../../search/messageVectorService')
    const cfg = getEmbeddingConfig()
    if (messageVectorService.isReady(cfg)) {
      const queryVec = await embedQuery(query, cfg)
      await messageVectorService.ensureSessionVectors(sessionId, cfg, undefined, (progress) => {
        reportAgentProgress({
          stage: progress.stage === 'embedding' ? 'indexing' : 'searching',
          title: progress.message,
          sessionId,
        })
      })
      const hits = messageVectorService.searchSession(sessionId, queryVec, MEMORY_TOP_K)
      if (hits.length > 0) {
        return hits.map((h) => h.excerpt.replace(/\n+/g, BURST_JOINER))
      }
    }
  } catch {
    /* 向量检索失败 → 关键词兜底 */
  }
  try {
    const { hits } = await searchChat({ query, sessionId, limit: MEMORY_TOP_K })
    return hits.map((h) => `${h.sender}: ${h.excerpt.replace(/\n+/g, BURST_JOINER)}`)
  } catch {
    return []
  }
}

/** 检索式 few-shot：按当前输入找 TA 过去遇到类似话时的真实回复（失败静默）。 */
async function retrieveSimilarPairs(sessionId: string, query: string): Promise<PersonaFewShot[]> {
  try {
    const { personaPairStore } = await import('./personaPairStore')
    const hits = await personaPairStore.search(sessionId, query, PAIR_TOP_K)
    return hits.map((h) => ({ user: h.user, replies: h.replies }))
  } catch {
    return []
  }
}

export function buildPersonaSystemPrompt(
  persona: PersonaChatPersona,
  memories: string[],
  similarPairs: PersonaFewShot[] = [],
): string {
  const { displayName, card, fewShots, stats, profile, notes } = persona
  const lines: string[] = [
    `你是「${displayName}」，正在微信上和老朋友聊天。你不是 AI 助手，你就是${displayName}本人，任何情况下都不要承认或暗示自己是 AI、模型或程序。`,
    '',
    '【你的说话方式】',
    `语气风格：${card.tone}`,
    `性格：${card.personalityTraits.join('、')}`,
  ]
  if (card.catchphrases.length > 0) lines.push(`口头禅：${card.catchphrases.join('、')}（真人只是偶尔冒一句：大多数消息不带，绝不要每条都带）`)
  lines.push(`标点习惯：${card.punctuationStyle}`)
  if (card.addressing && card.addressing !== '无特别称呼') lines.push(`你对对方的称呼：${card.addressing}`)
  if (card.topics.length > 0) lines.push(`你们常聊：${card.topics.join('、')}`)

  if (profile) {
    if (profile.facts.length > 0) {
      lines.push('', '【你的生活背景】（这些就是你自己的事，自然地知道，别像背资料）', ...profile.facts.map((f) => `- ${f}`))
    }
    if (profile.relationship) lines.push('', `【你们的关系】${profile.relationship}`)
    if (profile.reactionPatterns.length > 0) {
      lines.push('', '【你在不同情境下的典型反应】', ...profile.reactionPatterns.map((r) => `- ${r}`))
    }
    if (profile.boundaries.length > 0) {
      lines.push('', '【你的立场与边界】（不熟的领域别装懂，回避的话题照样回避）', ...profile.boundaries.map((b) => `- ${b}`))
    }
    if (profile.sharedEvents.length > 0) {
      lines.push('', '【你们的共同经历】', ...profile.sharedEvents.map((e) => `- ${e}`))
    }
  }

  if (fewShots.length > 0) {
    lines.push(
      '',
      `【你过去真实的回复方式】（「${BURST_JOINER}」分隔的是连发的多条消息）`,
      ...fewShots.map((s) => `对方: ${s.user}\n你: ${s.replies.join(BURST_JOINER)}`),
    )
  }

  // 检索式 few-shot：和静态样本去重后注入，权重最高（这是 TA 面对类似话题的真实反应）
  const knownUsers = new Set(fewShots.map((s) => s.user))
  const freshPairs = similarPairs.filter((p) => !knownUsers.has(p.user))
  if (freshPairs.length > 0) {
    lines.push(
      '',
      '【你过去遇到类似话题时的真实回复】（最值得参考的范例：当时就是这么回的，语气、长度、分条都照这个感觉来）',
      ...freshPairs.map((s) => `对方: ${s.user}\n你: ${s.replies.join(BURST_JOINER)}`),
    )
  }

  if (memories.length > 0) {
    lines.push(
      '',
      '【可能相关的真实聊天片段】（你们真的聊过这些，可自然提及，但别逐字背诵、别主动复述无关内容）',
      ...memories.map((m) => `- ${m}`),
    )
  }

  if (notes?.episodes?.length) {
    lines.push(
      '',
      '【你们最近在这里聊过】（之前的对话，记得就好，别主动复述）',
      ...notes.episodes.map((e) => `- ${e}`),
    )
  }

  if (notes?.corrections?.length) {
    lines.push(
      '',
      '【扮演纠正】（对方之前明确指出过的问题，必须遵守）',
      ...notes.corrections.map((c) => `- ${c}`),
    )
  }

  lines.push(
    '',
    '【聊天规则】',
    `- 微信短消息风格：单条 ${Math.max(stats.avgFriendMsgChars, 4)} 字左右；超过两句话必须拆成多条连发，每条之间用换行或「${BURST_JOINER}」分隔（会被拆成多条气泡发出），绝不要一条发一大段`,
    '- 回复几条由你根据上下文定：简单的话就一条，有内容的拆成 2-4 条，像真人打字那样一句一句发',
    '- 上面的背景、经历、聊天片段都是你脑子里的记忆：只在话题相关时自然带一嘴，别一股脑往外倒',
    '- 禁止 markdown、列表、序号、emoji 之外的格式符号',
    '- 不知道、记不清的事就像真人一样含糊带过或反问，绝不编造具体细节',
    '- 始终保持口语化，符合上面的语气和标点习惯',
  )
  return lines.join('\n')
}

export async function runPersonaChat(
  input: PersonaChatInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
  onProgress?: AgentProgressReporter,
): Promise<void> {
  await withAgentProgress(onProgress, async () => {
    const userText = lastUserText(input.messages)
    reportAgentProgress({ stage: 'run_started', title: '正在回忆相关聊天' })
    const [memories, similarPairs] = userText
      ? await Promise.all([
          retrieveMemories(input.persona.sessionId, userText),
          retrieveSimilarPairs(input.persona.sessionId, userText),
        ])
      : [[], []]

    reportAgentProgress({ stage: 'run_started', title: '正在组织语言' })
    const result = await generateText({
      model: createLanguageModel(input.providerConfig),
      system: buildPersonaSystemPrompt(input.persona, memories, similarPairs),
      messages: input.messages,
      temperature: PERSONA_TEMPERATURE,
      abortSignal: signal,
    })

    const replyText = fallbackSplitLongReply(result.text, Math.max(input.persona.stats.avgFriendMsgChars, 8))
    const completed = await emitCompleteTextAsUiChunks(replyText, result.finishReason, {
      usage: result.totalUsage,
      finishReason: result.finishReason,
      modelProvider: input.providerConfig.name,
      modelId: input.providerConfig.model,
      persona: input.persona.sessionId,
    }, onChunk, signal)
    reportAgentProgress(completed
      ? { stage: 'run_finished', title: '回复完成' }
      : { stage: 'error', title: '已停止回复' })
  })
}

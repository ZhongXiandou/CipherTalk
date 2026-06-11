/**
 * 克隆好友聊天引擎 —— 跑在 AI utilityProcess 子进程。
 * 与 AI 助手（engine.ts 的工具循环）刻意不同：扮演真人不暴露工具，
 * 每轮先做一次记忆预检索（向量优先、关键词兜底，失败静默），
 * 再单次 streamText 流式输出 —— 人格稳定性优先于能力灵活性。
 */
import { smoothStream, streamText, type ModelMessage, type UIMessageChunk } from 'ai'
import { createLanguageModel } from '../provider'
import { reportAgentProgress, withAgentProgress } from '../progress'
import { searchChat } from '../tools/shared'
import type { AgentProgressReporter } from '../types'
import type { PersonaChatInput, PersonaChatPersona } from './personaTypes'

const MEMORY_TOP_K = 5
// 扮演真人要比工具 Agent 更"活"，温度调高
const PERSONA_TEMPERATURE = 0.8
const BURST_JOINER = '／'

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

export function buildPersonaSystemPrompt(persona: PersonaChatPersona, memories: string[]): string {
  const { displayName, card, fewShots, stats } = persona
  const maxBurst = Math.max(1, Math.round(stats.avgFriendBurst || 1))
  const lines: string[] = [
    `你是「${displayName}」，正在微信上和老朋友聊天。你不是 AI 助手，你就是${displayName}本人，任何情况下都不要承认或暗示自己是 AI、模型或程序。`,
    '',
    '【你的说话方式】',
    `语气风格：${card.tone}`,
    `性格：${card.personalityTraits.join('、')}`,
  ]
  if (card.catchphrases.length > 0) lines.push(`口头禅：${card.catchphrases.join('、')}（自然使用，别刻意堆砌）`)
  lines.push(`标点习惯：${card.punctuationStyle}`)
  if (card.addressing && card.addressing !== '无特别称呼') lines.push(`你对对方的称呼：${card.addressing}`)
  if (card.topics.length > 0) lines.push(`你们常聊：${card.topics.join('、')}`)

  if (fewShots.length > 0) {
    lines.push(
      '',
      `【你过去真实的回复方式】（「${BURST_JOINER}」分隔的是连发的多条消息）`,
      ...fewShots.map((s) => `对方: ${s.user}\n你: ${s.replies.join(BURST_JOINER)}`),
    )
  }

  if (memories.length > 0) {
    lines.push(
      '',
      '【可能相关的真实聊天片段】（你们真的聊过这些，可自然提及，但别逐字背诵、别主动复述无关内容）',
      ...memories.map((m) => `- ${m}`),
    )
  }

  lines.push(
    '',
    '【聊天规则】',
    `- 微信短消息风格：单条平均 ${Math.max(stats.avgFriendMsgChars, 4)} 字左右，一次回 1-${maxBurst} 条，别写长段落`,
    `- 要连发多条时，每条消息之间用换行或「${BURST_JOINER}」分隔（会被拆成多条气泡发出）`,
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
    const memories = userText ? await retrieveMemories(input.persona.sessionId, userText) : []

    reportAgentProgress({ stage: 'run_started', title: '正在组织语言' })
    const result = streamText({
      model: createLanguageModel(input.providerConfig),
      system: buildPersonaSystemPrompt(input.persona, memories),
      messages: input.messages,
      temperature: PERSONA_TEMPERATURE,
      abortSignal: signal,
      // 与 engine.ts 同款匀速放流；Segmenter 的 lib 类型缺失，同 engine 用 any 绕过
      experimental_transform: smoothStream({
        delayInMs: 10,
        chunking: new (Intl as any).Segmenter('zh', { granularity: 'word' }),
      }),
    })

    for await (const chunk of result.toUIMessageStream({
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return undefined
        return {
          usage: part.totalUsage,
          finishReason: part.finishReason,
          modelProvider: input.providerConfig.name,
          modelId: input.providerConfig.model,
          persona: input.persona.sessionId,
        }
      },
    })) {
      onChunk(chunk)
    }
    reportAgentProgress({ stage: 'run_finished', title: '回复完成' })
  })
}

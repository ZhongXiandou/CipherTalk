/**
 * 画像语料构建（主进程，纯计算无 LLM）。
 *
 * 微信对话不是一问一答：同一人经常连发多条，必须先把连续消息合并成「轮次」，
 * 否则统计失真、few-shot 问答对全是错位的。这里负责：
 * 1. 过滤可用文本消息（文本 + 已转写语音）；
 * 2. 轮次合并（同一发言人、间隔 ≤ TURN_GAP_SECONDS 归一轮）；
 * 3. 统计风格指标（平均字数 / 平均连发条数）；
 * 4. 渲染成给 LLM 的对话文本（最近优先，按字符预算截断）。
 */
import type { ChatSearchMemoryMessage } from '../../search/chatSearchIndexService'
import { voiceTranscribeService } from '../../voiceTranscribeService'
import type { PersonaPair, PersonaStats } from './personaTypes'

/** 对方可用文本消息低于此数时拒绝克隆（语料太少画像必然失真） */
export const MIN_FRIEND_MESSAGES = 50

const TURN_GAP_SECONDS = 3 * 60   // 同一人相邻消息间隔超过此值视为新一轮
const MSG_CHAR_CAP = 200          // 单条消息进语料的字符上限（防超长消息撑爆）
const CORPUS_CHAR_BUDGET = 14000  // 渲染语料的总字符预算（最近的轮次优先）
const BURST_JOINER = '／'         // 一轮内连发多条的分隔符（提示词里会说明）

// 深层画像 map-reduce：把全量历史切成块逐块提取，块数封顶控制成本
const PROFILE_CHUNK_CHARS = 10000
export const PROFILE_MAX_CHUNKS = 12

// 检索式 few-shot 的问答对：单边文本上限 / 连发条数上限
const PAIR_TEXT_CAP = 160
const PAIR_MAX_REPLIES = 6

export interface PersonaTurn {
  /** true = 对方（被克隆者）说的 */
  isFriend: boolean
  texts: string[]
  startTime: number
}

export interface PersonaCorpus {
  corpusText: string
  stats: PersonaStats
  turnCount: number
}

/** 取消息用于风格分析的文本：文本消息用解析内容，语音消息只收已转写的。 */
function messageText(m: ChatSearchMemoryMessage): string {
  if (m.localType === 1) return m.parsedContent.trim()
  if (m.localType === 34) {
    return (voiceTranscribeService.getCachedTranscript(m.sessionId, m.createTime) || '').trim()
  }
  return ''
}

export function mergeTurns(messages: ChatSearchMemoryMessage[]): PersonaTurn[] {
  const turns: PersonaTurn[] = []
  let prevTime = 0
  for (const m of messages) {
    const text = messageText(m)
    if (!text) continue
    const isFriend = m.isSend !== 1
    const last = turns[turns.length - 1]
    if (last && last.isFriend === isFriend && m.createTime - prevTime <= TURN_GAP_SECONDS) {
      last.texts.push(text.slice(0, MSG_CHAR_CAP))
    } else {
      turns.push({ isFriend, texts: [text.slice(0, MSG_CHAR_CAP)], startTime: m.createTime })
    }
    prevTime = m.createTime
  }
  return turns
}

function computeStats(turns: PersonaTurn[]): PersonaStats {
  let friendMsgs = 0
  let friendChars = 0
  let friendTurns = 0
  let total = 0
  for (const turn of turns) {
    total += turn.texts.length
    if (!turn.isFriend) continue
    friendTurns += 1
    friendMsgs += turn.texts.length
    for (const t of turn.texts) friendChars += t.length
  }
  return {
    sourceMessageCount: total,
    friendMessageCount: friendMsgs,
    avgFriendMsgChars: friendMsgs > 0 ? Math.round(friendChars / friendMsgs) : 0,
    avgFriendBurst: friendTurns > 0 ? Math.round((friendMsgs / friendTurns) * 10) / 10 : 0,
  }
}

/** 把轮次渲染成「我: xxx／xxx」式对话文本；从最新往回装，装满预算后按时间正序输出。 */
function renderCorpus(turns: PersonaTurn[], friendName: string): { text: string; usedTurns: number } {
  const lines: string[] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    const line = `${turn.isFriend ? friendName : '我'}: ${turn.texts.join(BURST_JOINER)}`
    if (used + line.length > CORPUS_CHAR_BUDGET && lines.length > 0) break
    lines.push(line)
    used += line.length
  }
  return { text: lines.reverse().join('\n'), usedTurns: lines.length }
}

export function buildPersonaCorpus(messages: ChatSearchMemoryMessage[], friendName: string): PersonaCorpus {
  const turns = mergeTurns(messages)
  const stats = computeStats(turns)
  const { text } = renderCorpus(turns, friendName)
  return { corpusText: text, stats, turnCount: turns.length }
}

/**
 * 深层画像语料：全部轮次按时间正序渲染后切成 ≤PROFILE_CHUNK_CHARS 的块。
 * 超过 PROFILE_MAX_CHUNKS 时保留最近的块（近期生活状态比远古历史更重要）。
 */
export function renderProfileChunks(turns: PersonaTurn[], friendName: string): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let chars = 0
  for (const turn of turns) {
    const line = `${turn.isFriend ? friendName : '我'}: ${turn.texts.join(BURST_JOINER)}`
    if (chars + line.length > PROFILE_CHUNK_CHARS && current.length > 0) {
      chunks.push(current.join('\n'))
      current = []
      chars = 0
    }
    current.push(line)
    chars += line.length
  }
  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks.slice(-PROFILE_MAX_CHUNKS)
}

/**
 * 抽取「我的一轮 → TA 的下一轮」真实问答对（检索式 few-shot 的索引单元）。
 * sinceTime > 0 时只取 TA 回复轮晚于该水位的对（增量进化用）。
 */
export function extractPersonaPairs(turns: PersonaTurn[], sinceTime = 0): PersonaPair[] {
  const pairs: PersonaPair[] = []
  for (let i = 1; i < turns.length; i += 1) {
    const reply = turns[i]
    const ask = turns[i - 1]
    if (!reply.isFriend || ask.isFriend) continue
    if (sinceTime > 0 && reply.startTime <= sinceTime) continue
    const user = ask.texts.join(BURST_JOINER).slice(0, PAIR_TEXT_CAP)
    const replies = reply.texts.slice(0, PAIR_MAX_REPLIES).map((t) => t.slice(0, PAIR_TEXT_CAP))
    if (user.length < 2 || replies.length === 0) continue
    pairs.push({ time: reply.startTime, user, replies })
  }
  return pairs
}

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
import type { PersonaStats } from './personaTypes'

/** 对方可用文本消息低于此数时拒绝克隆（语料太少画像必然失真） */
export const MIN_FRIEND_MESSAGES = 50

const TURN_GAP_SECONDS = 3 * 60   // 同一人相邻消息间隔超过此值视为新一轮
const MSG_CHAR_CAP = 200          // 单条消息进语料的字符上限（防超长消息撑爆）
const CORPUS_CHAR_BUDGET = 14000  // 渲染语料的总字符预算（最近的轮次优先）
const BURST_JOINER = '／'         // 一轮内连发多条的分隔符（提示词里会说明）

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

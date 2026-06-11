/**
 * 克隆好友（数字分身）共享类型 —— 主进程与 AI 子进程都会引用，保持纯类型无副作用。
 */
import type { ModelMessage } from 'ai'
import type { AgentProviderConfig } from '../types'

/** 静态画像卡：LLM 从聊天语料中提炼的人设，组 system prompt 用。 */
export interface PersonaCard {
  /** 语气与说话风格描述（2-4 句） */
  tone: string
  /** 性格特征短语 */
  personalityTraits: string[]
  /** 口头禅 / 高频用语 */
  catchphrases: string[]
  /** 标点与排版习惯（如：不爱用句号、爱用~、连发短句） */
  punctuationStyle: string
  /** 对"我"的称呼习惯 */
  addressing: string
  /** 常聊话题 */
  topics: string[]
}

/** 黄金样本：从真实聊天里摘的问答对，replies 保留连发的逐条形态。 */
export interface PersonaFewShot {
  user: string
  replies: string[]
}

/** 本地统计出的风格指标（不经 LLM，组 prompt 时做长度/分条约束用）。 */
export interface PersonaStats {
  /** 参与分析的消息总数 */
  sourceMessageCount: number
  /** 其中对方（被克隆者）的消息数 */
  friendMessageCount: number
  /** 对方单条消息平均字数 */
  avgFriendMsgChars: number
  /** 对方平均一轮连发几条 */
  avgFriendBurst: number
}

export interface PersonaRecord {
  id: number
  accountId: string
  sessionId: string
  displayName: string
  card: PersonaCard
  fewShots: PersonaFewShot[]
  stats: PersonaStats
  modelProvider: string
  modelId: string
  createdAt: number
  updatedAt: number
}

/** 主进程 → AI 子进程的画像提取请求载荷。 */
export interface PersonaExtractInput {
  providerConfig: AgentProviderConfig
  /** 被克隆好友的显示名 */
  friendName: string
  /** 渲染好的对话语料（轮次合并后，连发用 ／ 分隔） */
  corpusText: string
  stats: PersonaStats
}

export interface PersonaExtractResult {
  card: PersonaCard
  fewShots: PersonaFewShot[]
}

/** 聊天引擎用到的画像子集（不带库表元数据）。 */
export interface PersonaChatPersona {
  sessionId: string
  displayName: string
  card: PersonaCard
  fewShots: PersonaFewShot[]
  stats: PersonaStats
}

/** 主进程 → AI 子进程的克隆聊天请求载荷。 */
export interface PersonaChatInput {
  providerConfig: AgentProviderConfig
  persona: PersonaChatPersona
  messages: ModelMessage[]
}

/** persona:buildProgress 推送事件。 */
export interface PersonaBuildProgress {
  sessionId: string
  stage: 'indexing' | 'corpus' | 'extracting' | 'saving' | 'done' | 'error'
  title: string
  percent: number
  detail?: string
}

import type { ConversationGroup, SlashCommand } from './types'

export const AGENT_HISTORY: ConversationGroup[] = []

export const AGENT_SUGGESTIONS: string[] = []

export const AGENT_SLASH_COMMANDS: SlashCommand[] = [
  { command: '/clear', description: '清空当前对话上下文' },
  { command: '/search', description: '按关键词检索聊天记录' },
  { command: '/stats', description: '生成联系人或群聊统计' },
  { command: '/moments', description: '分析朋友圈时间线' },
  { command: '/export', description: '准备聊天记录导出任务' },
  { command: '/think', description: '强制深度分析本轮问题' },
]


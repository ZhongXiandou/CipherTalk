/**
 * 消息/工具渲染相关的纯函数 + 小组件：工具名映射、执行过程分段、检索徽标、出处列表等。
 * 从 AgentPage.tsx 拆出，供主组件和 AgentSubAgentProgress 等复用。
 */
import { Tooltip } from '@heroui/react'
import { QuoteOpen } from '@gravity-ui/icons'
import { isToolUIPart, type UIMessage } from 'ai'
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { Shimmer } from '@/components/ai-elements/shimmer'

// ====== 计划模式控制标记 ======
const PLAN_DELEGATE_ANALYSIS_REQUIRED_PATTERN = /<!--\s*ciphertalk:delegate_analysis=required\s*-->/i
const PLAN_CONTROL_MARKER_PATTERN = /<!--\s*ciphertalk:delegate_analysis=(?:required|not_required)\s*-->/gi

export function stripPlanControlMarkers(text: string): string {
  return text.replace(PLAN_CONTROL_MARKER_PATTERN, '').trim()
}

export function planRequiresDelegateAnalysis(text: string): boolean {
  return PLAN_DELEGATE_ANALYSIS_REQUIRED_PATTERN.test(text)
}

// ====== 工具名 → 中文标签 ======
export const TOOL_LABELS: Record<string, string> = {
  delegate_analysis: '委托子助手',
  remember: '保存记忆',
  recall: '查找记忆',
  list_memories: '查看记忆',
  forget: '删除记忆',
  consolidate_memory: '整理记忆',
  search_moments: '搜索朋友圈',
  moments_stats: '朋友圈统计',
  web_search: '联网搜索',
  generate_image: '生成图片',
  search_moment_media: '找朋友圈图片',
  search_media: '找历史媒体',
  search_similar_media: '以图找图',
  inspect_media_image: '识别历史图片',
  send_media_from_history: '发送历史媒体',
  search_stickers: '翻表情包',
  send_sticker: '发表情包',
  send_random_image: '抽一张图片',
  send_wechat_media: '回复微信媒体',
  send_wechat_file: '回复微信文件',
  export_chat: '导出聊天记录',
  find_files: '查找本机文件',
  search_local_files: '搜索本机内容',
  index_local_files: '索引本机文件',
  add_knowledge_source: '加入资料库',
  search_knowledge: '搜索资料库',
  remove_knowledge_source: '移除资料来源',
  create_artifact: '生成产物文件',
  create_task: '创建任务',
  list_tasks: '查看任务',
  update_task: '更新任务',
  cancel_task: '取消任务',
  run_task_now: '立即运行任务',
  list_audit_logs: '查看审计',
  rollback_operation: '回滚操作',
  desktop_screenshot: '桌面截图',
  desktop_ocr: '桌面 OCR',
  audit_memories: '记忆体检',
  apply_memory_fix: '修复记忆',
  persona_control: '数字分身',
  auto_memory: '自动记忆',
}

export type PersonaControlOutput = {
  success?: boolean
  action?: 'open_persona_chat' | 'ask_persona_build' | 'build_persona' | 'build_session_vectors'
  sessionId?: string
  displayName?: string
  message?: string
  error?: string
}

export function formatToolName(toolName: string) {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__')
    const server = parts[0] || 'server'
    const tool = parts.slice(1).join('__') || 'tool'
    return `MCP: ${server}/${tool}`
  }
  return TOOL_LABELS[toolName] ?? toolName.replace(/[_-]+/g, ' ')
}

export function getPersonaControlOutput(part: unknown): PersonaControlOutput | null {
  const p = part as { type?: unknown; state?: unknown; output?: unknown }
  if (p?.type !== 'tool-persona_control' || p.state !== 'output-available') return null
  if (!p.output || typeof p.output !== 'object') return null
  return p.output as PersonaControlOutput
}

export function renderChainLabel(label: string, active: boolean) {
  if (!active) return label
  return (
    <Shimmer as="span" duration={1.25}>
      {label}
    </Shimmer>
  )
}

export function formatElapsed(ms: number) {
  return `${Math.round(ms / 100) / 10}s`
}

export function toolProgressKey(toolName: string, toolCallId?: string) {
  return toolCallId ? `call:${toolCallId}` : `name:${toolName}`
}

export function toolPartProgressKey(part: unknown, toolName: string) {
  const toolCallId = typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
    ? (part as { toolCallId: string }).toolCallId
    : undefined
  return toolProgressKey(toolName, toolCallId)
}

export function getDelegateTasks(part: unknown): string[] {
  const input = (part as { input?: unknown }).input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const tasks = (input as { tasks?: unknown }).tasks
  if (Array.isArray(tasks)) {
    return tasks
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const task = (item as { task?: unknown }).task
        return typeof task === 'string' ? task.trim() : ''
      })
      .filter(Boolean)
  }
  const task = (input as { task?: unknown }).task
  return typeof task === 'string' && task.trim() ? [task.trim()] : []
}

export type AgentMessagePart = UIMessage['parts'][number]
export type AgentChainPart = AgentMessagePart & {
  input?: unknown
  output?: unknown
  state?: string
  errorText?: string
}

export function isAgentChainPart(part: AgentMessagePart): part is AgentChainPart {
  return part.type === 'reasoning' || isToolUIPart(part)
}

// 参考 Claude 的消息展示：按 parts 原始顺序渲染，只把"连续"的思考/工具调用合并成一个执行过程块，
// 思考与正文交错时保持时间顺序，而不是把所有思考都提到正文前面。
export type AgentRenderSegment =
  | { kind: 'chain'; items: Array<{ part: AgentChainPart; index: number }> }
  | { kind: 'part'; part: AgentMessagePart; index: number }

export function buildRenderSegments(parts: UIMessage['parts']): AgentRenderSegment[] {
  const segments: AgentRenderSegment[] = []
  parts.forEach((part, index) => {
    if (part.type === 'step-start') return
    if (isAgentChainPart(part)) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'chain') last.items.push({ part, index })
      else segments.push({ kind: 'chain', items: [{ part, index }] })
    } else {
      segments.push({ kind: 'part', part, index })
    }
  })
  return segments
}

// ====== 检索工具输出徽标（召回方式/回退原因/命中方式）======
function collectToolBadges(value: unknown, badges: string[] = []): string[] {
  if (badges.length >= 6 || value == null) return badges
  if (typeof value === 'string') {
    const matches = value.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s"'<>)]*)?/gi) || []
    for (const match of matches) {
      const normalized = match.replace(/^https?:\/\//i, '').replace(/\/$/, '')
      if (!badges.includes(normalized)) badges.push(normalized)
      if (badges.length >= 6) break
    }
    return badges
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolBadges(item, badges)
    return badges
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectToolBadges(item, badges)
  }
  return badges
}

const RETRIEVAL_MODE_LABELS: Record<string, string> = {
  hybrid: '召回: 混合',
  keyword: '召回: 关键词',
  vector: '召回: 向量',
}

const RETRIEVAL_FALLBACK_LABELS: Record<string, string> = {
  missing_session: '回退: 未限定会话',
  embedding_not_ready: '回退: 未配置向量',
  vector_no_hits: '回退: 向量无命中',
  vector_error: '回退: 向量失败',
}

const MATCHED_BY_LABELS: Record<string, string> = {
  both: '命中: 向量+关键词',
  vector: '命中: 向量',
  keyword: '命中: 关键词',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function pushBadge(badges: string[], label?: string) {
  if (label && !badges.includes(label)) badges.push(label)
}

function collectMatchedByBadges(value: unknown, badges: string[]) {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  for (const item of items) {
    const obj = asRecord(item)
    const matchedBy = typeof obj?.matchedBy === 'string' ? obj.matchedBy : ''
    if (matchedBy) seen.add(matchedBy)
  }
  for (const key of ['both', 'vector', 'keyword']) {
    if (seen.has(key)) pushBadge(badges, MATCHED_BY_LABELS[key])
  }
}

export function collectRetrievalBadges(toolName: string, output: unknown): string[] {
  if (toolName !== 'semantic_search' && toolName !== 'recall' && toolName !== 'search_messages') return []
  const obj = asRecord(output)
  if (!obj) return []
  const retrieval = asRecord(obj.retrieval)
  const badges: string[] = []
  const mode = typeof retrieval?.mode === 'string'
    ? retrieval.mode
    : typeof obj.mode === 'string'
      ? obj.mode
      : ''
  pushBadge(badges, RETRIEVAL_MODE_LABELS[mode] || (mode ? `召回: ${mode}` : undefined))
  const fallbackReason = typeof retrieval?.fallbackReason === 'string' ? retrieval.fallbackReason : ''
  pushBadge(badges, RETRIEVAL_FALLBACK_LABELS[fallbackReason])
  const rerank = asRecord(retrieval?.rerank)
  if (rerank?.applied === true) pushBadge(badges, '重排: 已应用')
  else if (rerank?.enabled === true) pushBadge(badges, '重排: 已回退')
  collectMatchedByBadges(toolName === 'recall' ? obj.memories : obj.hits, badges)
  return badges.slice(0, 5)
}
// collectToolBadges 目前只在检索徽标之外的历史工具展示里可能用到，保留导出以防未来复用。
export { collectToolBadges }

// ====== 出处（让用户能核对答案来源）======
export type SourceItem = { id: string; sessionId: string; localId?: number; time?: string; sender?: string; text: string }

/** 从助手消息的工具结果里抽出"被引用的真实消息"作为出处。 */
export function extractSources(parts: any[]): SourceItem[] {
  const items: SourceItem[] = []
  const seen = new Set<string>()
  const push = (it: SourceItem) => {
    if (!it.text || !it.sessionId || seen.has(it.id)) return
    seen.add(it.id)
    items.push(it)
  }
  for (const part of parts) {
    if (!isToolUIPart(part) || part.state !== 'output-available') continue
    const name = part.type.replace(/^tool-/, '')
    const out: any = part.output
    if (!out || out.error) continue
    if (Array.isArray(out.evidence)) {
      for (const item of out.evidence) {
        push({
          id: String(item.id || `${item.sessionId}:${item.localId ?? item.text ?? ''}`),
          sessionId: String(item.sessionId || ''),
          localId: item.localId,
          time: item.time,
          sender: item.sender,
          text: String(item.text || ''),
        })
      }
      continue
    }
    if (name === 'get_context' || name === 'get_timeline') {
      const sid = out.sessionId
      for (const m of out.messages || []) {
        push({ id: `${sid}:${m.localId}`, sessionId: sid, localId: m.localId, time: m.time, sender: m.sender, text: m.text })
      }
    } else if (name === 'search_messages' || name === 'semantic_search') {
      const arr = Array.isArray(out) ? out : out.hits || []
      for (const h of arr) {
        const lid = h?.anchor?.localId
        push({ id: `${h.sessionId}:${lid ?? h.excerpt ?? ''}`, sessionId: h.sessionId, localId: lid, time: h.time, sender: h.sender, text: h.excerpt || h.title })
      }
    }
  }
  return items.slice(0, 15)
}

export function MessageSources({
  items,
  nameOf,
}: {
  items: SourceItem[]
  nameOf: (sessionId: string) => string
}) {
  if (items.length === 0) return null
  const senderNameOf = (item: SourceItem) => item.sender || nameOf(item.sessionId)
  return (
    <Sources>
      <SourcesTrigger count={items.length}>
        <QuoteOpen className="size-3.5" />
        <span className="font-medium">出处 {items.length} 条</span>
      </SourcesTrigger>
      <SourcesContent className="w-full flex-row flex-wrap gap-1.5">
        {items.map((it, index) => {
          const senderName = senderNameOf(it)
          return (
            <Tooltip closeDelay={80} delay={120} key={it.id}>
              <Tooltip.Trigger>
                <span className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <QuoteOpen className="size-3 shrink-0 opacity-70" />
                  <span className="shrink-0">{index + 1}</span>
                  <span className="truncate">{senderName}</span>
                </span>
              </Tooltip.Trigger>
              <Tooltip.Content className="w-80 text-xs" placement="top start">
                <div className="mb-1 font-medium text-[11px] text-muted-foreground">
                  {[senderName, it.time].filter(Boolean).join(' · ')}
                </div>
                <div className="max-h-40 overflow-auto whitespace-pre-wrap text-foreground">{it.text}</div>
              </Tooltip.Content>
            </Tooltip>
          )
        })}
      </SourcesContent>
    </Sources>
  )
}

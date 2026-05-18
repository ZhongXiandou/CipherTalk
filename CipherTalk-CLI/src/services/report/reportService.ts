import { statSync } from 'node:fs'
import { dbError } from '../../errors.js'
import { dbAdapter } from '../db/dbAdapter.js'
import { wcdbService } from '../db/wcdbService.js'
import { findMessageDbPaths, resolveDbStoragePath } from '../db/messageDbScanner.js'
import type { RuntimeConfig } from '../../types.js'

export interface ReportOptions {
  year?: number
  allTime?: boolean
  session?: string
  topContacts?: number
  topKeywords?: number
}

export interface ReportMessageRef {
  time: number | null
  content: string
}

export interface ReportSummary {
  totalMessages: number
  sentMessages: number
  receivedMessages: number
  activeDays: number
  topContacts: Array<{ wxid: string; displayName: string; count: number }>
  topKeywords: Array<{ word: string; count: number }>
  hourlyDistribution: Record<string, number>
  firstMessage: ReportMessageRef | null
  lastMessage: ReportMessageRef | null
}

export interface ReportResult {
  scope: 'year' | 'all' | 'session'
  year?: number
  sessionId?: string
  summary: ReportSummary
  meta?: {
    dbCount: number
    tableCount: number
    truncated?: boolean
    note?: string
  }
}

const DEFAULT_TOP_CONTACTS = 10
const DEFAULT_TOP_KEYWORDS = 20
const MAX_TABLES_PER_DB = 200
// 每个 msg_*.db 文件单次查询的消息上限，避免内存炸裂
const MAX_ROWS_PER_TABLE = 50_000

// 简单中文停用词集合（轻量版，避免引入 jieba-wasm 依赖）
const STOP_WORDS = new Set<string>([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '有', '和', '就', '都', '一个',
  '不', '人', '这', '那', '也', '吧', '吗', '啊', '哈', '哦', '呢', '呀', '哎', '嗯',
  'the', 'a', 'an', 'is', 'are', 'and', 'or', 'to', 'in', 'on', 'of', 'for', 'i', 'you',
  'he', 'she', 'it', 'we', 'they', 'this', 'that'
])

function clampPositive(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

async function connect(config: RuntimeConfig): Promise<string> {
  if (!config.dbPath) throw new Error('使用 --db-path 或 miyu init 设置微信数据目录')
  if (!config.keyHex) throw new Error('使用 --key 或 miyu key set 设置数据库密钥')

  const storagePath = resolveDbStoragePath(config.dbPath, config.wxid || '')
  if (!storagePath) throw dbError(`无法定位数据库目录 (db_storage): ${config.dbPath}`)

  const ok = await wcdbService.open(config.dbPath, config.keyHex, config.wxid || '')
  if (!ok) throw dbError('数据库连接失败，请检查 dbPath / keyHex / wxid')

  return storagePath
}

async function buildSessionNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const rows = await dbAdapter.all<{ username: string; nickname?: string; remark?: string }>(
      'session', '',
      'SELECT username, nickname, remark FROM SessionTable'
    )
    for (const row of rows) {
      const username = row.username || ''
      const name = row.remark || row.nickname || username
      if (username) map.set(username, name)
    }
  } catch { /* ignore */ }
  return map
}

function resolveYearRange(opts: ReportOptions): { startTime?: number; endTime?: number; scope: 'year' | 'all'; year?: number } {
  if (opts.allTime) return { scope: 'all' }
  const year = opts.year && Number.isFinite(opts.year) ? Math.floor(opts.year) : new Date().getFullYear()
  const startTime = Math.floor(new Date(year, 0, 1).getTime() / 1000)
  const endTime = Math.floor(new Date(year + 1, 0, 1).getTime() / 1000)
  return { startTime, endTime, scope: 'year', year }
}

interface TableInfo {
  tableName: string
  contentCol: string | null
  hasIsSend: boolean
  hasCreateTime: boolean
  hasTalker: string | null
}

async function describeMessageTable(dbPath: string, tableName: string): Promise<TableInfo | null> {
  try {
    const cols = await dbAdapter.all<{ name: string }>(
      'message', dbPath,
      `PRAGMA table_info("${tableName}")`
    )
    const lowerNames = new Set(cols.map(c => c.name.toLowerCase()))
    if (!lowerNames.has('create_time')) return null
    const contentCol = lowerNames.has('str_content') ? 'str_content'
      : lowerNames.has('content') ? 'content'
      : lowerNames.has('strcontent') ? 'strContent'
      : null
    const hasIsSend = lowerNames.has('is_send') || lowerNames.has('issend')
    const hasTalker = lowerNames.has('talker_id') ? 'talker_id'
      : lowerNames.has('str_talker') ? 'str_talker'
      : lowerNames.has('session_id') ? 'session_id'
      : null
    return { tableName, contentCol, hasIsSend, hasCreateTime: true, hasTalker }
  } catch {
    return null
  }
}

function segmentTextSimple(content: string): string[] {
  const cleaned = String(content || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return []
  // 简单切分：CJK 字符 2-gram，ASCII 单词
  const tokens: string[] = []
  const segments = cleaned.split(/\s+/)
  for (const seg of segments) {
    if (!seg) continue
    if (/^[a-z0-9_]+$/i.test(seg)) {
      if (seg.length >= 2 && seg.length <= 20) tokens.push(seg)
      continue
    }
    // CJK 滑动 2-gram
    for (let i = 0; i < seg.length - 1; i++) {
      const bigram = seg.slice(i, i + 2)
      if (/^[一-鿿]{2}$/.test(bigram)) tokens.push(bigram)
    }
  }
  return tokens.filter(t => !STOP_WORDS.has(t))
}

// 微信消息时间单位是秒；将秒转为对应小时
function hourOfTimestamp(ts: number): number {
  const ms = ts > 1e12 ? ts : ts * 1000
  return new Date(ms).getHours()
}

function dayKeyOfTimestamp(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

interface Aggregator {
  totalMessages: number
  sentMessages: number
  receivedMessages: number
  contactCounts: Map<string, number>
  hourly: Record<string, number>
  activeDays: Set<string>
  keywordCounts: Map<string, number>
  firstMessage: ReportMessageRef | null
  lastMessage: ReportMessageRef | null
}

function newAggregator(): Aggregator {
  const hourly: Record<string, number> = {}
  for (let h = 0; h < 24; h++) hourly[String(h).padStart(2, '0')] = 0
  return {
    totalMessages: 0,
    sentMessages: 0,
    receivedMessages: 0,
    contactCounts: new Map(),
    hourly,
    activeDays: new Set(),
    keywordCounts: new Map(),
    firstMessage: null,
    lastMessage: null
  }
}

function pushMessageRef(slot: 'firstMessage' | 'lastMessage', agg: Aggregator, time: number, content: string): void {
  const existing = agg[slot]
  if (slot === 'firstMessage') {
    if (!existing || (existing.time !== null && time < existing.time)) {
      agg.firstMessage = { time, content }
    }
  } else {
    if (!existing || (existing.time !== null && time > existing.time)) {
      agg.lastMessage = { time, content }
    }
  }
}

export async function generateReport(
  config: RuntimeConfig,
  options: ReportOptions = {}
): Promise<ReportResult> {
  const range = resolveYearRange(options)
  const scope: 'year' | 'all' | 'session' = options.session ? 'session' : range.scope
  const topContactsLimit = clampPositive(options.topContacts, DEFAULT_TOP_CONTACTS)
  const topKeywordsLimit = clampPositive(options.topKeywords, DEFAULT_TOP_KEYWORDS)

  const storagePath = await connect(config)
  const msgDbs = findMessageDbPaths(storagePath)
  if (msgDbs.length === 0) throw dbError(`未找到消息数据库 (msg_*.db): ${storagePath}`)

  // 限制扫描的 msg 库数量，优先按修改时间挑最近的
  let scanDbs = msgDbs
  let truncated = false
  if (msgDbs.length > 20) {
    truncated = true
    scanDbs = [...msgDbs].sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
    }).slice(0, 20)
  }

  const sessionNames = await buildSessionNameMap()
  const agg = newAggregator()
  let tableCount = 0

  for (const dbPath of scanDbs) {
    let tables: { name: string }[]
    try {
      tables = await dbAdapter.all<{ name: string }>(
        'message', dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
      )
    } catch {
      continue
    }
    if (tables.length > MAX_TABLES_PER_DB) {
      truncated = true
      tables = tables.slice(0, MAX_TABLES_PER_DB)
    }

    for (const { name: tableName } of tables) {
      const info = await describeMessageTable(dbPath, tableName)
      if (!info) continue

      // 若指定了 session，并且能识别 talker 字段，先做轻量过滤
      if (options.session && info.hasTalker) {
        try {
          const check = await dbAdapter.get<{ cnt: number }>(
            'message', dbPath,
            `SELECT COUNT(*) as cnt FROM "${tableName}" WHERE "${info.hasTalker}" LIKE ? LIMIT 1`,
            [`%${options.session}%`]
          )
          if (!check || check.cnt === 0) continue
        } catch {
          // 失败则继续后续 query
        }
      }

      const whereClauses: string[] = ['create_time > 0']
      const params: any[] = []
      if (range.startTime !== undefined) {
        whereClauses.push('create_time >= ?')
        params.push(range.startTime)
      }
      if (range.endTime !== undefined) {
        whereClauses.push('create_time < ?')
        params.push(range.endTime)
      }
      if (options.session && info.hasTalker) {
        whereClauses.push(`"${info.hasTalker}" LIKE ?`)
        params.push(`%${options.session}%`)
      }

      const selectCols: string[] = ['create_time']
      if (info.hasIsSend) selectCols.push('is_send')
      if (info.contentCol) selectCols.push(`"${info.contentCol}" as msg_content`)
      if (info.hasTalker) selectCols.push(`"${info.hasTalker}" as talker_key`)

      let rows: any[]
      try {
        rows = await dbAdapter.all<any>(
          'message', dbPath,
          `SELECT ${selectCols.join(', ')}
           FROM "${tableName}"
           WHERE ${whereClauses.join(' AND ')}
           ORDER BY create_time ASC
           LIMIT ?`,
          [...params, MAX_ROWS_PER_TABLE]
        )
        if (rows.length >= MAX_ROWS_PER_TABLE) truncated = true
      } catch {
        continue
      }

      tableCount++

      for (const row of rows) {
        const createTime = Number(row.create_time || 0)
        if (createTime <= 0) continue
        const isSend = row.is_send === 1 || row.is_send === '1'
        const isReceive = row.is_send === 0 || row.is_send === '0'
        agg.totalMessages++
        if (isSend) agg.sentMessages++
        else if (isReceive) agg.receivedMessages++

        const hourKey = String(hourOfTimestamp(createTime)).padStart(2, '0')
        agg.hourly[hourKey] = (agg.hourly[hourKey] || 0) + 1
        agg.activeDays.add(dayKeyOfTimestamp(createTime))

        const talker = row.talker_key ? String(row.talker_key) : ''
        if (talker) {
          agg.contactCounts.set(talker, (agg.contactCounts.get(talker) || 0) + 1)
        }

        const content = typeof row.msg_content === 'string' ? row.msg_content : ''
        if (content) {
          pushMessageRef('firstMessage', agg, createTime, content)
          pushMessageRef('lastMessage', agg, createTime, content)
          // 关键词：仅采样发送方文本（与桌面版口径一致）
          if (isSend) {
            for (const word of segmentTextSimple(content)) {
              agg.keywordCounts.set(word, (agg.keywordCounts.get(word) || 0) + 1)
            }
          }
        } else {
          pushMessageRef('firstMessage', agg, createTime, '')
          pushMessageRef('lastMessage', agg, createTime, '')
        }
      }
    }
  }

  const topContacts = Array.from(agg.contactCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topContactsLimit)
    .map(([wxid, count]) => ({
      wxid,
      displayName: sessionNames.get(wxid) || wxid,
      count
    }))

  const topKeywords = Array.from(agg.keywordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topKeywordsLimit)
    .map(([word, count]) => ({ word, count }))

  const summary: ReportSummary = {
    totalMessages: agg.totalMessages,
    sentMessages: agg.sentMessages,
    receivedMessages: agg.receivedMessages,
    activeDays: agg.activeDays.size,
    topContacts,
    topKeywords,
    hourlyDistribution: agg.hourly,
    firstMessage: agg.firstMessage,
    lastMessage: agg.lastMessage
  }

  return {
    scope,
    year: scope === 'year' ? range.year : undefined,
    sessionId: options.session,
    summary,
    meta: {
      dbCount: scanDbs.length,
      tableCount,
      truncated: truncated || undefined
    }
  }
}

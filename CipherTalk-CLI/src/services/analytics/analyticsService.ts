import { dbError, invalidArgument } from '../../errors.js'
import { dbAdapter } from '../db/dbAdapter.js'
import {
  cleanAccountDirName,
  extractExactMessageTableHash,
  findMessageDbPaths,
  findSessionMessageTables,
  getMessageTableColumns,
  getMessageTableHash,
  getMyRowId,
  hasName2IdTable,
  listExactMessageTables,
  resolveDbStoragePath,
  type MessageTableColumns,
  type MessageTablePair,
} from '../db/messageDbScanner.js'
import { wcdbService } from '../db/wcdbService.js'
import type {
  ContactStats,
  GlobalStats,
  GroupStats,
  KeywordStats,
  SessionStats,
  StatsOptions,
  TimeStats,
} from '../types.js'
import type { RuntimeConfig } from '../../types.js'

// 与桌面端 statsConstants 对齐
export const TEXT_LOCAL_TYPES = [1, 244813135921] as const
export const EXCLUDED_LOCAL_TYPES = [10000, 10002, 266287972401] as const

export const CHINESE_STOP_WORDS = new Set([
  '一个', '这个', '那个', '什么', '怎么', '就是', '还是', '然后', '因为', '所以',
  '可以', '不是', '没有', '已经', '现在', '感觉', '觉得', '一下', '哈哈', '哈哈哈',
  '我们', '你们', '他们', '自己', '这样', '那样', '今天', '明天', '昨天', '时候',
  '真的', '可能', '应该', '不用', '不要', '不能', '知道', '看看', '起来', '出来',
])

export interface AnalyticsContext {
  storagePath: string
  dbPaths: string[]
  cleanedWxid: string
}

async function connect(config: RuntimeConfig): Promise<void> {
  if (!config.dbPath) throw invalidArgument('缺少 --db-path / MIYU_DB_PATH 配置')
  if (!config.keyHex) throw invalidArgument('缺少 --key / MIYU_KEY_HEX 配置')
  const ok = await wcdbService.open(config.dbPath, config.keyHex, config.wxid || '')
  if (!ok) throw dbError('数据库连接失败，请检查 dbPath / keyHex / wxid')
}

async function buildContext(config: RuntimeConfig): Promise<AnalyticsContext> {
  await connect(config)
  const storagePath = resolveDbStoragePath(config.dbPath || '', config.wxid || '')
  if (!storagePath) throw dbError(`无法定位数据库目录 (db_storage): ${config.dbPath}`)
  const dbPaths = findMessageDbPaths(storagePath)
  if (dbPaths.length === 0) throw dbError(`未找到消息数据库 (msg_*.db): ${storagePath}`)
  return {
    storagePath,
    dbPaths,
    cleanedWxid: cleanAccountDirName(config.wxid || ''),
  }
}

function isMediaLocalType(type: number): boolean {
  if (!Number.isFinite(type)) return false
  return type === 3 || type === 34 || type === 43 || type === 47 || type === 49
}

function isTextLocalType(type: number): boolean {
  return (TEXT_LOCAL_TYPES as readonly number[]).includes(type)
}

function excludedTypePlaceholders(): { sql: string; params: number[] } {
  const placeholders = (EXCLUDED_LOCAL_TYPES as readonly number[]).map(() => '?').join(',')
  return { sql: placeholders, params: [...EXCLUDED_LOCAL_TYPES] as number[] }
}

interface TableQueryParts {
  whereSql: string
  whereParams: unknown[]
}

function baseWhere(columns: MessageTableColumns, alias = ''): TableQueryParts {
  const prefix = alias ? `${alias}.` : ''
  const clauses: string[] = [`${prefix}create_time > 0`]
  const params: unknown[] = []
  if (columns.hasLocalType) {
    const excluded = excludedTypePlaceholders()
    clauses.push(`COALESCE(${prefix}local_type, 0) NOT IN (${excluded.sql})`)
    params.push(...excluded.params)
  }
  return { whereSql: `WHERE ${clauses.join(' AND ')}`, whereParams: params }
}

function selectTypeColumn(columns: MessageTableColumns): string | null {
  if (columns.hasLocalType) return 'local_type'
  if (columns.hasType) return 'type'
  return null
}

interface GlobalScanRow {
  total: number
  text_count: number
  media_count: number
  first_time: number | null
  last_time: number | null
}

async function scanGlobal(ctx: AnalyticsContext): Promise<GlobalStats> {
  let totalMessages = 0
  let textMessages = 0
  let mediaMessages = 0
  let firstTime: number | null = null
  let lastTime: number | null = null

  for (const dbPath of ctx.dbPaths) {
    let tables: string[] = []
    try { tables = await listExactMessageTables(dbPath) } catch { continue }
    for (const tableName of tables) {
      try {
        const columns = await getMessageTableColumns(dbPath, tableName)
        const where = baseWhere(columns)
        const typeCol = selectTypeColumn(columns)
        const textCases = typeCol
          ? `SUM(CASE WHEN ${typeCol} IN (${TEXT_LOCAL_TYPES.map(() => '?').join(',')}) THEN 1 ELSE 0 END)`
          : '0'
        const mediaCases = typeCol
          ? `SUM(CASE WHEN ${typeCol} IN (3, 34, 43, 47, 49) THEN 1 ELSE 0 END)`
          : '0'
        const params: unknown[] = []
        const sql = `SELECT COUNT(*) as total,
          ${textCases} as text_count,
          ${mediaCases} as media_count,
          MIN(create_time) as first_time,
          MAX(create_time) as last_time
          FROM "${tableName}" ${where.whereSql}`
        if (typeCol) params.push(...TEXT_LOCAL_TYPES)
        params.push(...where.whereParams)
        const row = await dbAdapter.get<GlobalScanRow>('message', dbPath, sql, params)
        if (!row) continue
        const total = Number(row.total || 0)
        if (total <= 0) continue
        totalMessages += total
        textMessages += Number(row.text_count || 0)
        mediaMessages += Number(row.media_count || 0)
        if (row.first_time && (!firstTime || row.first_time < firstTime)) firstTime = row.first_time
        if (row.last_time && (!lastTime || row.last_time > lastTime)) lastTime = row.last_time
      } catch { /* skip table */ }
    }
  }

  let totalSessions = 0
  try {
    const r = await dbAdapter.get<{ cnt: number }>('session', '', 'SELECT COUNT(*) as cnt FROM SessionTable')
    totalSessions = r?.cnt || 0
  } catch { /* ignore */ }

  let totalContacts = 0
  try {
    const r = await dbAdapter.get<{ cnt: number }>('contact', '', 'SELECT COUNT(*) as cnt FROM contact')
    totalContacts = r?.cnt || 0
  } catch { /* ignore */ }

  return {
    totalMessages,
    totalSessions,
    totalContacts,
    textMessages,
    mediaMessages,
    timeRange: { first: firstTime, last: lastTime },
  }
}

async function listSessionUsernames(): Promise<string[]> {
  try {
    const rows = await dbAdapter.all<{ username: string }>(
      'session',
      '',
      `SELECT username FROM SessionTable
       WHERE username IS NOT NULL AND username NOT LIKE '%@chatroom%'
         AND username NOT LIKE 'gh_%'`
    )
    return rows.map(r => r.username).filter(Boolean)
  } catch {
    return []
  }
}

async function resolveDisplayNames(usernames: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const username of usernames) map.set(username, username)
  if (usernames.length === 0) return map

  try {
    const cols = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
    const colNames = new Set(cols.map(c => c.name))
    const selectCols = ['username']
    for (const col of ['remark', 'nick_name', 'alias']) {
      if (colNames.has(col)) selectCols.push(col)
    }
    for (let i = 0; i < usernames.length; i += 500) {
      const group = usernames.slice(i, i + 500)
      const placeholders = group.map(() => '?').join(',')
      const rows = await dbAdapter.all<Record<string, any>>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username IN (${placeholders})`,
        group
      )
      for (const row of rows) {
        map.set(row.username, row.remark || row.nick_name || row.alias || row.username)
      }
    }
  } catch { /* ignore */ }
  return map
}

async function scanContacts(ctx: AnalyticsContext, top: number): Promise<ContactStats> {
  const privateUsernames = await listSessionUsernames()
  if (privateUsernames.length === 0) return { contacts: [] }

  const hashToUsername = new Map<string, string>()
  for (const username of privateUsernames) hashToUsername.set(getMessageTableHash(username), username)

  const counts = new Map<string, number>()
  for (const dbPath of ctx.dbPaths) {
    let tables: string[] = []
    try { tables = await listExactMessageTables(dbPath) } catch { continue }
    for (const tableName of tables) {
      const hash = extractExactMessageTableHash(tableName)
      if (!hash) continue
      const username = hashToUsername.get(hash)
      if (!username) continue
      try {
        const columns = await getMessageTableColumns(dbPath, tableName)
        const where = baseWhere(columns)
        const row = await dbAdapter.get<{ cnt: number }>(
          'message',
          dbPath,
          `SELECT COUNT(*) as cnt FROM "${tableName}" ${where.whereSql}`,
          where.whereParams
        )
        const cnt = Number(row?.cnt || 0)
        if (cnt > 0) counts.set(username, (counts.get(username) || 0) + cnt)
      } catch { /* skip */ }
    }
  }

  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, top)
  const names = await resolveDisplayNames(ranked.map(([u]) => u))
  return {
    contacts: ranked.map(([wxid, messageCount]) => ({
      wxid,
      displayName: names.get(wxid) || wxid,
      messageCount,
    })),
  }
}

async function scanTime(ctx: AnalyticsContext, sessionId?: string): Promise<TimeStats> {
  const distribution: Record<string, number> = {}
  for (let i = 0; i < 24; i++) distribution[String(i).padStart(2, '0')] = 0

  const pairs: MessageTablePair[] = sessionId
    ? await findSessionMessageTables(ctx.dbPaths, sessionId)
    : await collectAllExactTables(ctx)

  for (const { dbPath, tableName } of pairs) {
    try {
      const columns = await getMessageTableColumns(dbPath, tableName)
      const where = baseWhere(columns)
      const rows = await dbAdapter.all<{ create_time: number }>(
        'message',
        dbPath,
        `SELECT create_time FROM "${tableName}" ${where.whereSql}`,
        where.whereParams
      )
      for (const row of rows) {
        const ts = Number(row.create_time || 0)
        if (!ts) continue
        const hour = new Date(ts * 1000).getHours()
        const key = String(hour).padStart(2, '0')
        distribution[key] = (distribution[key] || 0) + 1
      }
    } catch { /* skip */ }
  }
  return { distribution }
}

async function collectAllExactTables(ctx: AnalyticsContext): Promise<MessageTablePair[]> {
  const pairs: MessageTablePair[] = []
  for (const dbPath of ctx.dbPaths) {
    let tables: string[] = []
    try { tables = await listExactMessageTables(dbPath) } catch { continue }
    for (const tableName of tables) {
      const hash = extractExactMessageTableHash(tableName)
      if (!hash) continue
      pairs.push({ dbPath, tableName, tableHash: hash })
    }
  }
  return pairs
}

interface DirectionResolver {
  resolveSent: (row: Record<string, any>) => 'sent' | 'received' | 'unknown'
}

async function buildDirectionResolver(
  ctx: AnalyticsContext,
  dbPath: string,
  columns: MessageTableColumns
): Promise<DirectionResolver> {
  const hasN2I = await hasName2IdTable(dbPath)
  const myRowId = hasN2I && ctx.cleanedWxid ? await getMyRowId(dbPath, [ctx.cleanedWxid]) : null
  if (hasN2I && myRowId !== null && columns.hasRealSenderId) {
    return {
      resolveSent: row => {
        const v = row.real_sender_id
        if (v === null || v === undefined) return 'unknown'
        return Number(v) === myRowId ? 'sent' : 'received'
      },
    }
  }
  if (columns.hasIsSend) {
    return {
      resolveSent: row => {
        const v = row.is_send ?? row.isSend
        if (v === 1 || v === '1') return 'sent'
        if (v === 0 || v === '0') return 'received'
        return 'unknown'
      },
    }
  }
  return { resolveSent: () => 'unknown' }
}

async function scanSession(ctx: AnalyticsContext, sessionId: string): Promise<SessionStats> {
  const pairs = await findSessionMessageTables(ctx.dbPaths, sessionId)

  let totalMessages = 0
  let textMessages = 0
  let mediaMessages = 0
  let sentMessages = 0
  let receivedMessages = 0
  let firstMessageTime: number | null = null
  let lastMessageTime: number | null = null
  const activeDays = new Set<string>()

  for (const { dbPath, tableName } of pairs) {
    try {
      const columns = await getMessageTableColumns(dbPath, tableName)
      const where = baseWhere(columns)
      const typeCol = selectTypeColumn(columns)
      const selectCols: string[] = ['create_time']
      if (typeCol) selectCols.push(typeCol)
      if (columns.hasIsSend) selectCols.push('is_send')
      if (columns.hasRealSenderId) selectCols.push('real_sender_id')

      const resolver = await buildDirectionResolver(ctx, dbPath, columns)
      const rows = await dbAdapter.all<Record<string, any>>(
        'message',
        dbPath,
        `SELECT ${selectCols.join(', ')} FROM "${tableName}" ${where.whereSql}`,
        where.whereParams
      )
      for (const row of rows) {
        const ts = Number(row.create_time || 0)
        if (!ts) continue
        totalMessages += 1
        const t = typeCol ? Number(row[typeCol]) : NaN
        if (isTextLocalType(t)) textMessages += 1
        else if (isMediaLocalType(t)) mediaMessages += 1
        const direction = resolver.resolveSent(row)
        if (direction === 'sent') sentMessages += 1
        else if (direction === 'received') receivedMessages += 1
        if (!firstMessageTime || ts < firstMessageTime) firstMessageTime = ts
        if (!lastMessageTime || ts > lastMessageTime) lastMessageTime = ts
        const d = new Date(ts * 1000)
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        activeDays.add(key)
      }
    } catch { /* skip */ }
  }

  return {
    totalMessages,
    textMessages,
    mediaMessages,
    sentMessages,
    receivedMessages,
    activeDays: activeDays.size,
    firstMessageTime,
    lastMessageTime,
  }
}

/**
 * 简易中文分词：清洗 → 优先用 Intl.Segmenter (Node 16+ 自带 ICU)；
 * 不可用时退化为按非汉字断字 + 2~4 字 n-gram。不引入 jieba-wasm。
 */
export function segmentForKeywords(content: string): string[] {
  const cleaned = String(content || '')
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || cleaned.length < 2) return []

  let words: string[] = []
  try {
    const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new (Intl as any).Segmenter('zh-CN', { granularity: 'word' })
      : null
    if (seg) {
      const parts: any[] = Array.from(seg.segment(cleaned))
      words = parts.filter(p => p.isWordLike !== false).map(p => String(p.segment))
    } else {
      words = cleaned.split(/\s+/)
    }
  } catch {
    words = cleaned.split(/\s+/)
  }

  return words
    .map(w => w.trim())
    .filter(w => w.length >= 2 && w.length <= 12)
    .filter(w => !/^\d+$/.test(w))
    .filter(w => !CHINESE_STOP_WORDS.has(w))
}

async function scanKeywords(ctx: AnalyticsContext, sessionId?: string): Promise<KeywordStats> {
  const pairs: MessageTablePair[] = sessionId
    ? await findSessionMessageTables(ctx.dbPaths, sessionId)
    : await collectAllExactTables(ctx)

  const counts = new Map<string, number>()
  const MAX_ROWS = 50000
  let scanned = 0

  for (const { dbPath, tableName } of pairs) {
    if (scanned >= MAX_ROWS) break
    try {
      const columns = await getMessageTableColumns(dbPath, tableName)
      if (!columns.contentColumn) continue
      const where = baseWhere(columns)
      const typeCol = selectTypeColumn(columns)
      const filterSql = typeCol
        ? ` AND ${typeCol} IN (${TEXT_LOCAL_TYPES.map(() => '?').join(',')})`
        : ''
      const params = [...where.whereParams]
      if (typeCol) params.push(...TEXT_LOCAL_TYPES)
      const limit = Math.max(0, MAX_ROWS - scanned)
      const rows = await dbAdapter.all<Record<string, any>>(
        'message',
        dbPath,
        `SELECT "${columns.contentColumn}" as content FROM "${tableName}" ${where.whereSql}${filterSql} LIMIT ${limit}`,
        params
      )
      scanned += rows.length
      for (const row of rows) {
        const tokens = segmentForKeywords(String(row.content || ''))
        for (const tk of tokens) counts.set(tk, (counts.get(tk) || 0) + 1)
      }
    } catch { /* skip */ }
  }

  const keywords = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word, count]) => ({ word, count }))
  return { keywords }
}

async function scanGroup(ctx: AnalyticsContext, sessionId: string): Promise<GroupStats> {
  if (!sessionId.endsWith('@chatroom')) {
    throw invalidArgument('group 统计要求 --session 为群聊（以 @chatroom 结尾）')
  }
  const pairs = await findSessionMessageTables(ctx.dbPaths, sessionId)

  let totalMessages = 0
  const members = new Set<string>()

  for (const { dbPath, tableName } of pairs) {
    try {
      const columns = await getMessageTableColumns(dbPath, tableName)
      const where = baseWhere(columns)
      const countRow = await dbAdapter.get<{ cnt: number }>(
        'message',
        dbPath,
        `SELECT COUNT(*) as cnt FROM "${tableName}" ${where.whereSql}`,
        where.whereParams
      )
      totalMessages += Number(countRow?.cnt || 0)

      // 通过 Name2Id 解析 real_sender_id → 用户名
      const hasN2I = await hasName2IdTable(dbPath)
      if (hasN2I && columns.hasRealSenderId) {
        const joinedWhere = baseWhere(columns, 'm')
        const rows = await dbAdapter.all<{ sender: string }>(
          'message',
          dbPath,
          `SELECT DISTINCT n.user_name as sender FROM "${tableName}" m
             JOIN Name2Id n ON m.real_sender_id = n.rowid
             ${joinedWhere.whereSql}`,
          joinedWhere.whereParams
        )
        for (const r of rows) {
          if (r.sender) members.add(r.sender)
        }
      } else if (columns.senderColumn) {
        const rows = await dbAdapter.all<{ sender: string }>(
          'message',
          dbPath,
          `SELECT DISTINCT "${columns.senderColumn}" as sender FROM "${tableName}"
             ${where.whereSql} AND "${columns.senderColumn}" IS NOT NULL AND "${columns.senderColumn}" != ''`,
          where.whereParams
        )
        for (const r of rows) {
          if (r.sender) members.add(r.sender)
        }
      }
    } catch { /* skip */ }
  }

  return { totalMessages, activeMembers: members.size }
}

export class AnalyticsService {
  async run(config: RuntimeConfig, opts: StatsOptions): Promise<GlobalStats | ContactStats | TimeStats | SessionStats | KeywordStats | GroupStats> {
    const ctx = await buildContext(config)
    switch (opts.type) {
      case 'global':
        return scanGlobal(ctx)
      case 'contacts':
        return scanContacts(ctx, Math.max(1, Math.min(opts.top || 20, 500)))
      case 'time':
        return scanTime(ctx, opts.session)
      case 'session':
        if (!opts.session) throw invalidArgument('session 统计需要 --session 参数')
        return scanSession(ctx, opts.session)
      case 'keywords':
        return scanKeywords(ctx, opts.session)
      case 'group':
        if (!opts.session) throw invalidArgument('group 统计需要 --session 参数')
        return scanGroup(ctx, opts.session)
      default:
        throw invalidArgument(`未知统计类型: ${String((opts as { type?: string }).type)}`)
    }
  }
}

export const analyticsService = new AnalyticsService()

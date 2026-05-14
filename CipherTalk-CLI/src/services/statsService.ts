import { dbError } from '../errors.js'
import { dbAdapter } from './db/dbAdapter.js'
import { wcdbService } from './db/wcdbService.js'
import type {
  GlobalStats, ContactStats, TimeStats, SessionStats,
  KeywordStats, GroupStats, StatsOptions
} from './types.js'
import type { RuntimeConfig } from '../types.js'

const EXCLUDED_LOCAL_TYPES = '10000, 10002, 266287972401'

async function ensureConnected(config: RuntimeConfig): Promise<void> {
  if (!config.dbPath) throw new Error('--db-path 未设置')
  if (!config.keyHex) throw new Error('--key 未设置')
  const ok = await wcdbService.open(config.dbPath, config.keyHex, config.wxid || '')
  if (!ok) throw dbError('数据库连接失败')
}

/**
 * 全局统计：总消息数、会话数、联系人数等。
 */
export async function getGlobalStats(config: RuntimeConfig): Promise<GlobalStats> {
  await ensureConnected(config)

  let totalMessages = 0
  let totalSessions = 0

  try {
    const sessionRow = await dbAdapter.get<{ cnt: number }>(
      'session', '', 'SELECT COUNT(*) as cnt FROM SessionTable'
    )
    totalSessions = sessionRow?.cnt || 0
  } catch { /* ignore */ }

  // 统计消息表
  const messageDbs = await listMsgDbs()
  for (const dbPath of messageDbs) {
    try {
      const tables = await dbAdapter.all<{ name: string }>(
        'message', dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
      )
      for (const { name } of tables) {
        try {
          const row = await dbAdapter.get<{ cnt: number }>(
            'message', dbPath,
            `SELECT COUNT(*) as cnt FROM "${name}" WHERE create_time > 0`
          )
          if (row) totalMessages += row.cnt
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return {
    totalMessages,
    totalSessions,
    totalContacts: totalSessions, // session table ≈ contacts
    textMessages: Math.round(totalMessages * 0.6), // 估算
    mediaMessages: Math.round(totalMessages * 0.15),
    timeRange: { first: null, last: null }
  }
}

// 列出所有可访问的 msg_*.db
async function listMsgDbs(): Promise<string[]> {
  // execQuery 的 kind='message' 需要 dbPath，但当前 session handle
  // 通过 native wcdbExecQuery 无法直接 "列出所有 message db"
  // 所以这里只能从 session 表遍历可用的 msg 库
  // 简化处理：尝试查询 session.db 来推断有哪些 msg db
  try {
    const rows = await dbAdapter.all<{ username: string }>(
      'session', '', 'SELECT username FROM SessionTable LIMIT 50'
    )
    // 如果有 session 数据，说明 WCDB 连接正常
    // msg db 的路径通过 native 内部管理，我们直接通过 WCDB 查询
    return [''] // 空字符串让 native 自己处理
  } catch {
    return []
  }
}

type MessageTableInfo = { dbPath: string; tableName: string; contentCol: string }

async function discoverMessageTables(): Promise<MessageTableInfo[]> {
  const tables: MessageTableInfo[] = []
  const msgDbs = await listMsgDbs()
  for (const dbPath of msgDbs) {
    try {
      const rows = await dbAdapter.all<{ name: string }>(
        'message', dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
      )
      for (const { name } of rows) {
        const cols = await dbAdapter.all<{ name: string }>(
          'message', dbPath,
          `PRAGMA table_info("${name}")`
        )
        const colNames = cols.map(c => c.name.toLowerCase())
        const contentCol = colNames.includes('str_content') ? 'str_content'
          : colNames.includes('content') ? 'content'
          : colNames.includes('strcontent') ? 'strContent'
          : ''
        if (!contentCol) continue
        tables.push({ dbPath, tableName: name, contentCol })
      }
    } catch { /* skip */ }
  }
  return tables
}

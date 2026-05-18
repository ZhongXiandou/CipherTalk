import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dbAdapter } from '../../src/services/db/dbAdapter.js'
import { wcdbService } from '../../src/services/db/wcdbService.js'
import {
  analyticsService,
  segmentForKeywords,
  CHINESE_STOP_WORDS,
} from '../../src/services/analytics/analyticsService.js'
import {
  clearMessageDbScannerCache,
  getMessageTableHash,
} from '../../src/services/db/messageDbScanner.js'
import type { RuntimeConfig } from '../../src/types.js'

type RowMap = Record<string, any>

interface MockState {
  msgRows: Record<string, RowMap[]> // tableName -> rows
  msgDbs: string[] // discovered file paths
  sessions: RowMap[] // SessionTable rows
  contactRows: RowMap[] // contact rows
  contactColumns: string[]
  name2id: RowMap[] // [{ rowid, user_name }]
  msgTables: Record<string, string[]> // dbPath -> table names
  columnsForTable: Record<string, RowMap[]> // tableName -> PRAGMA rows
}

let state: MockState
let rootDir: string

function setupTempDb(): { dbRoot: string; storagePath: string; dbFile: string } {
  rootDir = mkdtempSync(join(tmpdir(), 'miyu-analytics-'))
  const storagePath = join(rootDir, 'db_storage')
  const msgDir = join(storagePath, 'message')
  mkdirSync(msgDir, { recursive: true })
  const dbFile = join(msgDir, 'msg_0.db')
  writeFileSync(dbFile, '')
  return { dbRoot: rootDir, storagePath, dbFile }
}

function freshState(): MockState {
  return {
    msgRows: {},
    msgDbs: [],
    sessions: [],
    contactRows: [],
    contactColumns: ['username', 'remark', 'nick_name', 'alias'],
    name2id: [],
    msgTables: {},
    columnsForTable: {},
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

beforeEach(() => {
  clearMessageDbScannerCache()
  state = freshState()
  const setup = setupTempDb()
  state.msgDbs = [setup.dbFile]

  vi.spyOn(wcdbService, 'open').mockResolvedValue(true)

  vi.spyOn(dbAdapter, 'all').mockImplementation(async (kind, path, sqlIn, params) => {
    const sql = normalizeSql(sqlIn)
    if (kind === 'session') {
      if (/SELECT COUNT\(\*\) as cnt FROM SessionTable/i.test(sql)) return [] as any
      if (/SELECT username FROM SessionTable/i.test(sql)) return state.sessions as any
    }
    if (kind === 'contact') {
      if (/PRAGMA table_info\(contact\)/i.test(sql)) {
        return state.contactColumns.map(name => ({ name })) as any
      }
      if (/SELECT (?:[^F]+) FROM contact WHERE username IN/i.test(sql)) {
        const ids = (params || []) as string[]
        return state.contactRows.filter(r => ids.includes(r.username)) as any
      }
      if (/FROM contact/i.test(sql)) return state.contactRows as any
    }
    if (kind === 'message') {
      if (/sqlite_master[\s\S]+lower\(name\) LIKE 'msg_/i.test(sql)) {
        const tables = state.msgTables[String(path)] || []
        return tables.map(name => ({ name })) as any
      }
      if (/PRAGMA table_info\(/i.test(sql)) {
        const tableMatch = sql.match(/PRAGMA table_info\("([^"]+)"\)/i)
        const name = tableMatch?.[1] || ''
        return (state.columnsForTable[name] || []) as any
      }
      if (/FROM Name2Id WHERE user_name = \?/i.test(sql)) {
        // unused: get handles this
      }
      if (/JOIN Name2Id n/i.test(sql)) {
        // DISTINCT sender via name2id join — return distinct senders
        const tableMatch = sql.match(/FROM "([^"]+)"/i)
        const tableName = tableMatch?.[1] || ''
        const rows = state.msgRows[tableName] || []
        const map = new Map<number, string>()
        for (const r of state.name2id) map.set(r.rowid, r.user_name)
        const senders = new Set<string>()
        for (const r of rows) {
          if (r.real_sender_id != null) {
            const name = map.get(r.real_sender_id)
            if (name) senders.add(name)
          }
        }
        return Array.from(senders).map(sender => ({ sender })) as any
      }
      const tableMatch = sql.match(/FROM "([^"]+)"/i)
      if (tableMatch) {
        const tableName = tableMatch[1]
        const rows = state.msgRows[tableName] || []
        // Filter by base WHERE: create_time > 0 + local_type exclusion
        const filtered = rows.filter(r => Number(r.create_time || 0) > 0
          && ![10000, 10002, 266287972401].includes(Number(r.local_type || 0)))
        // Honour distinct sender column when selecting senderColumn
        const selectSenderColMatch = sql.match(/SELECT DISTINCT "([^"]+)" as sender/i)
        if (selectSenderColMatch) {
          const col = selectSenderColMatch[1]
          const senders = new Set<string>()
          for (const r of filtered) {
            const v = r[col]
            if (v) senders.add(String(v))
          }
          return Array.from(senders).map(sender => ({ sender })) as any
        }
        // SELECT create_time, ...
        if (/SELECT create_time/i.test(sql) && !/COUNT/i.test(sql)) {
          return filtered.map(r => ({ create_time: r.create_time, ...r })) as any
        }
        // SELECT "<col>" as content ...
        const contentMatch = sql.match(/SELECT "([^"]+)" as content/i)
        if (contentMatch) {
          const col = contentMatch[1]
          // Apply type filter
          const onlyText = /IN \(\?,\?\)/i.test(sql)
          const result = filtered.filter(r => {
            if (!onlyText) return true
            const t = Number(r.local_type)
            return t === 1 || t === 244813135921
          })
          return result.map(r => ({ content: r[col] })) as any
        }
        // Generic SELECT cols FROM
        return filtered as any
      }
    }
    return [] as any
  })

  vi.spyOn(dbAdapter, 'get').mockImplementation(async (kind, _path, sqlIn, params) => {
    const sql = normalizeSql(sqlIn)
    if (kind === 'session' && /COUNT\(\*\) as cnt FROM SessionTable/i.test(sql)) {
      return { cnt: state.sessions.length } as any
    }
    if (kind === 'contact' && /COUNT\(\*\) as cnt FROM contact/i.test(sql)) {
      return { cnt: state.contactRows.length } as any
    }
    if (kind === 'message') {
      if (/FROM sqlite_master[\s\S]+name = 'Name2Id'/i.test(sql)) {
        return state.name2id.length > 0 ? { name: 'Name2Id' } as any : null
      }
      if (/FROM Name2Id WHERE user_name = \?/i.test(sql)) {
        const userName = (params || [])[0]
        const row = state.name2id.find(r => r.user_name === userName)
        return row ? { rowid: row.rowid } as any : null
      }
      const tableMatch = sql.match(/FROM "([^"]+)"/i)
      if (tableMatch) {
        const tableName = tableMatch[1]
        const rows = (state.msgRows[tableName] || []).filter(r => Number(r.create_time || 0) > 0
          && ![10000, 10002, 266287972401].includes(Number(r.local_type || 0)))
        if (/COUNT\(\*\) as cnt/i.test(sql)) return { cnt: rows.length } as any
        if (/COUNT\(\*\) as total/i.test(sql)) {
          let textCount = 0
          let mediaCount = 0
          let first: number | null = null
          let last: number | null = null
          for (const r of rows) {
            const t = Number(r.local_type)
            if (t === 1 || t === 244813135921) textCount++
            if ([3, 34, 43, 47, 49].includes(t)) mediaCount++
            const ts = Number(r.create_time)
            if (!first || ts < first) first = ts
            if (!last || ts > last) last = ts
          }
          return {
            total: rows.length,
            text_count: textCount,
            media_count: mediaCount,
            first_time: first,
            last_time: last,
          } as any
        }
      }
    }
    return null as any
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
})

function makeConfig(): RuntimeConfig {
  return {
    dbPath: rootDir,
    keyHex: 'a'.repeat(64),
    wxid: 'wxid_self',
    defaultFormat: 'json',
    defaultLimit: 50,
    cacheDir: rootDir,
    configPath: join(rootDir, 'config.json'),
  }
}

function seedSinglePrivate(): void {
  const session = 'wxid_alice'
  const hash = getMessageTableHash(session)
  const tableName = `msg_${hash}`
  state.sessions = [{ username: session }]
  state.contactRows = [{ username: session, remark: 'Alice', nick_name: 'Ally' }]
  state.msgTables[state.msgDbs[0]] = [tableName]
  state.columnsForTable[tableName] = [
    { name: 'local_id' },
    { name: 'create_time' },
    { name: 'local_type' },
    { name: 'is_send' },
    { name: 'message_content' },
    { name: 'real_sender_id' },
  ]
  state.name2id = [
    { rowid: 1, user_name: 'wxid_self' },
    { rowid: 2, user_name: session },
  ]
  state.msgRows[tableName] = [
    { create_time: 1700000000, local_type: 1, is_send: 1, real_sender_id: 1, message_content: '今天天气真好 一起去爬山' },
    { create_time: 1700003600, local_type: 1, is_send: 0, real_sender_id: 2, message_content: '好啊 我们一起去吧' },
    { create_time: 1700007200, local_type: 3, is_send: 1, real_sender_id: 1, message_content: '[图片]' },
    { create_time: 1700090000, local_type: 1, is_send: 0, real_sender_id: 2, message_content: '明天继续 一起爬山' },
    { create_time: 1700100000, local_type: 10000, is_send: 0, real_sender_id: null, message_content: '系统消息' }, // excluded
  ]
}

function seedGroup(): { roomId: string } {
  const roomId = '12345@chatroom'
  const hash = getMessageTableHash(roomId)
  const tableName = `msg_${hash}`
  state.sessions = [{ username: roomId }]
  state.msgTables[state.msgDbs[0]] = [tableName]
  state.columnsForTable[tableName] = [
    { name: 'create_time' },
    { name: 'local_type' },
    { name: 'is_send' },
    { name: 'real_sender_id' },
    { name: 'message_content' },
  ]
  state.name2id = [
    { rowid: 10, user_name: 'wxid_self' },
    { rowid: 11, user_name: 'wxid_member1' },
    { rowid: 12, user_name: 'wxid_member2' },
    { rowid: 13, user_name: 'wxid_member3' },
  ]
  state.msgRows[tableName] = [
    { create_time: 1700000000, local_type: 1, is_send: 1, real_sender_id: 10, message_content: 'hi' },
    { create_time: 1700000010, local_type: 1, is_send: 0, real_sender_id: 11, message_content: 'hello' },
    { create_time: 1700000020, local_type: 1, is_send: 0, real_sender_id: 12, message_content: 'hey' },
    { create_time: 1700000030, local_type: 3, is_send: 0, real_sender_id: 13, message_content: '[image]' },
  ]
  return { roomId }
}

describe('analyticsService', () => {
  it('global subtype aggregates totals, text/media split and time range', async () => {
    seedSinglePrivate()
    const result = await analyticsService.run(makeConfig(), { type: 'global' }) as any
    expect(result.totalMessages).toBe(4)
    expect(result.textMessages).toBe(3)
    expect(result.mediaMessages).toBe(1)
    expect(result.totalSessions).toBe(1)
    expect(result.totalContacts).toBe(1)
    expect(result.timeRange.first).toBe(1700000000)
    expect(result.timeRange.last).toBe(1700090000)
  })

  it('contacts subtype returns real per-contact counts, sorted desc', async () => {
    seedSinglePrivate()
    // Add a second contact with fewer messages
    const other = 'wxid_bob'
    const otherTable = `msg_${getMessageTableHash(other)}`
    state.sessions.push({ username: other })
    state.contactRows.push({ username: other, remark: '', nick_name: 'Bob' })
    state.msgTables[state.msgDbs[0]].push(otherTable)
    state.columnsForTable[otherTable] = state.columnsForTable[`msg_${getMessageTableHash('wxid_alice')}`]
    state.msgRows[otherTable] = [
      { create_time: 1700050000, local_type: 1, is_send: 1, real_sender_id: 1, message_content: 'hi bob' },
    ]

    const result = await analyticsService.run(makeConfig(), { type: 'contacts', top: 5 }) as any
    expect(result.contacts).toHaveLength(2)
    expect(result.contacts[0].wxid).toBe('wxid_alice')
    expect(result.contacts[0].messageCount).toBe(4)
    expect(result.contacts[0].displayName).toBe('Alice')
    expect(result.contacts[1].wxid).toBe('wxid_bob')
    expect(result.contacts[1].messageCount).toBe(1)
    expect(result.contacts[1].displayName).toBe('Bob') // remark empty -> fallback to nick_name
  })

  it('time subtype returns 24-hour distribution keyed by zero-padded hour', async () => {
    seedSinglePrivate()
    const result = await analyticsService.run(makeConfig(), { type: 'time' }) as any
    expect(Object.keys(result.distribution)).toHaveLength(24)
    expect(Object.keys(result.distribution)).toContain('00')
    expect(Object.keys(result.distribution)).toContain('23')
    const total = Object.values<number>(result.distribution).reduce((a, b) => a + b, 0)
    expect(total).toBe(4) // excludes the system message
  })

  it('session subtype throws invalidArgument without --session', async () => {
    seedSinglePrivate()
    await expect(analyticsService.run(makeConfig(), { type: 'session' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  it('session subtype reports sent/received/text/media and active days', async () => {
    seedSinglePrivate()
    const result = await analyticsService.run(makeConfig(), { type: 'session', session: 'wxid_alice' }) as any
    expect(result.totalMessages).toBe(4)
    expect(result.textMessages).toBe(3)
    expect(result.mediaMessages).toBe(1)
    expect(result.sentMessages).toBe(2) // real_sender_id === 1 (wxid_self)
    expect(result.receivedMessages).toBe(2)
    expect(result.firstMessageTime).toBe(1700000000)
    expect(result.lastMessageTime).toBe(1700090000)
    expect(result.activeDays).toBeGreaterThanOrEqual(1)
  })

  it('keywords subtype returns top tokens excluding stopwords and digits', async () => {
    seedSinglePrivate()
    const result = await analyticsService.run(makeConfig(), { type: 'keywords', session: 'wxid_alice' }) as any
    expect(Array.isArray(result.keywords)).toBe(true)
    expect(result.keywords.length).toBeGreaterThan(0)
    expect(result.keywords.length).toBeLessThanOrEqual(30)
    for (const item of result.keywords) {
      expect(typeof item.word).toBe('string')
      expect(item.word.length).toBeGreaterThanOrEqual(2)
      expect(CHINESE_STOP_WORDS.has(item.word)).toBe(false)
      expect(/^\d+$/.test(item.word)).toBe(false)
    }
  })

  it('group subtype rejects non-chatroom session', async () => {
    seedSinglePrivate()
    await expect(
      analyticsService.run(makeConfig(), { type: 'group', session: 'wxid_alice' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('group subtype counts distinct active members via Name2Id', async () => {
    const { roomId } = seedGroup()
    const result = await analyticsService.run(makeConfig(), { type: 'group', session: roomId }) as any
    expect(result.totalMessages).toBe(4)
    expect(result.activeMembers).toBe(4)
  })

  it('group subtype requires --session', async () => {
    seedGroup()
    await expect(analyticsService.run(makeConfig(), { type: 'group' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })
})

describe('segmentForKeywords', () => {
  it('drops punctuation, urls and stopwords', () => {
    const tokens = segmentForKeywords('哈哈哈 看看 这个 https://example.com 你好世界！')
    expect(tokens).not.toContain('哈哈哈')
    expect(tokens).not.toContain('看看')
    expect(tokens).not.toContain('这个')
    expect(tokens.every(t => !/^\d+$/.test(t))).toBe(true)
  })

  it('returns empty array for empty input', () => {
    expect(segmentForKeywords('')).toEqual([])
    expect(segmentForKeywords('a')).toEqual([])
  })
})

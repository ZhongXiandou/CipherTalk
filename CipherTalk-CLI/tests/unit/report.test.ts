import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { wcdbMock, dbAdapterMock, scannerMock } = vi.hoisted(() => ({
  wcdbMock: {
    open: vi.fn(),
    getSnsTimeline: vi.fn(),
    execQuery: vi.fn(),
    execQueryWithParams: vi.fn()
  },
  dbAdapterMock: {
    all: vi.fn(),
    get: vi.fn(),
    exec: vi.fn()
  },
  scannerMock: {
    resolveDbStoragePath: vi.fn(),
    findMessageDbPaths: vi.fn()
  }
}))

vi.mock('../../src/services/db/wcdbService.js', () => ({
  wcdbService: wcdbMock,
  WcdbService: class {}
}))

vi.mock('../../src/services/db/dbAdapter.js', () => ({
  dbAdapter: dbAdapterMock
}))

vi.mock('../../src/services/db/messageDbScanner.js', () => scannerMock)

import { generateReport } from '../../src/services/report/reportService.js'
import type { RuntimeConfig } from '../../src/types.js'

const config: RuntimeConfig = {
  dbPath: '/tmp/fake-db',
  keyHex: 'a'.repeat(64),
  wxid: 'wxid_test',
  defaultFormat: 'json',
  defaultLimit: 20,
  cacheDir: '/tmp/cache',
  configPath: '/tmp/config'
}

// 时间戳（UTC，构造数据时用 Date.UTC 才能跨时区稳定）
// 由于服务内部用本地时区分桶，这里我们用 Date(year,0,1) 构造同等本地时间
function localSeconds(year: number, monthIdx: number, day: number, hour = 9, minute = 0): number {
  return Math.floor(new Date(year, monthIdx, day, hour, minute, 0).getTime() / 1000)
}

beforeEach(() => {
  wcdbMock.open.mockReset()
  dbAdapterMock.all.mockReset()
  dbAdapterMock.get.mockReset()
  scannerMock.resolveDbStoragePath.mockReset()
  scannerMock.findMessageDbPaths.mockReset()

  wcdbMock.open.mockResolvedValue(true)
  scannerMock.resolveDbStoragePath.mockReturnValue('/tmp/fake-db/db_storage')
  scannerMock.findMessageDbPaths.mockReturnValue(['/tmp/fake-db/db_storage/message/msg_0.db'])
})

afterEach(() => {
  vi.clearAllMocks()
})

/**
 * 安装一组通用的 dbAdapter.all 路由：
 *  - SessionTable: 提供 displayName 映射
 *  - sqlite_master tables: 一张 msg 表
 *  - PRAGMA table_info: 给一组列
 *  - 消息查询: 返回给定的 message rows
 */
function installRoutes(messageRows: any[]): void {
  dbAdapterMock.all.mockImplementation((kind: string, _path: string, sql: string) => {
    if (kind === 'session' && /SessionTable/i.test(sql)) {
      return Promise.resolve([
        { username: 'wxid_alice', nickname: 'Alice', remark: '小爱' },
        { username: 'wxid_bob', nickname: 'Bob', remark: '' }
      ])
    }
    if (/sqlite_master/i.test(sql)) {
      return Promise.resolve([{ name: 'Msg_demo' }])
    }
    if (/PRAGMA table_info/i.test(sql)) {
      return Promise.resolve([
        { name: 'create_time' },
        { name: 'is_send' },
        { name: 'str_content' },
        { name: 'talker_id' }
      ])
    }
    if (/FROM "Msg_demo"/i.test(sql)) {
      return Promise.resolve(messageRows)
    }
    return Promise.resolve([])
  })
}

describe('generateReport', () => {
  it('defaults to current year scope when no options given', async () => {
    installRoutes([])
    const result = await generateReport(config)
    expect(result.scope).toBe('year')
    expect(result.year).toBe(new Date().getFullYear())
    expect(result.summary.totalMessages).toBe(0)
    expect(result.summary.activeDays).toBe(0)
    expect(Object.keys(result.summary.hourlyDistribution)).toHaveLength(24)
  })

  it('uses --all-time scope when requested', async () => {
    installRoutes([])
    const result = await generateReport(config, { allTime: true })
    expect(result.scope).toBe('all')
    expect(result.year).toBeUndefined()
  })

  it('switches scope to session when --session is provided', async () => {
    installRoutes([])
    const result = await generateReport(config, { session: 'wxid_alice' })
    expect(result.scope).toBe('session')
    expect(result.sessionId).toBe('wxid_alice')
  })

  it('aggregates messages into summary buckets', async () => {
    const year = new Date().getFullYear()
    const rows = [
      { create_time: localSeconds(year, 5, 10, 9), is_send: 1, msg_content: '你好 world', talker_key: 'wxid_alice' },
      { create_time: localSeconds(year, 5, 10, 14), is_send: 0, msg_content: '哈哈哈', talker_key: 'wxid_alice' },
      { create_time: localSeconds(year, 5, 11, 23), is_send: 1, msg_content: '再见 bye bye', talker_key: 'wxid_bob' },
      { create_time: localSeconds(year, 5, 12, 1), is_send: 0, msg_content: '晚安', talker_key: 'wxid_bob' }
    ]
    installRoutes(rows)

    const result = await generateReport(config, { year })
    expect(result.summary.totalMessages).toBe(4)
    expect(result.summary.sentMessages).toBe(2)
    expect(result.summary.receivedMessages).toBe(2)
    expect(result.summary.activeDays).toBe(3)
    // displayName lookup uses SessionTable
    const top = result.summary.topContacts
    expect(top.length).toBeGreaterThanOrEqual(2)
    const alice = top.find(c => c.wxid === 'wxid_alice')
    const bob = top.find(c => c.wxid === 'wxid_bob')
    expect(alice?.displayName).toBe('小爱')
    expect(alice?.count).toBe(2)
    expect(bob?.displayName).toBe('Bob')
    expect(bob?.count).toBe(2)
    expect(result.summary.firstMessage?.time).toBe(rows[0].create_time)
    expect(result.summary.lastMessage?.time).toBe(rows[3].create_time)
    // hourly distribution should record activity
    expect(result.summary.hourlyDistribution['09']).toBe(1)
    expect(result.summary.hourlyDistribution['14']).toBe(1)
    expect(result.summary.hourlyDistribution['23']).toBe(1)
    expect(result.summary.hourlyDistribution['01']).toBe(1)
  })

  it('extracts keywords from sent messages only', async () => {
    const year = new Date().getFullYear()
    const rows = [
      { create_time: localSeconds(year, 1, 1, 10), is_send: 1, msg_content: 'hello world hello', talker_key: 'wxid_alice' },
      { create_time: localSeconds(year, 1, 1, 11), is_send: 0, msg_content: 'received word should be ignored', talker_key: 'wxid_alice' }
    ]
    installRoutes(rows)
    const result = await generateReport(config, { year, topKeywords: 5 })
    const keywords = result.summary.topKeywords
    const helloEntry = keywords.find(k => k.word === 'hello')
    expect(helloEntry?.count).toBe(2)
    expect(keywords.find(k => k.word === 'received')).toBeUndefined()
  })

  it('throws when no msg databases are found', async () => {
    scannerMock.findMessageDbPaths.mockReturnValue([])
    installRoutes([])
    await expect(generateReport(config, { allTime: true })).rejects.toThrow(/未找到消息数据库/)
  })

  it('throws when dbPath is missing', async () => {
    const bad: RuntimeConfig = { ...config, dbPath: undefined }
    installRoutes([])
    await expect(generateReport(bad)).rejects.toThrow(/db-path|微信数据目录/)
  })
})

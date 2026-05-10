import { ConfigService } from './config'
import { dbAdapter } from './dbAdapter'
import { findMessageDbPaths } from './dbStoragePaths'

export interface ChatStatistics {
  totalMessages: number
  textMessages: number
  imageMessages: number
  voiceMessages: number
  videoMessages: number
  emojiMessages: number
  otherMessages: number
  sentMessages: number
  receivedMessages: number
  firstMessageTime: number | null
  lastMessageTime: number | null
  activeDays: number
  messageTypeCounts: Record<number, number>
}

export interface TimeDistribution {
  hourlyDistribution: Record<number, number>
  weekdayDistribution: Record<number, number>
  monthlyDistribution: Record<string, number>
}

export interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
}

type TimeRangeFilter = {
  startTimeSec?: number
  endTimeSec?: number
}

class AnalyticsService {
  private configService: ConfigService
  private myRowIdCache: Map<string, number | null> = new Map()
  private messageTableCache: Map<string, string[]> = new Map()
  private hasName2IdCache: Map<string, boolean> = new Map()

  constructor() {
    this.configService = new ConfigService()
  }

  private cleanAccountDirName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return trimmed
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
      if (match) return match[1]
      return trimmed
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]
    return trimmed
  }

  private async getMessageTables(dbPath: string): Promise<string[]> {
    const cached = this.messageTableCache.get(dbPath)
    if (cached) return cached
    try {
      const rows = await dbAdapter.all<{ name: string }>(
        'message',
        dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
      )
      const result = rows.map(t => t.name)
      this.messageTableCache.set(dbPath, result)
      return result
    } catch {
      this.messageTableCache.set(dbPath, [])
      return []
    }
  }

  private async hasName2IdTable(dbPath: string): Promise<boolean> {
    if (this.hasName2IdCache.has(dbPath)) return this.hasName2IdCache.get(dbPath)!
    try {
      const row = await dbAdapter.get<any>(
        'message',
        dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'Name2Id'"
      )
      const result = !!row
      this.hasName2IdCache.set(dbPath, result)
      return result
    } catch {
      this.hasName2IdCache.set(dbPath, false)
      return false
    }
  }

  private async getMyRowId(dbPath: string, myWxid: string): Promise<number | null> {
    const cacheKey = `${dbPath}:${myWxid}`
    if (this.myRowIdCache.has(cacheKey)) return this.myRowIdCache.get(cacheKey)!
    try {
      let row = await dbAdapter.get<any>(
        'message',
        dbPath,
        'SELECT rowid FROM Name2Id WHERE user_name = ?',
        [myWxid]
      )
      if (!row) {
        const cleanedWxid = this.cleanAccountDirName(myWxid)
        if (cleanedWxid !== myWxid) {
          row = await dbAdapter.get<any>(
            'message',
            dbPath,
            'SELECT rowid FROM Name2Id WHERE user_name = ?',
            [cleanedWxid]
          )
        }
      }
      const rowId = row?.rowid ?? null
      this.myRowIdCache.set(cacheKey, rowId)
      return rowId
    } catch {
      this.myRowIdCache.set(cacheKey, null)
      return null
    }
  }

  private toTimestampSeconds(value?: number | null): number | undefined {
    if (!value || !Number.isFinite(value) || value <= 0) return undefined
    return value >= 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  }

  private normalizeTimeRange(startTime?: number, endTime?: number): TimeRangeFilter {
    const startTimeSec = this.toTimestampSeconds(startTime)
    const endTimeSec = this.toTimestampSeconds(endTime)
    if (startTimeSec && endTimeSec && startTimeSec > endTimeSec) {
      return { startTimeSec: endTimeSec, endTimeSec: startTimeSec }
    }
    return { startTimeSec, endTimeSec }
  }

  private buildTimeWhereClause(range: TimeRangeFilter, columnName: string = 'create_time'): string {
    const clauses: string[] = []
    if (range.startTimeSec) clauses.push(`${columnName} >= ${range.startTimeSec}`)
    if (range.endTimeSec) clauses.push(`${columnName} <= ${range.endTimeSec}`)
    return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  }

  /**
   * 判断是否为私聊会话（排除群聊、公众号、系统账号等）
   */
  private isPrivateSession(username: string, cleanedWxid: string): boolean {
    if (!username) return false
    if (username.toLowerCase() === cleanedWxid.toLowerCase()) return false
    if (username.includes('@chatroom')) return false
    if (username === 'filehelper') return false
    if (username.startsWith('gh_')) return false
    const excludeList = [
      'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm', 'helper_folders', 'placeholder_foldgroup',
      '@helper_folders', '@placeholder_foldgroup'
    ]
    for (const prefix of excludeList) {
      if (username.startsWith(prefix) || username === prefix) return false
    }
    if (username.includes('@kefu.openim') || username.includes('@openim')) return false
    if (username.includes('service_')) return false
    return true
  }

  /**
   * 获取私聊会话列表
   */
  private async getPrivateSessions(cleanedWxid: string): Promise<string[]> {
    const sessions = await dbAdapter.all<{ username: string }>(
      'session',
      '',
      'SELECT username FROM SessionTable'
    )
    return sessions.map(s => s.username).filter(u => this.isPrivateSession(u, cleanedWxid))
  }

  async getOverallStatistics(startTime?: number, endTime?: number): Promise<{ success: boolean; data?: ChatStatistics; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) return { success: false, error: '未配置微信ID' }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const dbFiles = findMessageDbPaths()
      if (dbFiles.length === 0) return { success: false, error: '未找到消息数据库' }

      const privateUsernames = await this.getPrivateSessions(cleanedWxid)

      const crypto = require('crypto')
      const getTableHash = (username: string) => crypto.createHash('md5').update(username).digest('hex')
      const timeRange = this.normalizeTimeRange(startTime, endTime)
      const timeWhere = this.buildTimeWhereClause(timeRange)
      const privateTableHashes = new Set(privateUsernames.map(u => getTableHash(u)))

      let totalMessages = 0
      let textMessages = 0
      let imageMessages = 0
      let voiceMessages = 0
      let videoMessages = 0
      let emojiMessages = 0
      let otherMessages = 0
      let sentMessages = 0
      let receivedMessages = 0
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null
      const messageTypeCounts: Record<number, number> = {}
      const activeDatesSet = new Set<string>()

      for (const dbPath of dbFiles) {
        const hasName2Id = await this.hasName2IdTable(dbPath)
        const myRowId = hasName2Id ? await this.getMyRowId(dbPath, cleanedWxid) : null
        const tables = await this.getMessageTables(dbPath)

        for (const tableName of tables) {
          const tableHash = tableName.replace('Msg_', '')
          if (!privateTableHashes.has(tableHash)) continue

          try {
            let statsQuery: string
            if (hasName2Id && myRowId !== null) {
              statsQuery = `
                SELECT
                  COUNT(*) as total,
                  SUM(CASE WHEN local_type = 1 OR local_type = 244813135921 THEN 1 ELSE 0 END) as text_count,
                  SUM(CASE WHEN local_type = 3 THEN 1 ELSE 0 END) as image_count,
                  SUM(CASE WHEN local_type = 34 THEN 1 ELSE 0 END) as voice_count,
                  SUM(CASE WHEN local_type = 43 THEN 1 ELSE 0 END) as video_count,
                  SUM(CASE WHEN local_type = 47 THEN 1 ELSE 0 END) as emoji_count,
                  SUM(CASE WHEN real_sender_id = ${myRowId} THEN 1 ELSE 0 END) as sent_count,
                  SUM(CASE WHEN real_sender_id != ${myRowId} THEN 1 ELSE 0 END) as received_count,
                  MIN(create_time) as first_time,
                  MAX(create_time) as last_time
                FROM "${tableName}"${timeWhere}
              `
            } else {
              statsQuery = `
                SELECT
                  COUNT(*) as total,
                  SUM(CASE WHEN local_type = 1 OR local_type = 244813135921 THEN 1 ELSE 0 END) as text_count,
                  SUM(CASE WHEN local_type = 3 THEN 1 ELSE 0 END) as image_count,
                  SUM(CASE WHEN local_type = 34 THEN 1 ELSE 0 END) as voice_count,
                  SUM(CASE WHEN local_type = 43 THEN 1 ELSE 0 END) as video_count,
                  SUM(CASE WHEN local_type = 47 THEN 1 ELSE 0 END) as emoji_count,
                  SUM(CASE WHEN is_send = 1 THEN 1 ELSE 0 END) as sent_count,
                  SUM(CASE WHEN is_send = 0 OR is_send IS NULL THEN 1 ELSE 0 END) as received_count,
                  MIN(create_time) as first_time,
                  MAX(create_time) as last_time
                FROM "${tableName}"${timeWhere}
              `
            }

            const stats = await dbAdapter.get<any>('message', dbPath, statsQuery)

            if (stats && stats.total > 0) {
              totalMessages += stats.total
              textMessages += stats.text_count || 0
              imageMessages += stats.image_count || 0
              voiceMessages += stats.voice_count || 0
              videoMessages += stats.video_count || 0
              emojiMessages += stats.emoji_count || 0
              sentMessages += stats.sent_count || 0
              receivedMessages += stats.received_count || 0

              if (stats.first_time) {
                if (!firstMessageTime || stats.first_time < firstMessageTime) firstMessageTime = stats.first_time
              }
              if (stats.last_time) {
                if (!lastMessageTime || stats.last_time > lastMessageTime) lastMessageTime = stats.last_time
              }

              const dates = await dbAdapter.all<{ day: string }>(
                'message',
                dbPath,
                `SELECT DISTINCT date(create_time, 'unixepoch', 'localtime') as day FROM "${tableName}"${timeWhere}`
              )
              for (const { day } of dates) {
                if (day) activeDatesSet.add(day)
              }

              const typeCounts = await dbAdapter.all<{ local_type: number; count: number }>(
                'message',
                dbPath,
                `SELECT local_type, COUNT(*) as count FROM "${tableName}"${timeWhere ? timeWhere : ''} GROUP BY local_type`
              )
              for (const { local_type, count } of typeCounts) {
                messageTypeCounts[local_type] = (messageTypeCounts[local_type] || 0) + count
              }
            }
          } catch (e) {
            // skip
          }
        }
      }

      otherMessages = totalMessages - textMessages - imageMessages - voiceMessages - videoMessages - emojiMessages

      return {
        success: true,
        data: {
          totalMessages,
          textMessages,
          imageMessages,
          voiceMessages,
          videoMessages,
          emojiMessages,
          otherMessages: Math.max(0, otherMessages),
          sentMessages,
          receivedMessages,
          firstMessageTime,
          lastMessageTime,
          activeDays: activeDatesSet.size,
          messageTypeCounts
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getContactRankings(limit: number = 20, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: ContactRanking[]; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) return { success: false, error: '未配置微信ID' }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const dbFiles = findMessageDbPaths()
      if (dbFiles.length === 0) return { success: false, error: '未找到消息数据库' }

      const privateUsernames = await this.getPrivateSessions(cleanedWxid)

      const contactStats: Map<string, {
        messageCount: number
        sentCount: number
        receivedCount: number
        lastMessageTime: number | null
      }> = new Map()

      const crypto = require('crypto')
      const getTableHash = (username: string) => crypto.createHash('md5').update(username).digest('hex')
      const timeRange = this.normalizeTimeRange(startTime, endTime)
      const timeWhere = this.buildTimeWhereClause(timeRange)

      const tableHashToUsername = new Map<string, string>()
      for (const username of privateUsernames) {
        tableHashToUsername.set(getTableHash(username), username)
      }

      for (const dbPath of dbFiles) {
        const hasName2Id = await this.hasName2IdTable(dbPath)
        const myRowId = hasName2Id ? await this.getMyRowId(dbPath, cleanedWxid) : null
        const tables = await this.getMessageTables(dbPath)

        for (const tableName of tables) {
          const tableHash = tableName.startsWith('Msg_') ? tableName.slice(4) : tableName.replace('Msg_', '')
          const username = tableHashToUsername.get(tableHash)
          if (!username) continue

          try {
            let statsQuery: string
            if (hasName2Id && myRowId !== null) {
              statsQuery = `
                SELECT
                  COUNT(*) as total,
                  SUM(CASE WHEN real_sender_id = ${myRowId} THEN 1 ELSE 0 END) as sent_count,
                  SUM(CASE WHEN real_sender_id != ${myRowId} THEN 1 ELSE 0 END) as received_count,
                  MAX(create_time) as last_time
                FROM "${tableName}"${timeWhere}
              `
            } else {
              statsQuery = `
                SELECT
                  COUNT(*) as total,
                  SUM(CASE WHEN is_send = 1 THEN 1 ELSE 0 END) as sent_count,
                  SUM(CASE WHEN is_send = 0 OR is_send IS NULL THEN 1 ELSE 0 END) as received_count,
                  MAX(create_time) as last_time
                FROM "${tableName}"${timeWhere}
              `
            }

            const stats = await dbAdapter.get<any>('message', dbPath, statsQuery)

            if (stats && stats.total > 0) {
              const existing = contactStats.get(username)
              if (existing) {
                existing.messageCount += stats.total
                existing.sentCount += stats.sent_count || 0
                existing.receivedCount += stats.received_count || 0
                if (stats.last_time && (!existing.lastMessageTime || stats.last_time > existing.lastMessageTime)) {
                  existing.lastMessageTime = stats.last_time
                }
              } else {
                contactStats.set(username, {
                  messageCount: stats.total,
                  sentCount: stats.sent_count || 0,
                  receivedCount: stats.received_count || 0,
                  lastMessageTime: stats.last_time || null
                })
              }
            }
          } catch {
          }
        }
      }

      // 查询联系人信息（昵称 / 头像）
      const contactInfo: Map<string, { displayName: string; avatarUrl?: string }> = new Map()
      const usernames = Array.from(contactStats.keys())

      if (usernames.length > 0) {
        // 检查 contact 表结构
        const columns = await dbAdapter.all<{ name: string }>(
          'contact',
          '',
          'PRAGMA table_info(contact)'
        )
        const columnNames = columns.map(c => c.name)
        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')

        const selectCols = ['username', 'nick_name', 'remark']
        if (hasBigHeadUrl) selectCols.push('big_head_url')
        if (hasSmallHeadUrl) selectCols.push('small_head_url')
        const placeholders = usernames.map(() => '?').join(',')

        const contacts = await dbAdapter.all<{
          username: string; nick_name?: string; remark?: string;
          big_head_url?: string; small_head_url?: string
        }>(
          'contact',
          '',
          `SELECT ${selectCols.join(', ')} FROM contact WHERE username IN (${placeholders})`,
          usernames
        )

        for (const contact of contacts) {
          const avatarUrl = (hasBigHeadUrl && contact.big_head_url)
            ? contact.big_head_url
            : (hasSmallHeadUrl && contact.small_head_url)
              ? contact.small_head_url
              : undefined
          contactInfo.set(contact.username, {
            displayName: contact.remark || contact.nick_name || contact.username,
            avatarUrl
          })
        }
      }

      const rankings: ContactRanking[] = Array.from(contactStats.entries())
        .map(([username, stats]) => {
          const info = contactInfo.get(username)
          return {
            username,
            displayName: info?.displayName || username,
            avatarUrl: info?.avatarUrl,
            messageCount: stats.messageCount,
            sentCount: stats.sentCount,
            receivedCount: stats.receivedCount,
            lastMessageTime: stats.lastMessageTime
          }
        })
        .sort((a, b) => {
          const messageCountDelta = b.messageCount - a.messageCount
          if (messageCountDelta !== 0) return messageCountDelta
          return (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
        })
        .slice(0, limit)

      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getTimeDistribution(startTime?: number, endTime?: number): Promise<{ success: boolean; data?: TimeDistribution; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) return { success: false, error: '未配置微信ID' }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const privateUsernames = await this.getPrivateSessions(cleanedWxid)

      const crypto = require('crypto')
      const getTableHash = (username: string) => crypto.createHash('md5').update(username).digest('hex')
      const privateTableHashes = new Set(privateUsernames.map(u => getTableHash(u)))
      const timeRange = this.normalizeTimeRange(startTime, endTime)
      const timeWhere = this.buildTimeWhereClause(timeRange)

      const dbFiles = findMessageDbPaths()

      const hourlyDistribution: Record<number, number> = {}
      const weekdayDistribution: Record<number, number> = {}
      const monthlyDistribution: Record<string, number> = {}
      for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0
      for (let i = 1; i <= 7; i++) weekdayDistribution[i] = 0

      for (const dbPath of dbFiles) {
        const tables = await this.getMessageTables(dbPath)

        for (const tableName of tables) {
          const tableHash = tableName.replace('Msg_', '')
          if (!privateTableHashes.has(tableHash)) continue

          try {
            const hourly = await dbAdapter.all<{ hour: number; count: number }>(
              'message',
              dbPath,
              `SELECT CAST(strftime('%H', create_time, 'unixepoch', 'localtime') AS INTEGER) as hour, COUNT(*) as count FROM "${tableName}"${timeWhere} GROUP BY hour`
            )
            for (const { hour, count } of hourly) {
              hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + count
            }

            const weekday = await dbAdapter.all<{ dow: number; count: number }>(
              'message',
              dbPath,
              `SELECT CAST(strftime('%w', create_time, 'unixepoch', 'localtime') AS INTEGER) as dow, COUNT(*) as count FROM "${tableName}"${timeWhere} GROUP BY dow`
            )
            for (const { dow, count } of weekday) {
              const weekdayNum = dow === 0 ? 7 : dow
              weekdayDistribution[weekdayNum] = (weekdayDistribution[weekdayNum] || 0) + count
            }

            const monthly = await dbAdapter.all<{ month: string; count: number }>(
              'message',
              dbPath,
              `SELECT strftime('%Y-%m', create_time, 'unixepoch', 'localtime') as month, COUNT(*) as count FROM "${tableName}"${timeWhere} GROUP BY month`
            )
            for (const { month, count } of monthly) {
              if (month) monthlyDistribution[month] = (monthlyDistribution[month] || 0) + count
            }
          } catch (e) {
            // skip
          }

        }
      }

      return {
        success: true,
        data: { hourlyDistribution, weekdayDistribution, monthlyDistribution }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close() {
    this.myRowIdCache.clear()
    this.messageTableCache.clear()
    this.hasName2IdCache.clear()
  }
}

export const analyticsService = new AnalyticsService()

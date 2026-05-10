import { dbAdapter } from './dbAdapter'
import { findMessageDbPaths } from './dbStoragePaths'

export interface GroupChatInfo {
  username: string
  displayName: string
  memberCount: number
  avatarUrl?: string
  sortTimestamp?: number
}

export interface GroupMember {
  username: string
  displayName: string
  avatarUrl?: string
}

export interface GroupMessageRank {
  member: GroupMember
  messageCount: number
}

export interface GroupActiveHours {
  hourlyDistribution: Record<number, number>
}

export interface MediaTypeCount {
  type: number
  name: string
  count: number
}

export interface GroupMediaStats {
  typeCounts: MediaTypeCount[]
  total: number
}

class GroupAnalyticsService {
  /**
   * 将 wcdb 返回的 BLOB 值标准化为 Buffer。
   * native 层会把 bytes 列以 base64 字符串返回，此处兼容字符串 / Buffer / Uint8Array / number[]。
   */
  private toBuffer(value: any): Buffer | null {
    if (value == null) return null
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (Array.isArray(value)) return Buffer.from(value)
    if (typeof value === 'string') {
      try { return Buffer.from(value, 'base64') } catch { return null }
    }
    return null
  }

  /**
   * 从 head_image.db 批量获取头像（转换为 base64 data URL）
   */
  private async getAvatarsFromHeadImageDb(usernames: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    if (usernames.length === 0) return result

    try {
      const placeholders = usernames.map(() => '?').join(',')
      const rows = await dbAdapter.all<any>(
        'head_image',
        '',
        `SELECT username, image_buffer FROM head_image WHERE username IN (${placeholders})`,
        usernames
      )
      for (const row of rows) {
        const buffer = this.toBuffer(row?.image_buffer)
        if (!buffer || buffer.length === 0) continue
        const base64 = buffer.toString('base64')
        result[row.username] = `data:image/jpeg;base64,${base64}`
      }
    } catch (e) {
      console.error('从 head_image.db 获取头像失败:', e)
    }

    return result
  }

  async getGroupChats(): Promise<{ success: boolean; data?: GroupChatInfo[]; error?: string }> {
    try {
      // 查询所有群聊会话，包含时间戳用于排序
      const sessions = await dbAdapter.all<{ username: string; sort_timestamp?: number; last_timestamp?: number }>(
        'session',
        '',
        `SELECT username, sort_timestamp, last_timestamp
         FROM SessionTable
         WHERE username LIKE '%@chatroom'`
      )

      if (sessions.length === 0) {
        return { success: true, data: [] }
      }

      const groupInfoMap: Map<string, { displayName: string; avatarUrl?: string }> = new Map()
      const memberCountMap: Map<string, number> = new Map()

      // 获取 contact 表列信息，探测是否包含头像 URL 列
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

      const usernames = sessions.map(s => s.username)
      const placeholders = usernames.map(() => '?').join(',')
      const contactRows = await dbAdapter.all<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username IN (${placeholders})`,
        usernames
      )

      const missingAvatars: string[] = []
      for (const contact of contactRows) {
        const avatarUrl = (hasBigHeadUrl && contact.big_head_url)
          ? contact.big_head_url
          : (hasSmallHeadUrl && contact.small_head_url)
            ? contact.small_head_url
            : undefined

        groupInfoMap.set(contact.username, {
          displayName: contact.remark || contact.nick_name || contact.username,
          avatarUrl
        })

        if (!avatarUrl) {
          missingAvatars.push(contact.username)
        }
      }

      // 从 head_image.db 获取缺失的头像
      if (missingAvatars.length > 0) {
        const headImageAvatars = await this.getAvatarsFromHeadImageDb(missingAvatars)
        for (const username of missingAvatars) {
          const avatarUrl = headImageAvatars[username]
          if (avatarUrl) {
            const info = groupInfoMap.get(username)
            if (info) info.avatarUrl = avatarUrl
          }
        }
      }

      // 获取群成员数量：需要 chatroom_member + name2id 两张表
      try {
        const tables = await dbAdapter.all<{ name: string }>(
          'contact',
          '',
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chatroom_member', 'name2id')"
        )
        const hasChatroomMember = tables.some(t => t.name === 'chatroom_member')
        const hasName2Id = tables.some(t => t.name === 'name2id')

        if (hasChatroomMember && hasName2Id) {
          for (const { username } of sessions) {
            try {
              const row = await dbAdapter.get<{ count: number }>(
                'contact',
                '',
                `SELECT COUNT(*) as count FROM chatroom_member
                 WHERE room_id = (SELECT rowid FROM name2id WHERE username = ?)`,
                [username]
              )
              memberCountMap.set(username, row?.count || 0)
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }

      const groups: GroupChatInfo[] = sessions.map(({ username, sort_timestamp, last_timestamp }) => {
        const info = groupInfoMap.get(username)
        return {
          username,
          displayName: info?.displayName || username,
          memberCount: memberCountMap.get(username) || 0,
          avatarUrl: info?.avatarUrl,
          sortTimestamp: sort_timestamp || last_timestamp || 0
        }
      }).sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0))

      return { success: true, data: groups }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMembers(chatroomId: string): Promise<{ success: boolean; data?: GroupMember[]; error?: string }> {
    try {
      const members: GroupMember[] = []
      const missingAvatars: string[] = []

      try {
        const memberRows = await dbAdapter.all<{ username: string; nick_name?: string; remark?: string; small_head_url?: string }>(
          'contact',
          '',
          `SELECT n.username, c.nick_name, c.remark, c.small_head_url
           FROM chatroom_member m
           JOIN name2id n ON m.member_id = n.rowid
           LEFT JOIN contact c ON n.username = c.username
           WHERE m.room_id = (SELECT rowid FROM name2id WHERE username = ?)`,
          [chatroomId]
        )

        for (const row of memberRows) {
          const avatarUrl = row.small_head_url
          members.push({
            username: row.username,
            displayName: row.remark || row.nick_name || row.username,
            avatarUrl
          })
          if (!avatarUrl) missingAvatars.push(row.username)
        }
      } catch { /* skip */ }

      if (missingAvatars.length > 0) {
        const headImageAvatars = await this.getAvatarsFromHeadImageDb(missingAvatars)
        for (const member of members) {
          if (!member.avatarUrl) {
            const avatarUrl = headImageAvatars[member.username]
            if (avatarUrl) member.avatarUrl = avatarUrl
          }
        }
      }

      return { success: true, data: members }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMessageRanking(
    chatroomId: string,
    limit: number = 20,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; data?: GroupMessageRank[]; error?: string }> {
    try {
      const dbFiles = findMessageDbPaths()
      if (dbFiles.length === 0) {
        return { success: false, error: '未找到消息数据库' }
      }

      const crypto = require('crypto')
      const tableHash = crypto.createHash('md5').update(chatroomId).digest('hex')
      const messageCounts: Map<string, number> = new Map()

      for (const dbPath of dbFiles) {
        let tables: { name: string }[] = []
        try {
          tables = await dbAdapter.all<{ name: string }>(
            'message',
            dbPath,
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
          )
        } catch { continue }

        for (const { name: tableName } of tables) {
          if (!tableName.includes(tableHash)) continue

          try {
            // 检测 Name2Id 表是否存在
            const name2idRow = await dbAdapter.get<any>(
              'message',
              dbPath,
              "SELECT name FROM sqlite_master WHERE type='table' AND name = 'Name2Id'"
            )
            const hasName2Id = !!name2idRow

            let senderCounts: { sender: string; count: number }[] = []

            if (hasName2Id) {
              const params: any[] = []
              let whereSql = ''
              if (startTime != null && endTime != null) {
                whereSql = 'WHERE m.create_time >= ? AND m.create_time <= ?'
                params.push(startTime, endTime)
              } else if (startTime != null) {
                whereSql = 'WHERE m.create_time >= ?'
                params.push(startTime)
              } else if (endTime != null) {
                whereSql = 'WHERE m.create_time <= ?'
                params.push(endTime)
              }
              senderCounts = await dbAdapter.all<{ sender: string; count: number }>(
                'message',
                dbPath,
                `SELECT n.user_name as sender, COUNT(*) as count
                 FROM "${tableName}" m
                 JOIN Name2Id n ON m.real_sender_id = n.rowid
                 ${whereSql}
                 GROUP BY m.real_sender_id`,
                params
              )
            } else {
              const params: any[] = []
              let whereSql = "WHERE sender IS NOT NULL AND sender != ''"
              if (startTime != null && endTime != null) {
                whereSql += ' AND create_time >= ? AND create_time <= ?'
                params.push(startTime, endTime)
              } else if (startTime != null) {
                whereSql += ' AND create_time >= ?'
                params.push(startTime)
              } else if (endTime != null) {
                whereSql += ' AND create_time <= ?'
                params.push(endTime)
              }
              senderCounts = await dbAdapter.all<{ sender: string; count: number }>(
                'message',
                dbPath,
                `SELECT sender, COUNT(*) as count
                 FROM "${tableName}"
                 ${whereSql}
                 GROUP BY sender`,
                params
              )
            }

            for (const { sender, count } of senderCounts) {
              if (sender) {
                messageCounts.set(sender, (messageCounts.get(sender) || 0) + count)
              }
            }
          } catch { /* skip */ }
        }
      }

      // 获取成员信息
      const membersResult = await this.getGroupMembers(chatroomId)
      const memberMap: Map<string, GroupMember> = new Map()
      if (membersResult.success && membersResult.data) {
        for (const m of membersResult.data) memberMap.set(m.username, m)
      }

      const rankings: GroupMessageRank[] = Array.from(messageCounts.entries())
        .map(([username, count]) => ({
          member: memberMap.get(username) || { username, displayName: username },
          messageCount: count
        }))
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, limit)

      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupActiveHours(
    chatroomId: string,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; data?: GroupActiveHours; error?: string }> {
    try {
      const dbFiles = findMessageDbPaths()
      if (dbFiles.length === 0) {
        return { success: false, error: '未找到消息数据库' }
      }

      const crypto = require('crypto')
      const tableHash = crypto.createHash('md5').update(chatroomId).digest('hex')
      const hourlyDistribution: Record<number, number> = {}
      for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0

      for (const dbPath of dbFiles) {
        let tables: { name: string }[] = []
        try {
          tables = await dbAdapter.all<{ name: string }>(
            'message',
            dbPath,
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
          )
        } catch { continue }

        for (const { name: tableName } of tables) {
          if (!tableName.includes(tableHash)) continue

          try {
            const params: any[] = []
            let whereSql = ''
            if (startTime != null && endTime != null) {
              whereSql = 'WHERE create_time >= ? AND create_time <= ?'
              params.push(startTime, endTime)
            } else if (startTime != null) {
              whereSql = 'WHERE create_time >= ?'
              params.push(startTime)
            } else if (endTime != null) {
              whereSql = 'WHERE create_time <= ?'
              params.push(endTime)
            }
            const hourly = await dbAdapter.all<{ hour: number; count: number }>(
              'message',
              dbPath,
              `SELECT
                 CAST(strftime('%H', create_time, 'unixepoch', 'localtime') AS INTEGER) as hour,
                 COUNT(*) as count
               FROM "${tableName}"
               ${whereSql}
               GROUP BY hour`,
              params
            )

            for (const { hour, count } of hourly) {
              hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + count
            }
          } catch { /* skip */ }
        }
      }

      return { success: true, data: { hourlyDistribution } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMediaStats(
    chatroomId: string,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; data?: GroupMediaStats; error?: string }> {
    try {
      const dbFiles = findMessageDbPaths()
      if (dbFiles.length === 0) {
        return { success: false, error: '未找到消息数据库' }
      }

      const crypto = require('crypto')
      const tableHash = crypto.createHash('md5').update(chatroomId).digest('hex')

      const mainTypes = new Set([1, 3, 34, 43, 47, 49])
      const typeNames: Record<number, string> = {
        1: '文本',
        3: '图片',
        34: '语音',
        43: '视频',
        47: '表情包',
        49: '链接/文件',
      }
      const typeCounts: Map<number, number> = new Map()

      for (const dbPath of dbFiles) {
        let tables: { name: string }[] = []
        try {
          tables = await dbAdapter.all<{ name: string }>(
            'message',
            dbPath,
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
          )
        } catch { continue }

        for (const { name: tableName } of tables) {
          if (!tableName.includes(tableHash)) continue

          try {
            const params: any[] = []
            let whereSql = ''
            if (startTime != null && endTime != null) {
              whereSql = 'WHERE create_time >= ? AND create_time <= ?'
              params.push(startTime, endTime)
            } else if (startTime != null) {
              whereSql = 'WHERE create_time >= ?'
              params.push(startTime)
            } else if (endTime != null) {
              whereSql = 'WHERE create_time <= ?'
              params.push(endTime)
            }
            const stats = await dbAdapter.all<{ local_type: number; count: number }>(
              'message',
              dbPath,
              `SELECT local_type, COUNT(*) as count
               FROM "${tableName}"
               ${whereSql}
               GROUP BY local_type`,
              params
            )

            for (const { local_type, count } of stats) {
              if (mainTypes.has(local_type)) {
                typeCounts.set(local_type, (typeCounts.get(local_type) || 0) + count)
              } else {
                typeCounts.set(-1, (typeCounts.get(-1) || 0) + count)
              }
            }
          } catch { /* skip */ }
        }
      }

      const result: MediaTypeCount[] = Array.from(typeCounts.entries())
        .filter(([, count]) => count > 0)
        .map(([type, count]) => ({
          type,
          name: type === -1 ? '其他' : (typeNames[type] || `其他`),
          count
        }))
        .sort((a, b) => b.count - a.count)

      const total = result.reduce((sum, item) => sum + item.count, 0)

      return { success: true, data: { typeCounts: result, total } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close() {
    // dbAdapter 由 wcdbService 统一管理连接，此处无本地缓存需清理
  }
}

export const groupAnalyticsService = new GroupAnalyticsService()

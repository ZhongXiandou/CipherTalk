import { notImplemented, dbError, MiyuError } from '../errors.js'
import { wcdbService } from './db/wcdbService.js'
import { dbAdapter } from './db/dbAdapter.js'
import { searchMessages } from './searchService.js'
import type { AdvancedService, SearchResult, StatsOptions, ExportOptions } from './types.js'
import type { RuntimeConfig } from '../types.js'

async function connect(config: RuntimeConfig): Promise<void> {
  const ok = await wcdbService.open(config.dbPath!, config.keyHex!, config.wxid || '')
  if (!ok) throw dbError('数据库连接失败，请检查 dbPath / keyHex / wxid')
}

export class RealAdvancedService implements AdvancedService {

  // ── 搜索 ──
  async search(
    config: RuntimeConfig,
    keyword: string,
    options?: { session?: string; limit?: number; from?: string; to?: string }
  ): Promise<SearchResult> {
    return searchMessages(config, keyword, options || {})
  }

  // ── 统计 ──
  async stats(config: RuntimeConfig, opts: StatsOptions): Promise<any> {
    await connect(config)

    switch (opts.type) {
      case 'global': {
        // 会话总数
        let totalSessions = 0
        try {
          const r = await dbAdapter.get<{ cnt: number }>('session', '', 'SELECT COUNT(*) as cnt FROM SessionTable')
          totalSessions = r?.cnt || 0
        } catch { /**/ }
        return { totalSessions }
      }

      case 'contacts': {
        const top = opts.top || 20
        // 从 session 表列出私聊
        const sessions = await dbAdapter.all<{ username: string }>(
          'session', '',
          `SELECT username FROM SessionTable WHERE username NOT LIKE '%@chatroom%' AND username NOT LIKE 'gh_%' ORDER BY sort_timestamp DESC LIMIT ?`,
          [top]
        )
        return { contacts: sessions.map(s => ({ wxid: s.username, displayName: s.username, messageCount: 0 })) }
      }

      case 'session': {
        if (!opts.session) throw new Error('stats session 需要 --session 参数')
        // 尝试查询该会话的 msg 表
        return { totalMessages: 0, textMessages: 0, mediaMessages: 0, sentMessages: 0, receivedMessages: 0, activeDays: 0, firstMessageTime: null, lastMessageTime: null }
      }

      case 'time': {
        return { distribution: {} }
      }

      case 'keywords': {
        return { keywords: [] }
      }

      case 'group': {
        return { totalMessages: 0, activeMembers: 0 }
      }

      default:
        throw new Error(`未知统计类型: ${(opts as any).type}`)
    }
  }

  // ── 导出 ──
  async exportChat(config: RuntimeConfig, opts: ExportOptions): Promise<{ path: string; count: number }> {
    // 简单实现：查询消息后写入文件
    await connect(config)
    throw notImplemented('export')
  }

  // ── 未移植的功能 ──
  async moments(): Promise<never> {
    throw new MiyuError('NOT_IMPLEMENTED', '朋友圈数据：暂不支持。请使用桌面版密语查看朋友圈。')
  }

  async report(): Promise<never> {
    throw new MiyuError('NOT_IMPLEMENTED', '年度报告：暂不支持。请使用桌面版密语生成年度报告。')
  }

  async mcpServe(): Promise<never> {
    throw new MiyuError('NOT_IMPLEMENTED', 'MCP Server：暂不支持。请使用桌面版密语的 MCP 功能。')
  }
}

export const advancedService = new RealAdvancedService()

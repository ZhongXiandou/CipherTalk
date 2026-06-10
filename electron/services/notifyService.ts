import { Notification } from 'electron'
import type { MainProcessContext } from '../main/context'
import { chatService } from './chatService'
import type { ChatSession } from './chat/types'

/**
 * 消息提醒服务（主进程）。
 *
 * 设计要点（性能优先）：
 * - 不新增轮询/定时器，挂在已有的 monitorBridge → chatService 'dbChange' 事件上。
 * - 默认全关：启用集合为空时第一行就 return，零额外查询/diff 开销。
 * - 只读 Session 表增量（summary/unreadCount/lastTimestamp），不扫消息库、不解密消息体。
 * - 判定"别人发来的新消息"：lastTimestamp 增大 且 unreadCount > 0（自己从微信发出去的会清未读）。
 * - 仅私聊；群聊/公众号一律不提醒。
 * - 正在看的会话（active session 且主窗口聚焦）抑制气泡。
 * - 桌宠开着 → 推气泡给桌宠窗口；没开 → 回退系统通知。
 */

const DEBOUNCE_MS = 400
// 新消息会把会话顶到列表前面，取前若干条足以覆盖；只在有人开启提醒时才查询。
const SESSION_QUERY_LIMIT = 120

export interface NotifyPayload {
  username: string
  displayName: string
  avatarUrl?: string
  preview: string
  timestamp: number
}

interface SessionSnap {
  lastTs: number
  unread: number
}

function isPrivateSession(session: ChatSession): boolean {
  const username = String(session.username || '')
  if (!username) return false
  if (username.includes('@chatroom')) return false
  if (username.startsWith('gh_')) return false
  if (session.isOfficialAccount || session.isOfficialFolder || session.isFoldGroup) return false
  return true
}

class NotifyService {
  private ctx: MainProcessContext | null = null
  private started = false
  private enabled = new Set<string>()
  private snapshot = new Map<string, SessionSnap>()
  private activeSessionId: string | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private checking = false

  init(ctx: MainProcessContext): void {
    if (this.started) return
    this.started = true
    this.ctx = ctx

    const stored = ctx.getConfigService()?.get('notifySessions')
    if (Array.isArray(stored)) this.enabled = new Set(stored.filter((u) => typeof u === 'string'))

    // 复用已有的实时变更事件，不再额外监听文件/轮询
    chatService.on('dbChange', (payload: { table?: string }) => {
      const table = String(payload?.table || '')
      if (table !== 'Session' && table !== 'Message') return
      this.scheduleCheck()
    })

    // 启动时给已开启的会话播种一次快照，避免重启后第一条新消息被当成播种而漏弹
    if (this.enabled.size > 0) void this.seed()
  }

  getEnabledSessions(): string[] {
    return Array.from(this.enabled)
  }

  setSessionEnabled(username: string, on: boolean): void {
    const name = String(username || '').trim()
    if (!name) return
    if (on) {
      this.enabled.add(name)
      // 立即播种该会话快照，确保开启后到达的第一条新消息也能弹（避免被当成播种漏掉）
      void this.seed(name)
    } else {
      this.enabled.delete(name)
      this.snapshot.delete(name) // 关闭后清快照，下次再开重新播种
    }
    this.ctx?.getConfigService()?.set('notifySessions', Array.from(this.enabled))
    this.ctx?.broadcastToWindows('config:changed', { key: 'notifySessions', value: Array.from(this.enabled) })
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId ? String(sessionId) : null
  }

  /** 静默播种快照（不弹提醒）：记录当前 lastTs/unread 作为基线。 */
  private async seed(onlyUsername?: string): Promise<void> {
    if (this.enabled.size === 0) return
    try {
      const result = await chatService.getSessions(0, SESSION_QUERY_LIMIT)
      if (!result.success || !Array.isArray(result.sessions)) return
      for (const session of result.sessions) {
        const username = String(session.username || '')
        if (onlyUsername ? username !== onlyUsername : !this.enabled.has(username)) continue
        this.snapshot.set(username, {
          lastTs: Number(session.lastTimestamp || session.sortTimestamp || 0),
          unread: Number(session.unreadCount || 0),
        })
      }
    } catch {
      // 播种失败（如库未连接）就留给首次 check 懒播种兜底
    }
  }

  private scheduleCheck(): void {
    if (this.enabled.size === 0) return // 默认全关：零开销快速返回
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.check()
    }, DEBOUNCE_MS)
  }

  private async check(): Promise<void> {
    if (this.enabled.size === 0 || this.checking) return
    this.checking = true
    try {
      const result = await chatService.getSessions(0, SESSION_QUERY_LIMIT)
      if (!result.success || !Array.isArray(result.sessions)) return

      for (const session of result.sessions) {
        const username = String(session.username || '')
        if (!this.enabled.has(username)) continue

        const cur: SessionSnap = {
          lastTs: Number(session.lastTimestamp || session.sortTimestamp || 0),
          unread: Number(session.unreadCount || 0),
        }
        const prev = this.snapshot.get(username)
        this.snapshot.set(username, cur)

        if (!prev) continue // 首次见到：静默播种，不补弹历史
        if (!isPrivateSession(session)) continue
        // 别人发来的新消息：有更新的时间线 且 存在未读
        if (cur.lastTs <= prev.lastTs || cur.unread <= 0) continue

        this.deliver(session, cur.lastTs)
      }
    } catch (e) {
      this.ctx?.getLogService()?.warn('Notify', '检查新消息提醒失败', { error: String(e) })
    } finally {
      this.checking = false
    }
  }

  private deliver(session: ChatSession, timestamp: number): void {
    const username = String(session.username || '')
    // 正在看这个会话且主窗口聚焦时不打扰
    if (username === this.activeSessionId && this.ctx?.getMainWindow()?.isFocused()) return

    const displayName = session.displayName || username
    const preview = String(session.summary || '').split('\n')[0].trim() || '发来一条新消息'
    const payload: NotifyPayload = {
      username,
      displayName,
      avatarUrl: session.avatarUrl,
      preview,
      timestamp,
    }

    if (this.ctx?.getWindowManager().isPetWindowOpen()) {
      this.ctx.broadcastToWindows('pet:notify', payload)
    } else {
      this.showSystemNotification(payload)
    }
  }

  private showSystemNotification(payload: NotifyPayload): void {
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({
        title: payload.displayName,
        body: payload.preview,
        silent: false,
      })
      notification.on('click', () => {
        const win = this.ctx?.getMainWindow()
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
      })
      notification.show()
    } catch (e) {
      this.ctx?.getLogService()?.warn('Notify', '系统通知失败', { error: String(e) })
    }
  }
}

export const notifyService = new NotifyService()

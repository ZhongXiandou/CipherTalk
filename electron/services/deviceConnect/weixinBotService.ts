/**
 * 微信机器人服务 —— 把项目内 Agent 接到微信。
 * 扫码连接（绑定 bot 通道，非登录）→ 长轮询收消息 → 过 Agent → 回发。
 * 状态/二维码经 ctx.broadcastToWindows 推给渲染端。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import QRCode from 'qrcode'
import type { UIMessage, UIMessageChunk } from 'ai'
import { getUserDataPath } from '../runtimePaths'
import type { MainProcessContext } from '../../main/context'
import {
  ILINK_BASE_URL,
  fetchQrcode,
  fetchQrcodeStatus,
  getUpdates,
  sendText,
  sendImage,
  sendFile,
  getConfig,
  sendTyping,
  notifyStart,
  notifyStop,
  extractText,
  isSessionExpiredError,
  type IlinkSession,
} from './weixinIlinkClient'

const TOKEN_FILE = 'wechat-bot-token.json'
const QR_DEADLINE_MS = 5 * 60_000
const TYPING_KEEPALIVE_MS = 5_000

export type WechatBotStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WechatBotStatusPayload {
  status: WechatBotStatus
  botId: string | null
  userId: string | null
  error: string | null
}

interface StoredToken extends IlinkSession {
  savedAt: string
}

interface BotLogger {
  info(category: string, message: string, data?: unknown): void
  warn(category: string, message: string, data?: unknown): void
  error(category: string, message: string, data?: unknown): void
}

type TypingIndicator = {
  stop: () => Promise<void>
}

type WechatBotMedia = {
  kind: 'image' | 'file'
  filePath: string
}

type WechatBotReply = {
  text: string
  media: WechatBotMedia[]
}

function extractMediaFromToolChunk(chunk: UIMessageChunk): WechatBotMedia | null {
  const c = chunk as {
    type?: string
    toolName?: string
    output?: { success?: unknown; filePath?: unknown; error?: unknown }
  }
  if (c.type !== 'tool-output-available' || c.output?.success !== true) return null
  const filePath = typeof c.output.filePath === 'string' ? c.output.filePath.trim() : ''
  if (!filePath) return null

  switch (c.toolName) {
    case 'generate_image':
    case 'send_random_image':
    case 'send_sticker':
      return { kind: 'image', filePath }
    case 'send_wechat_file':
      return { kind: 'file', filePath }
    default:
      return null
  }
}

function dedupeMedia(media: WechatBotMedia[]): WechatBotMedia[] {
  const seen = new Set<string>()
  const result: WechatBotMedia[] = []
  for (const item of media) {
    const key = `${item.kind}:${item.filePath}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

class WeixinBotService {
  private ctx: MainProcessContext | null = null
  private logger: BotLogger | null = null
  private session: IlinkSession | null = null
  private status: WechatBotStatus = 'disconnected'
  private error: string | null = null
  private loopRunning = false
  private loopAbort: AbortController | null = null
  private connectAbort: AbortController | null = null

  init(ctx: MainProcessContext): void {
    if (this.ctx) return
    this.ctx = ctx
    this.logger = ctx.getLogService()
    const stored = this.loadToken()
    if (stored) {
      this.session = stored
      this.status = 'connected'
      this.startLoop()
    }
  }

  getStatus(): WechatBotStatusPayload {
    return {
      status: this.status,
      botId: this.session?.botId ?? null,
      userId: this.session?.userId ?? null,
      error: this.error,
    }
  }

  /** 开始扫码连接：取二维码 → 渲染成图 → 推前端 → 后台轮询确认。 */
  async startConnect(): Promise<{ success: boolean; qrcodeImage?: string; error?: string }> {
    try {
      this.cancelConnect()
      this.error = null
      const qr = await fetchQrcode()
      const qrcodeImage = await QRCode.toDataURL(qr.qrcodeContent, { width: 280, margin: 2 })
      this.setStatus('connecting')
      this.broadcast('qrcode', { qrcodeImage })
      void this.pollQrcode(qr.qrcode)
      return { success: true, qrcodeImage }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.error = error
      this.setStatus('error')
      return { success: false, error }
    }
  }

  cancelConnect(): void {
    if (this.connectAbort) {
      this.connectAbort.abort()
      this.connectAbort = null
    }
    if (this.status === 'connecting') {
      this.setStatus(this.session ? 'connected' : 'disconnected')
    }
  }

  async disconnect(): Promise<void> {
    this.cancelConnect()
    this.stopLoop()
    const session = this.session
    this.session = null
    this.clearToken()
    this.error = null
    this.setStatus('disconnected')
    if (session) {
      try { await notifyStop(session) } catch { /* 下线通知失败无所谓 */ }
    }
  }

  shutdown(): void {
    this.cancelConnect()
    this.stopLoop()
  }

  // ── 扫码状态轮询 ──
  private async pollQrcode(initialQrcode: string): Promise<void> {
    const abort = new AbortController()
    this.connectAbort = abort
    const deadline = Date.now() + QR_DEADLINE_MS
    let qrcode = initialQrcode
    let refreshCount = 0

    while (Date.now() < deadline && !abort.signal.aborted) {
      let resp
      try {
        resp = await fetchQrcodeStatus(qrcode)
      } catch (e) {
        this.logger?.warn('WechatBot', '查询二维码状态失败', { error: String(e) })
        await this.sleep(1500)
        continue
      }
      if (abort.signal.aborted) return

      if (resp.status === 'expired') {
        refreshCount += 1
        if (refreshCount > 3) {
          this.failConnect('二维码多次过期，请重试')
          return
        }
        try {
          const newQr = await fetchQrcode()
          qrcode = newQr.qrcode
          const qrcodeImage = await QRCode.toDataURL(newQr.qrcodeContent, { width: 280, margin: 2 })
          this.broadcast('qrcode', { qrcodeImage })
        } catch {
          this.failConnect('刷新二维码失败')
          return
        }
      } else if (resp.status === 'scaned') {
        this.broadcast('scanState', { state: 'scaned' })
      } else if (resp.status === 'confirmed') {
        const session: IlinkSession = {
          token: resp.bot_token || '',
          baseUrl: resp.baseurl || ILINK_BASE_URL,
          botId: resp.ilink_bot_id || '',
          userId: resp.ilink_user_id || '',
        }
        this.session = session
        this.saveToken(session)
        this.connectAbort = null
        this.error = null
        this.setStatus('connected')
        this.startLoop()
        return
      }

      await this.sleep(1000)
    }

    if (!abort.signal.aborted) this.failConnect('扫码超时，请重试')
  }

  private failConnect(message: string): void {
    this.error = message
    this.connectAbort = null
    this.broadcast('scanState', { state: 'failed', error: message })
    this.setStatus(this.session ? 'connected' : 'error')
  }

  // ── 收消息循环 ──
  private startLoop(): void {
    if (this.loopRunning || !this.session) return
    this.loopRunning = true
    this.loopAbort = new AbortController()
    void this.runLoop(this.loopAbort.signal)
  }

  private stopLoop(): void {
    this.loopRunning = false
    if (this.loopAbort) {
      this.loopAbort.abort()
      this.loopAbort = null
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let buf = ''
    // 先上线通知：不调这个，bot 会显示"暂无法连接 OpenClaw"，且消息不会推过来
    try {
      const r = await notifyStart(this.session)
      console.log(`[WechatBot] notifyStart ret=${r?.ret ?? 'null'} errmsg=${r?.errmsg ?? ''}`)
      if (r && r.ret !== undefined && r.ret !== 0) {
        this.logger?.warn('WechatBot', 'notifyStart 返回非 0', { ret: r.ret, errmsg: r.errmsg })
      }
    } catch (e) {
      console.warn('[WechatBot] notifyStart 失败（忽略，继续轮询）：', e)
    }
    if (signal.aborted || !this.session) return
    this.logger?.warn('WechatBot', '开始长轮询收消息', { botId: this.session?.botId })
    console.log('[WechatBot] 长轮询已启动 botId=', this.session?.botId)
    while (this.loopRunning && !signal.aborted && this.session) {
      try {
        const pollStart = Date.now()
        const resp = await getUpdates(this.session, buf, signal)
        if (signal.aborted) break
        const msgs = resp.msgs ?? []
        console.log(`[WechatBot] getUpdates 返回 ret=${resp.ret} msgs=${msgs.length} 耗时=${Date.now() - pollStart}ms buf=${(resp.get_updates_buf || '').slice(0, 20)}`)
        if (resp.ret !== undefined && resp.ret !== 0) {
          console.warn(`[WechatBot] getUpdates 返回非 0 错误码 ret=${resp.ret}，完整响应：`, JSON.stringify(resp))
        }
        if (resp.get_updates_buf) buf = resp.get_updates_buf
        if (msgs.length > 0) {
          console.log('[WechatBot] 收到消息原始内容：', JSON.stringify(msgs))
        }
        for (const msg of msgs) {
          if (signal.aborted) break
          if (msg.message_type !== 1) {
            console.log(`[WechatBot] 跳过非用户消息 message_type=${msg.message_type}`)
            continue // 只处理用户发来的
          }
          const from = msg.from_user_id || ''
          const text = extractText(msg)
          if (!from || !text) {
            console.log('[WechatBot] 跳过空消息', { from, text })
            continue
          }
          await this.handleMessage(from, text, msg.context_token)
        }
      } catch (e) {
        if (signal.aborted) break
        if (isSessionExpiredError(e)) {
          this.logger?.error('WechatBot', '微信连接已过期，需重新扫码', {})
          this.session = null
          this.clearToken()
          this.loopRunning = false
          this.error = '微信连接已过期，请重新扫码连接'
          this.setStatus('error')
          return
        }
        this.logger?.warn('WechatBot', '收消息出错，3 秒后重试', { error: String(e) })
        await this.sleep(3000)
      }
    }
  }

  private async handleMessage(from: string, text: string, contextToken?: string): Promise<void> {
    if (!this.session) return
    this.logger?.warn('WechatBot', '收到微信消息', { from, textLength: text.length })
    console.log(`[WechatBot] 收到消息 from=${from} text="${text}" 开始调用 Agent...`)
    let typing: TypingIndicator | null = null
    try {
      // 这条微信消息也记入 AI 助手历史（source='wechat'，按联系人 from_user_id 归档）
      const { agentConversationStore } = await import('../agent/conversationStore')
      const conv = agentConversationStore.getOrCreateExternal({
        source: 'wechat',
        externalId: from,
        title: `微信 · ${text.slice(0, 16)}`,
      })
      const userMsg: UIMessage = { id: `wx-u-${Date.now()}`, role: 'user', parts: [{ type: 'text', text }] }
      agentConversationStore.append(conv.id, [userMsg])

      const history = agentConversationStore.load(conv.id)?.messages ?? [userMsg]
      typing = await this.startTypingIndicator(from, contextToken)
      const reply = await this.runAgent(history)
      console.log(`[WechatBot] Agent 回复长度=${reply.text.length} 媒体=${reply.media.length} 内容="${reply.text.slice(0, 120)}"`)

      if (this.session && (reply.text || reply.media.length > 0)) {
        await typing?.stop()
        typing = null
        const assistantMsg: UIMessage = {
          id: `wx-a-${Date.now()}`,
          role: 'assistant',
          parts: [{ type: 'text', text: reply.text || `[已发送 ${reply.media.length} 个媒体文件]` }]
        }
        agentConversationStore.append(conv.id, [assistantMsg])
        if (reply.text) {
          await sendText(this.session, from, reply.text, contextToken)
        }
        await this.sendReplyMedia(from, reply.media, contextToken)
        this.logger?.warn('WechatBot', '已回复微信消息', { from, replyLength: reply.text.length, mediaCount: reply.media.length })
        console.log('[WechatBot] 已调用 sendmessage 发送回复')
      } else {
        console.warn('[WechatBot] Agent 回复为空，未发送')
      }
    } catch (e) {
      this.logger?.error('WechatBot', '生成或发送回复失败', { from, error: String(e) })
      console.error('[WechatBot] 生成或发送回复失败：', e)
      try {
        await typing?.stop()
        typing = null
        if (this.session) await sendText(this.session, from, 'AI 暂时无法回复，请稍后再试。', contextToken)
      } catch (e2) {
        console.error('[WechatBot] 兜底回复也发送失败：', e2)
      }
    } finally {
      await typing?.stop()
    }
  }

  private async sendReplyMedia(toUserId: string, media: WechatBotMedia[], contextToken?: string): Promise<void> {
    if (!this.session || media.length === 0) return
    for (const item of media) {
      try {
        if (item.kind === 'image') {
          await sendImage(this.session, toUserId, item.filePath, contextToken)
        } else {
          await sendFile(this.session, toUserId, item.filePath, contextToken)
        }
        this.logger?.warn('WechatBot', '已发送微信媒体', { to: toUserId, kind: item.kind, filePath: item.filePath })
      } catch (e) {
        this.logger?.error('WechatBot', '发送微信媒体失败', { to: toUserId, kind: item.kind, filePath: item.filePath, error: String(e) })
        console.error('[WechatBot] 发送媒体失败：', e)
        try {
          if (this.session) await sendText(this.session, toUserId, `${item.kind === 'image' ? '图片' : '文件'}发送失败，请稍后再试。`, contextToken)
        } catch {
          /* 文本兜底也失败则只记录原错误 */
        }
      }
    }
  }

  private async startTypingIndicator(toUserId: string, contextToken?: string): Promise<{ stop: () => Promise<void> } | null> {
    if (!this.session) return null
    const session = this.session
    let ticket = ''
    try {
      const config = await getConfig(session, toUserId, contextToken)
      if (config?.ret !== undefined && config.ret !== 0) {
        this.logger?.warn('WechatBot', '获取 typing_ticket 返回非 0', { ret: config.ret, errmsg: config.errmsg })
        return null
      }
      ticket = config?.typing_ticket || ''
      if (!ticket) return null
      await sendTyping(session, toUserId, ticket, 1)
      this.logger?.warn('WechatBot', '已发送微信正在输入状态', { to: toUserId })
    } catch (e) {
      this.logger?.warn('WechatBot', '发送微信正在输入状态失败', { to: toUserId, error: String(e) })
      return null
    }

    let stopped = false
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (stopped) return
      void sendTyping(session, toUserId, ticket, 1).catch((e) => {
        this.logger?.warn('WechatBot', '微信正在输入状态保活失败', { to: toUserId, error: String(e) })
      })
    }, TYPING_KEEPALIVE_MS)

    return {
      stop: async () => {
        if (stopped) return
        stopped = true
        clearInterval(timer)
        try {
          await sendTyping(session, toUserId, ticket, 2)
          this.logger?.warn('WechatBot', '已取消微信正在输入状态', { to: toUserId })
        } catch (e) {
          this.logger?.warn('WechatBot', '取消微信正在输入状态失败', { to: toUserId, error: String(e) })
        }
      },
    }
  }

  /** 把对话（历史 + 本轮）交给项目内 Agent，收集流式文本作为回复（v1 纯文本，不注入 MCP/技能）。 */
  private async runAgent(uiMessages: UIMessage[]): Promise<WechatBotReply> {
    const { resolveProviderConfig } = await import('../agent/resolveProviderConfig')
    const { refreshResolvedProxyUrl } = await import('../ai/proxyFetch')
    const { convertToModelMessages } = await import('ai')
    const { agentProcessService } = await import('../agent/agentProcessService')
    agentProcessService.setLogger(this.logger as never)
    const providerConfig = resolveProviderConfig()
    await refreshResolvedProxyUrl()
    const messages = await convertToModelMessages(uiMessages)
    let reply = ''
    const media: WechatBotMedia[] = []
    await agentProcessService.run(
      { messages, providerConfig, scope: { kind: 'global' }, mcpTools: [], skills: [], planMode: false },
      (chunk) => {
        const c = chunk as { type?: string; delta?: string; text?: string }
        if (c?.type === 'text-delta') reply += c.delta ?? c.text ?? ''
        const item = extractMediaFromToolChunk(chunk)
        if (item) media.push(item)
      },
    )
    return { text: reply.trim(), media: dedupeMedia(media) }
  }

  // ── token 持久化（userData 下独立 JSON，不混入共享 config） ──
  private tokenPath(): string {
    return join(getUserDataPath(), TOKEN_FILE)
  }

  private loadToken(): IlinkSession | null {
    try {
      const p = this.tokenPath()
      if (!existsSync(p)) return null
      const data = JSON.parse(readFileSync(p, 'utf-8')) as StoredToken
      if (!data.token) return null
      return { token: data.token, baseUrl: data.baseUrl || ILINK_BASE_URL, botId: data.botId || '', userId: data.userId || '' }
    } catch {
      return null
    }
  }

  private saveToken(session: IlinkSession): void {
    try {
      const payload: StoredToken = { ...session, savedAt: new Date().toISOString() }
      writeFileSync(this.tokenPath(), JSON.stringify(payload, null, 2), 'utf-8')
    } catch (e) {
      this.logger?.warn('WechatBot', '保存 token 失败', { error: String(e) })
    }
  }

  private clearToken(): void {
    try {
      const p = this.tokenPath()
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* ignore */
    }
  }

  // ── 工具 ──
  private setStatus(status: WechatBotStatus): void {
    this.status = status
    this.broadcast('status', this.getStatus())
  }

  private broadcast(event: string, payload: unknown): void {
    this.ctx?.broadcastToWindows(`deviceConnect:wechat:${event}`, payload)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export const weixinBotService = new WeixinBotService()

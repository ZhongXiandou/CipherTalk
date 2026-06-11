/**
 * 克隆好友独立聊天窗口（/persona-chat/:sessionId）—— 手机聊天软件式的窄窗界面。
 * 三态：确认（隐私提示）→ 画像构建进度 → 气泡对话；
 * 等待回复时头部只显示「对方正在输入…」，不暴露内部检索过程。
 * 历史挂 agent 会话存储（scope kind='persona'），打开恢复、每轮保存。
 */
import { AlertCircle, Bot, Loader2, RefreshCw, Send, Square, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useChat } from '@ai-sdk/react'
import { Button, ProgressBar, Label, Tooltip } from '@heroui/react'
import type { UIMessage } from 'ai'
import { PersonaChatTransport } from '../features/aiagent/transport/personaChatTransport'
import type { PersonaBuildProgressInfo, PersonaRecordInfo } from '../types/electron'

type Phase = 'loading' | 'confirm' | 'building' | 'chat'

function messageText(message: UIMessage): string {
  return (message.parts || [])
    .map((part) => (part && typeof part === 'object' && part.type === 'text' ? String((part as { text?: unknown }).text || '') : ''))
    .filter(Boolean)
    .join('')
}

/** 模型按"换行或／即分条"输出，两种分隔都拆成微信式的多条气泡。 */
function splitBubbles(text: string): string[] {
  return text.split(/[\n／]/).map((line) => line.trim()).filter(Boolean)
}

function PersonaAvatar({ name, avatarUrl, size }: { name: string; avatarUrl?: string; size: number }) {
  const [imgError, setImgError] = useState(false)
  useEffect(() => { setImgError(false) }, [avatarUrl])
  if (avatarUrl && !imgError) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-full object-cover"
        onError={() => setImgError(true)}
      />
    )
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: Math.max(12, size * 0.4) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-default text-foreground"
    >
      {name.slice(0, 1) || '?'}
    </div>
  )
}

export default function PersonaChatPage() {
  const location = useLocation()
  const sessionId = useMemo(() => {
    const match = /^\/persona-chat\/([^/]+)/.exec(location.pathname)
    return match ? decodeURIComponent(match[1]) : ''
  }, [location.pathname])

  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('loading')
  const [persona, setPersona] = useState<PersonaRecordInfo | null>(null)
  const [buildProgress, setBuildProgress] = useState<PersonaBuildProgressInfo | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastSavedCountRef = useRef(0)

  const transport = useMemo(() => new PersonaChatTransport(() => sessionId), [sessionId])
  const { messages, sendMessage, setMessages, status, stop, error } = useChat({ transport, experimental_throttle: 50 })
  const busy = status === 'submitted' || status === 'streaming'
  const headerTitle = busy ? '对方正在输入…' : (displayName || sessionId)

  // 窗口标题同步（任务栏/系统标题栏）
  useEffect(() => {
    document.title = busy ? '对方正在输入…' : (displayName ? `${displayName}` : '克隆好友')
  }, [busy, displayName])

  // 拉好友信息（昵称/头像）
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void window.electronAPI.chat.getSessionDetail(sessionId).then((res) => {
      if (cancelled) return
      if (res.success && res.detail) {
        setDisplayName(res.detail.displayName || res.detail.nickName || sessionId)
        setAvatarUrl(res.detail.avatarUrl)
      } else {
        setDisplayName(sessionId)
      }
    }).catch(() => { if (!cancelled) setDisplayName(sessionId) })
    return () => { cancelled = true }
  }, [sessionId])

  // 查画像状态；已克隆则恢复上次对话
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setPhase('loading')
    setBuildError(null)
    void window.electronAPI.persona.get(sessionId).then(async (res) => {
      if (cancelled) return
      if (res.success && res.persona) {
        setPersona(res.persona)
        setPhase('chat')
        try {
          const last = await window.electronAPI.agent.getLastConversation({ kind: 'persona', sessionId })
          const meta = last.success && last.conversation ? (last.conversation as { id: number }) : null
          if (!meta || cancelled) return
          const loaded = await window.electronAPI.agent.loadConversation(meta.id)
          const conv = loaded.success && loaded.conversation
            ? (loaded.conversation as { id: number; messages: UIMessage[] })
            : null
          if (conv && !cancelled) {
            setConversationId(conv.id)
            lastSavedCountRef.current = conv.messages.length
            setMessages(conv.messages)
          }
        } catch { /* 恢复失败就从空对话开始 */ }
      } else {
        setPhase('confirm')
      }
    })
    return () => { cancelled = true }
  }, [sessionId, setMessages])

  // 画像构建进度
  useEffect(() => {
    return window.electronAPI.persona.onBuildProgress((p) => {
      if (p.sessionId === sessionId) setBuildProgress(p)
    })
  }, [sessionId])

  // 新消息自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy, phase])

  // 每轮结束保存对话
  useEffect(() => {
    if (status !== 'ready' || !conversationId || messages.length === 0) return
    if (messages.length === lastSavedCountRef.current) return
    lastSavedCountRef.current = messages.length
    void window.electronAPI.agent.saveConversationMessages({ id: conversationId, messages })
  }, [status, conversationId, messages])

  const handleBuild = async () => {
    setPhase('building')
    setBuildError(null)
    setBuildProgress(null)
    const res = await window.electronAPI.persona.build({ sessionId, displayName })
    if (res.success && res.persona) {
      setPersona(res.persona)
      setPhase('chat')
    } else {
      setBuildError(res.error || '克隆失败')
      setPhase('confirm')
    }
  }

  const handleDelete = async () => {
    if (busy) stop()
    await window.electronAPI.persona.delete(sessionId)
    setPersona(null)
    setMessages([])
    setConversationId(null)
    lastSavedCountRef.current = 0
    setPhase('confirm')
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    if (!conversationId) {
      try {
        const created = await window.electronAPI.agent.createConversation({
          scope: { kind: 'persona', sessionId, displayName },
          title: `${displayName || sessionId}的分身`,
        })
        if (created.success && created.conversation) {
          setConversationId((created.conversation as { id: number }).id)
        }
      } catch { /* 创建失败不阻塞发送，本轮不持久化 */ }
    }
    void sendMessage({ text })
  }

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">无效的会话</div>
    )
  }

  if (phase === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">正在检查分身状态…</span>
      </div>
    )
  }

  if (phase === 'confirm') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={64} />
        <h2 className="text-lg font-semibold text-foreground">克隆「{displayName}」</h2>
        <p className="text-center text-sm text-muted">
          根据你们的聊天记录提炼 TA 的说话风格、口头禅和真实对话样本，生成一个能模仿 TA 语气聊天的数字分身。
        </p>
        <div className="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-soft-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>
            克隆和聊天时，部分聊天记录会发送给你配置的 AI 模型服务商用于分析与生成。
            如使用 Ollama 等本地模型则数据不出本机。画像仅保存在本地，可随时删除。
          </span>
        </div>
        {buildError && (
          <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{buildError}</span>
          </div>
        )}
        <Button onPress={handleBuild}>
          <Bot className="size-4" />
          开始克隆
        </Button>
      </div>
    )
  }

  if (phase === 'building') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
        <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={64} />
        <h2 className="text-base font-semibold text-foreground">正在克隆「{displayName}」</h2>
        <ProgressBar aria-label="克隆进度" className="w-full" value={buildProgress?.percent ?? 0} maxValue={100}>
          <Label>{buildProgress?.title || '准备中…'}</Label>
          <ProgressBar.Output />
          <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
        </ProgressBar>
        <p className="text-center text-xs text-muted">分析聊天记录并调用 AI 提炼画像，通常需要几十秒</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 仿手机聊天头部：等待回复时只显示"对方正在输入…" */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{headerTitle}</div>
          <div className="truncate text-xs text-muted">
            数字分身{persona ? ` · 基于 ${persona.stats.friendMessageCount} 条消息` : ''}
          </div>
        </div>
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button isIconOnly size="sm" variant="ghost" aria-label="重建画像" isDisabled={busy} onPress={() => setPhase('confirm')}>
              <RefreshCw size={16} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>重建画像（聊天记录更新后可重新克隆）</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button isIconOnly size="sm" variant="ghost" aria-label="删除分身" onPress={handleDelete}>
              <Trash2 size={16} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>删除分身画像</Tooltip.Content>
        </Tooltip>
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
            <Bot size={32} />
            <p className="text-sm">和「{displayName}」的分身打个招呼吧</p>
          </div>
        )}
        {messages.map((message) => {
          const bubbles = splitBubbles(messageText(message))
          if (bubbles.length === 0) return null
          const isMine = message.role === 'user'
          return (
            <div key={message.id} className={`flex w-full gap-2 ${isMine ? 'justify-end' : 'justify-start'}`}>
              {!isMine && <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={30} />}
              <div className={`flex max-w-[78%] flex-col gap-1 ${isMine ? 'items-end' : 'items-start'}`}>
                {bubbles.map((bubble, index) => (
                  <div
                    key={`${message.id}:${index}`}
                    className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                      isMine
                        ? 'rounded-tr-sm bg-success-soft text-success-soft-foreground'
                        : 'rounded-tl-sm bg-surface text-foreground'
                    }`}
                  >
                    {bubble}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
        {busy && (
          <div className="flex items-center gap-1 pl-10">
            <span className="inline-flex gap-1 rounded-2xl rounded-tl-sm bg-surface px-3 py-2.5">
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:0ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:150ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:300ms]" />
            </span>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error.message || '生成失败，请重试'}</span>
          </div>
        )}
      </div>

      {/* 输入栏 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-3">
        <input
          aria-label={`给${displayName}的分身发消息`}
          className="h-10 flex-1 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30"
          placeholder={`给「${displayName}」发消息…`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void handleSend()
            }
          }}
        />
        {busy ? (
          <Button isIconOnly aria-label="停止生成" variant="secondary" onPress={() => stop()}>
            <Square size={16} />
          </Button>
        ) : (
          <Button isIconOnly aria-label="发送" isDisabled={!input.trim()} onPress={handleSend}>
            <Send size={16} />
          </Button>
        )}
      </div>
    </div>
  )
}

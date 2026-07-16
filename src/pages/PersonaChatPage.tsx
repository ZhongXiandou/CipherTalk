/**
 * 克隆好友独立聊天窗口（/persona-chat/:sessionId）—— 手机聊天软件式的窄窗界面。
 * 三态：确认（隐私提示）→ 画像构建进度 → 气泡对话；
 * 等待回复时头部只显示「对方正在输入…」，不暴露内部检索过程。
 * 历史挂 agent 会话存储（scope kind='persona'），打开恢复、每轮保存。
 */
import { ArrowsRotateLeft, CircleCheck, CircleDashed, CircleExclamation, CircleXmarkFill, Clock, ClockArrowRotateLeft, CommentSlash, FaceRobot, Microphone, PencilToLine, PencilToSquare, Smartphone, TrashBin, Volume } from '@gravity-ui/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useChat } from '@ai-sdk/react'
import { AlertDialog, Button, ProgressBar, Dropdown, Header, Label, Modal, ScrollShadow, Skeleton, Tooltip } from '@heroui/react'
import type { FileUIPart, UIMessage } from 'ai'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { ImagePreview, type ImagePreviewOriginRect } from '@/components/ImagePreview'
import { PersonaChatTransport } from '../features/aiagent/transport/personaChatTransport'
import { cn } from '../lib/utils'
import { useTtsSpeaker } from '../lib/ttsPlayer'
import { startVoiceRecording, type ActiveRecorder } from '../lib/voiceRecorder'
import { startVoiceCall, type VoiceCallSession } from '../lib/voiceCallSession'
import { parseWechatEmoji } from '../utils/wechatEmoji'
import { getAIProviders, type AIModelInfo, type AIProviderInfo } from '../types/ai'
import type { AgentConversationUpdatedEvent, PersonaBuildProgressInfo, PersonaRecordInfo } from '../types/electron'
import { parseAgentMessageMetadata } from './agent/agentConversationHelpers'
import { formatTokenCount } from './agent/AgentUsageStats'

type Phase = 'loading' | 'confirm' | 'building' | 'chat'

/** 历史对话记录（含微信分身归档）：listConversations 返回的会话元数据子集。 */
type PersonaConversationRecord = { id: number; title: string; source?: string; externalId?: string | null; updatedAt: number; scope?: unknown }
type PersonaLoadedConversation = PersonaConversationRecord & { messages: UIMessage[] }

type PersonaChatPageProps = {
  sessionId?: string
  embedded?: boolean
  onPersonaChanged?: () => void
}

type SpeakingStyleDraft = {
  tone: string
  personalityTraits: string
  catchphrases: string
  punctuationStyle: string
  addressing: string
  topics: string
  ttsInstructions: string
}

const EMPTY_SPEAKING_STYLE_DRAFT: SpeakingStyleDraft = {
  tone: '',
  personalityTraits: '',
  catchphrases: '',
  punctuationStyle: '',
  addressing: '',
  topics: '',
  ttsInstructions: '',
}

function listToDraft(items: string[] | undefined): string {
  return (items || []).join('\n')
}

function draftToList(value: string): string[] {
  return value
    .split(/[\n,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function SpeakingStyleField({
  label,
  description,
  value,
  placeholder,
  minRows = 3,
  onChange,
}: {
  label: string
  description: string
  value: string
  placeholder?: string
  minRows?: number
  onChange: (value: string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [])

  useEffect(() => {
    resize()
  }, [resize, value])

  return (
    <label className="block">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      <span className="mt-1 block text-xs text-muted">{description}</span>
      <textarea
        ref={textareaRef}
        className="mt-2 block w-full resize-none overflow-hidden rounded-lg border border-border bg-surface px-3 py-2.5 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
        placeholder={placeholder}
        rows={minRows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onInput={resize}
      />
    </label>
  )
}

function messageTextParts(message: UIMessage): string[] {
  return (message.parts || [])
    .map((part) => (part && typeof part === 'object' && part.type === 'text' ? String((part as { text?: unknown }).text || '') : ''))
    .filter(Boolean)
}

function messageFileParts(message: UIMessage): FileUIPart[] {
  return (message.parts || [])
    .filter((part): part is FileUIPart => (
      Boolean(part)
      && typeof part === 'object'
      && part.type === 'file'
      && typeof (part as { url?: unknown }).url === 'string'
    ))
}

function messageText(message: UIMessage): string {
  return messageTextParts(message).join('\n')
}

/** 语音气泡标记（与 personaChatEngine 的提示词约定一致）：行首 [语音]/【语音】。 */
const VOICE_MARKER_RE = /^[\[【]\s*(?:语音|voice)\s*[\]】]\s*/i

/** 表情包气泡标记（personaChatEngine 把 [表情:N] 解析后发出）：前缀 + JSON（cdnUrl/md5 等）。 */
const STICKER_BUBBLE_PREFIX = '[表情包]'
const INITIAL_RENDERED_MESSAGE_COUNT = 80
const RENDERED_MESSAGE_BATCH_SIZE = 80

function wechatPushBubblesFromMessage(message: UIMessage): string[] {
  return messageTextParts(message)
    .map((text) => text.trim())
    .filter((text) => text && !text.startsWith(STICKER_BUBBLE_PREFIX))
    .map((text) => text.replace(VOICE_MARKER_RE, '').trim())
    .filter(Boolean)
}

function assistantMessageIds(messages: UIMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'assistant' && typeof message.id === 'string' && message.id.trim())
    .map((message) => message.id)
}

interface PersonaStickerData {
  cdnUrl?: string
  md5?: string
  productId?: string
  encryptUrl?: string
  aesKey?: string
}

interface PersonaBubble {
  text: string
  isVoice: boolean
  /** 估算语音时长（秒）：中文语速约 4 字/秒，1-60 截断 */
  seconds: number
  /** 表情包气泡：有值时渲染成表情包图片 */
  sticker?: PersonaStickerData
}

function parseBubble(raw: string): PersonaBubble {
  if (raw.startsWith(STICKER_BUBBLE_PREFIX)) {
    try {
      const sticker = JSON.parse(raw.slice(STICKER_BUBBLE_PREFIX.length)) as PersonaStickerData
      if (sticker && (sticker.cdnUrl || sticker.md5)) return { text: '', isVoice: false, seconds: 0, sticker }
    } catch { /* JSON 损坏按普通文本显示 */ }
  }
  const match = raw.match(VOICE_MARKER_RE)
  if (!match) return { text: raw, isVoice: false, seconds: 0 }
  const text = raw.slice(match[0].length).trim()
  if (!text) return { text: raw, isVoice: false, seconds: 0 }
  return { text, isVoice: true, seconds: Math.min(60, Math.max(1, Math.round(Array.from(text).length / 4))) }
}

/** 表情包 dataUrl/本地路径缓存（窗口级）：同一张表情多次出现只下载一次。 */
const stickerSrcCache = new Map<string, string>()

/** 表情包气泡：经主进程 downloadEmoji 下载/解密后显示真实表情包图片。 */
function PersonaStickerBubble({ sticker }: { sticker: PersonaStickerData }) {
  const cacheKey = sticker.md5 || sticker.cdnUrl || ''
  const [src, setSrc] = useState<string | undefined>(() => stickerSrcCache.get(cacheKey))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!cacheKey || src || failed) return
    let cancelled = false
    window.electronAPI.chat
      .downloadEmoji(sticker.cdnUrl || '', sticker.md5, sticker.productId, undefined, sticker.encryptUrl, sticker.aesKey)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.localPath) {
          stickerSrcCache.set(cacheKey, result.localPath)
          setSrc(result.localPath)
        } else {
          setFailed(true)
        }
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [cacheKey, src, failed, sticker.cdnUrl, sticker.md5, sticker.productId, sticker.encryptUrl, sticker.aesKey])

  if (!cacheKey || failed) {
    return <div className="rounded-2xl rounded-tl-sm bg-surface px-3 py-2 text-sm text-muted">[表情]</div>
  }
  if (!src) {
    return (
      <div className="flex size-20 items-center justify-center rounded-2xl rounded-tl-sm bg-surface">
        <CircleDashed className="animate-spin text-muted" width={16} height={16} />
      </div>
    )
  }
  return <img alt="表情包" className="max-h-36 max-w-52 rounded-lg object-contain" draggable={false} loading="lazy" src={src} />
}

/** 微信语音条的声波图标：加载时旋转提示，播放时切换成动态音量柱。 */
function VoiceWaves({ loading, playing }: { loading: boolean; playing: boolean }) {
  if (loading) return <CircleDashed className="shrink-0 animate-spin text-muted" width={16} height={16} />
  if (playing) return <VoicePlayingBars />
  return (
    <svg
      className="shrink-0"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2.2"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M6 9.5a4.2 4.2 0 0 1 0 5" />
      <path d="M9.5 7a8 8 0 0 1 0 10" />
      <path d="M13 4.5a12 12 0 0 1 0 15" />
    </svg>
  )
}

function VoicePlayingBars() {
  return (
    <span aria-hidden className="inline-flex h-4 shrink-0 items-end gap-0.5 text-accent">
      {[0, 1, 2].map((item) => (
        <span
          key={item}
          className="rounded-full bg-accent animate-pulse"
          style={{ width: 3, height: `${6 + item * 3}px`, animationDelay: `${item * 120}ms` }}
        />
      ))}
    </span>
  )
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
        loading="lazy"
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

function getPersonaVoiceLabel(persona: PersonaRecordInfo | null): string {
  if (!persona?.ttsVoice) return ''
  if (persona.ttsVoice.provider === 'xiaomi') return '专属小米音色'
  if (persona.ttsVoice.provider === 'aliyun-qwen') return '专属通义音色'
  return '专属豆包音色'
}

function PersonaChatSkeleton() {
  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border/60 px-3 sm:px-4">
        <Skeleton className="size-11 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-36 rounded-lg" />
          <Skeleton className="h-3 w-72 max-w-full rounded-lg" />
        </div>
        <div className="flex shrink-0 gap-2">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="size-8 rounded-lg" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-3 py-5 sm:px-4">
        <div className="flex items-start gap-2">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-11 w-72 rounded-2xl" />
            <Skeleton className="h-11 w-52 rounded-2xl" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <div className="space-y-2">
            <Skeleton className="h-11 w-64 rounded-2xl" />
            <Skeleton className="ml-auto h-11 w-40 rounded-2xl" />
          </div>
          <Skeleton className="size-10 shrink-0 rounded-full" />
        </div>
      </div>

      <div className="shrink-0 border-t border-border/60 px-3 py-4 sm:px-4">
        <Skeleton className="h-24 w-full rounded-[22px]" />
      </div>
    </div>
  )
}

function PersonaMessageAttachment({ file, isMine }: { file: FileUIPart; isMine: boolean }) {
  const [preview, setPreview] = useState<{ src: string; originRect: ImagePreviewOriginRect } | null>(null)
  const isImage = file.mediaType?.startsWith('image/') && file.url
  if (isImage) {
    return (
      <>
        <button
          aria-label={`预览${file.filename || '图片'}`}
          className="block w-fit cursor-zoom-in border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setPreview({
              src: file.url,
              originRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            })
          }}
          title="点击预览"
          type="button"
        >
          <img
            alt={file.filename || '图片'}
            className={cn(
              'max-h-64 max-w-80 rounded-2xl object-contain shadow-xs',
              isMine ? 'rounded-tr-sm' : 'rounded-tl-sm'
            )}
            draggable={false}
            loading="lazy"
            src={file.url}
          />
        </button>
        {preview && (
          <ImagePreview
            src={preview.src}
            originRect={preview.originRect}
            onClose={() => setPreview(null)}
          />
        )}
      </>
    )
  }

  return (
    <div className={cn(
      'max-w-80 rounded-2xl bg-surface px-4 py-2.5 text-sm text-foreground',
      isMine ? 'rounded-tr-sm bg-success-soft text-success-soft-foreground' : 'rounded-tl-sm'
    )}>
      {file.filename || '附件'}
    </div>
  )
}

function PersonaMessageUsageLine({ metadata }: { metadata: unknown }) {
  const parsed = parseAgentMessageMetadata(metadata)
  if (!parsed?.usage) return null

  const inputTokens = Number(parsed.usage.inputTokens)
  const outputTokens = Number(parsed.usage.outputTokens)
  const totalTokens = Number(parsed.usage.totalTokens)
  const parts = [
    Number.isFinite(inputTokens) ? `输入 ${formatTokenCount(inputTokens)}` : '',
    Number.isFinite(outputTokens) ? `输出 ${formatTokenCount(outputTokens)}` : '',
    Number.isFinite(totalTokens) ? `共 ${formatTokenCount(totalTokens)}` : '',
  ].filter(Boolean)

  return (
    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
      {parts.length > 0 && <span>{parts.join(' · ')}</span>}
    </div>
  )
}

export default function PersonaChatPage({ sessionId: sessionIdProp, embedded = false, onPersonaChanged }: PersonaChatPageProps = {}) {
  const location = useLocation()
  const routeSessionId = useMemo(() => {
    const match = /^\/persona-chat\/([^/]+)/.exec(location.pathname)
    return match ? decodeURIComponent(match[1]) : ''
  }, [location.pathname])
  const sessionId = sessionIdProp || routeSessionId

  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | undefined>(undefined)
  const [sessionDetailLoading, setSessionDetailLoading] = useState(true)
  const [phase, setPhase] = useState<Phase>('loading')
  const [persona, setPersona] = useState<PersonaRecordInfo | null>(null)
  const [buildProgress, setBuildProgress] = useState<PersonaBuildProgressInfo | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [clearingConversations, setClearingConversations] = useState(false)
  const [voiceCloning, setVoiceCloning] = useState(false)
  const [voiceCloneStatus, setVoiceCloneStatus] = useState<{ ok: boolean; text: string } | null>(null)
  // 语音输入（按住说话）：idle 空闲 / recording 录音中 / transcribing 转写中
  const [voiceInput, setVoiceInput] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const recorderRef = useRef<ActiveRecorder | null>(null)
  // 语音发问后自动朗读这一轮回复（打字发的消息不自动播）
  const autoPlayReplyRef = useRef(false)
  const wasBusyRef = useRef(false)
  // 语音通话模式（打电话式：常开麦 + VAD 自动断句）
  const [callActive, setCallActive] = useState(false)
  const [callPhase, setCallPhase] = useState<'connecting' | 'listening' | 'recognizing' | 'thinking' | 'speaking'>('listening')
  const callSessionRef = useRef<VoiceCallSession | null>(null)
  const callActiveRef = useRef(false)
  const handleCallUtteranceRef = useRef<(wavBase64: string) => void>(() => {})
  const [speakingStyleOpen, setSpeakingStyleOpen] = useState(false)
  const [speakingStyleSaving, setSpeakingStyleSaving] = useState(false)
  const [speakingStyleDraft, setSpeakingStyleDraft] = useState<SpeakingStyleDraft>(EMPTY_SPEAKING_STYLE_DRAFT)
  const [speakingStyleError, setSpeakingStyleError] = useState('')
  /** 删除确认弹窗：删除分身画像 / 删除对话记录 */
  const [confirmAction, setConfirmAction] = useState<'deletePersona' | 'clearConversations' | null>(null)
  /** 历史对话记录下拉：列表 + 待删除的单条记录 */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRecords, setHistoryRecords] = useState<PersonaConversationRecord[]>([])
  const [recordPendingDelete, setRecordPendingDelete] = useState<PersonaConversationRecord | null>(null)
  const [providersInfo, setProvidersInfo] = useState<AIProviderInfo[]>([])
  /** 待发缓冲：真人不会秒回——发出的消息先挂着，停顿几秒没有新消息了才一起交给 AI 回一轮 */
  const [pendingTexts, setPendingTexts] = useState<string[]>([])
  const pendingRef = useRef<string[]>([])
  const inputValueRef = useRef('')
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldStickToBottomRef = useRef(true)
  const scrollFrameRef = useRef<number | null>(null)
  const scrollTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const lastSavedCountRef = useRef(0)
  const conversationIdRef = useRef<number | null>(null)
  const conversationUpdatedAtRef = useRef(0)
  const pendingConversationReloadRef = useRef<number | null>(null)
  const conversationSourceRef = useRef('')
  const wechatKnownAssistantMessageIdsRef = useRef<Set<string>>(new Set())
  const wechatPushPendingMessageIdsRef = useRef<Set<string>>(new Set())
  const clientIdRef = useRef(`persona-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const busyRef = useRef(false)
  const historyOpenRef = useRef(false)

  const resetWechatPushState = () => {
    conversationSourceRef.current = ''
    wechatKnownAssistantMessageIdsRef.current = new Set()
    wechatPushPendingMessageIdsRef.current = new Set()
  }

  const transport = useMemo(() => new PersonaChatTransport(() => sessionId), [sessionId])
  const { messages, sendMessage, setMessages, status, stop, error } = useChat({ transport, experimental_throttle: 50 })
  const busy = status === 'submitted' || status === 'streaming'
  const modelInfoByKey = useMemo(() => {
    const map = new Map<string, AIModelInfo>()
    for (const provider of providersInfo) {
      for (const detail of provider.modelDetails || []) {
        map.set(`${provider.id}::${detail.id}`, detail)
        if (!map.has(detail.id)) map.set(detail.id, detail)
      }
    }
    return map
  }, [providersInfo])
  conversationIdRef.current = conversationId
  busyRef.current = busy
  historyOpenRef.current = historyOpen
  const stopRef = useRef(stop)
  const stopVoiceRef = useRef<() => void>(() => {})
  const setMessagesRef = useRef(setMessages)
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_RENDERED_MESSAGE_COUNT)
  const visibleMessageCountRef = useRef(INITIAL_RENDERED_MESSAGE_COUNT)
  const messagesLengthRef = useRef(0)
  const loadingOlderRef = useRef(false)

  visibleMessageCountRef.current = visibleMessageCount
  messagesLengthRef.current = messages.length

  const visibleMessages = useMemo(() => {
    const start = Math.max(0, messages.length - visibleMessageCount)
    return messages.slice(start)
  }, [messages, visibleMessageCount])
  const hiddenMessageCount = Math.max(0, messages.length - visibleMessages.length)

  const clearScheduledScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
    for (const timer of scrollTimersRef.current) clearTimeout(timer)
    scrollTimersRef.current = []
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    shouldStickToBottomRef.current = true
    clearScheduledScroll()
    const apply = () => {
      const el = scrollRef.current
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior })
    }
    apply()
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      apply()
    })
    scrollTimersRef.current = [80, 240, 600].map((delay) => setTimeout(apply, delay))
  }, [clearScheduledScroll])

  const loadOlderMessages = useCallback(() => {
    const total = messagesLengthRef.current
    const current = visibleMessageCountRef.current
    if (loadingOlderRef.current || current >= total) return

    const el = scrollRef.current
    const previousHeight = el?.scrollHeight ?? 0
    const previousTop = el?.scrollTop ?? 0

    loadingOlderRef.current = true
    setVisibleMessageCount(Math.min(total, current + RENDERED_MESSAGE_BATCH_SIZE))
    requestAnimationFrame(() => {
      const nextEl = scrollRef.current
      if (nextEl) nextEl.scrollTop = nextEl.scrollHeight - previousHeight + previousTop
      loadingOlderRef.current = false
    })
  }, [])

  const handleMessageScroll = () => {
    const el = scrollRef.current
    if (!el) return
    shouldStickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96
    if (el.scrollTop < 80 && visibleMessageCountRef.current < messagesLengthRef.current) loadOlderMessages()
  }

  const handleMessageMediaLoad = () => {
    if (shouldStickToBottomRef.current) scrollToBottom()
  }

  // 语音消息：模型自己决定哪条用语音发（行首 [语音] 标记），这里负责微信式的"点开听"
  const { speakingKey, speakingState, speak: speakVoice, stop: stopVoice } = useTtsSpeaker()
  /** 已听过的语音气泡 key（message.id:index）；恢复历史时全部预置为已听，新来的才有红点 */
  const [playedVoice, setPlayedVoice] = useState<Set<string>>(() => new Set())
  /** 播放失败（TTS 不可用等）兜底显示文字的气泡 */
  const [revealedVoice, setRevealedVoice] = useState<Set<string>>(() => new Set())
  /** 连播链 id：点新语音/停止时自增，旧的连播循环检测到后退出 */
  const voiceChainRef = useRef(0)
  useEffect(() => () => { stopVoice() }, [stopVoice])

  useEffect(() => {
    stopRef.current = stop
    stopVoiceRef.current = stopVoice
    setMessagesRef.current = setMessages
  }, [setMessages, stop, stopVoice])

  useEffect(() => {
    let cancelled = false
    void getAIProviders().then((items) => {
      if (!cancelled) setProvidersInfo(items)
    }).catch(() => {
      if (!cancelled) setProvidersInfo([])
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    stopRef.current()
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    stopVoiceRef.current()
    pendingRef.current = []
    inputValueRef.current = ''
    shouldStickToBottomRef.current = true
    clearScheduledScroll()
    loadingOlderRef.current = false
    visibleMessageCountRef.current = INITIAL_RENDERED_MESSAGE_COUNT
    lastSavedCountRef.current = 0
    conversationIdRef.current = null
    conversationUpdatedAtRef.current = 0
    pendingConversationReloadRef.current = null
    resetWechatPushState()
    setDisplayName('')
    setAvatarUrl(undefined)
    setMyAvatarUrl(undefined)
    setSessionDetailLoading(Boolean(sessionId))
    setPhase('loading')
    setPersona(null)
    setBuildProgress(null)
    setBuildError(null)
    setConversationId(null)
    setPendingTexts([])
    setVisibleMessageCount(INITIAL_RENDERED_MESSAGE_COUNT)
    setPlayedVoice(new Set())
    setRevealedVoice(new Set())
    setVoiceCloneStatus(null)
    setSpeakingStyleOpen(false)
    setSpeakingStyleSaving(false)
    setSpeakingStyleDraft(EMPTY_SPEAKING_STYLE_DRAFT)
    setSpeakingStyleError('')
    setConfirmAction(null)
    setHistoryOpen(false)
    setHistoryRecords([])
    setRecordPendingDelete(null)
    setMessagesRef.current([])
  }, [clearScheduledScroll, sessionId])

  const markVoicePlayed = (key: string) => {
    setPlayedVoice((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }

  /** 点开一条语音：先播它，然后像微信一样自动连播本条消息里后续未听过的语音。 */
  const handlePlayVoice = async (messageId: string, bubbles: PersonaBubble[], startIndex: number) => {
    const chain = ++voiceChainRef.current
    for (let i = startIndex; i < bubbles.length; i += 1) {
      if (voiceChainRef.current !== chain) return
      const bubble = bubbles[i]
      if (!bubble.isVoice) continue
      const key = `${messageId}:${i}`
      if (i > startIndex && playedVoice.has(key)) continue
      markVoicePlayed(key)
      const res = await speakVoice(key, bubble.text, {
        awaitEnd: true,
        instructions: persona?.card.ttsInstructions,
        personaVoice: persona?.ttsVoice,
      })
      if (voiceChainRef.current !== chain || res.stopped) return
      if (!res.ok) {
        // 念不出来就把文字亮出来兜底
        setRevealedVoice((prev) => new Set(prev).add(key))
        return
      }
    }
  }
  // 本轮回复流结束后：语音发问自动朗读一次；通话模式则播完继续听下一句
  useEffect(() => {
    const wasBusy = wasBusyRef.current
    wasBusyRef.current = busy
    if (!(wasBusy && !busy)) return
    const last = messages[messages.length - 1]
    const playReply = async () => {
      if (last?.role !== 'assistant') return
      const bubbles = messageTextParts(last).map((part) => part.trim()).filter(Boolean).map(parseBubble)
      const firstVoice = bubbles.findIndex((bubble) => bubble.isVoice)
      if (firstVoice >= 0) await handlePlayVoice(last.id, bubbles, firstVoice)
    }
    if (callActiveRef.current) {
      setCallPhase('speaking')
      void playReply().finally(() => {
        if (callActiveRef.current) {
          setCallPhase('listening')
          callSessionRef.current?.resume()
        }
      })
    } else if (autoPlayReplyRef.current) {
      autoPlayReplyRef.current = false
      void playReply()
    }
  }, [busy, messages])

  // 切会话/卸载时挂断通话，释放麦克风
  useEffect(() => {
    return () => {
      callActiveRef.current = false
      callSessionRef.current?.stop()
      callSessionRef.current = null
    }
  }, [sessionId])

  // AI 已经开始逐条吐气泡后就不再显示"正在输入"指示器，否则像凭空多了一条带头像的消息
  const lastMessage = messages[messages.length - 1]
  const showTypingIndicator = busy && !(lastMessage?.role === 'assistant' && messageText(lastMessage).trim().length > 0)
  const headerTitle = busy ? '对方正在输入…' : (displayName || sessionId)

  // 待发缓冲计时：发完一条等 2-4 秒，期间继续发会重新计时；输入框里还有字也再等等
  const PENDING_FLUSH_MIN_MS = 2000
  const PENDING_FLUSH_MAX_MS = 4000
  const PENDING_TYPING_POSTPONE_MS = 2000

  const flushPending = () => {
    const texts = pendingRef.current
    if (texts.length === 0) return
    pendingRef.current = []
    setPendingTexts([])
    // 多条连发合成一条多 part 消息：每个 part 就是一个聊天气泡。
    void sendMessage({ parts: texts.map((text) => ({ type: 'text' as const, text })) })
  }

  const armFlushTimer = (delayMs?: number) => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      if (inputValueRef.current.trim()) {
        armFlushTimer(PENDING_TYPING_POSTPONE_MS)
        return
      }
      flushPending()
    }, delayMs ?? PENDING_FLUSH_MIN_MS + Math.random() * (PENDING_FLUSH_MAX_MS - PENDING_FLUSH_MIN_MS))
  }

  const clearPending = () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    pendingRef.current = []
    setPendingTexts([])
  }

  const restoreConversation = useCallback((conv: PersonaLoadedConversation) => {
    const id = Number(conv.id)
    if (!Number.isFinite(id) || id <= 0) return
    const nextMessages = Array.isArray(conv.messages) ? conv.messages : []
    setMessages(nextMessages)
    setConversationId(id)
    conversationIdRef.current = id
    conversationUpdatedAtRef.current = Number(conv.updatedAt || Date.now())
    conversationSourceRef.current = String(conv.source || '')
    wechatKnownAssistantMessageIdsRef.current = new Set(assistantMessageIds(nextMessages))
    wechatPushPendingMessageIdsRef.current = new Set()
    lastSavedCountRef.current = nextMessages.length
    pendingConversationReloadRef.current = null
    setPlayedVoice(new Set())
    setRevealedVoice(new Set())
    setVisibleMessageCount(INITIAL_RENDERED_MESSAGE_COUNT)
  }, [setMessages])

  const loadConversationIntoState = useCallback(async (id: number) => {
    const res = await window.electronAPI.agent.loadConversation(id)
    const conv = res.success && res.conversation
      ? (res.conversation as PersonaLoadedConversation)
      : null
    if (!conv) {
      throw new Error(res.error || '读取对话记录失败')
    }
    restoreConversation(conv)
  }, [restoreConversation])

  const refreshHistory = useCallback(async () => {
    const res = await window.electronAPI.agent.listConversations({ kind: 'persona', sessionId })
    if (res.success && Array.isArray(res.conversations)) {
      setHistoryRecords(res.conversations as PersonaConversationRecord[])
    }
  }, [sessionId])

  // 卸载时清掉待发计时器
  useEffect(() => () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    clearScheduledScroll()
  }, [clearScheduledScroll])

  useEffect(() => {
    scrollToBottom()
  }, [messages, pendingTexts, busy, phase, scrollToBottom])

  useEffect(() => {
    if (phase !== 'chat') return
    scrollToBottom()
  }, [phase, sessionId, scrollToBottom])

  // 窗口标题同步（任务栏/系统标题栏）
  useEffect(() => {
    if (embedded) return
    document.title = busy ? '对方正在输入…' : (displayName ? `${displayName}` : '克隆好友')
  }, [busy, displayName, embedded])

  // 拉好友信息（昵称/头像）
  useEffect(() => {
    if (!sessionId) {
      setSessionDetailLoading(false)
      return
    }
    let cancelled = false
    setSessionDetailLoading(true)
    void Promise.all([
      window.electronAPI.chat.getSessionDetail(sessionId),
      window.electronAPI.chat.getMyAvatarUrl(),
    ]).then(([res, myAvatarRes]) => {
      if (cancelled) return
      if (res.success && res.detail) {
        setDisplayName(res.detail.displayName || res.detail.nickName || sessionId)
        setAvatarUrl(res.detail.avatarUrl)
      } else {
        setDisplayName(sessionId)
      }
      if (myAvatarRes.success && myAvatarRes.avatarUrl) {
        setMyAvatarUrl(myAvatarRes.avatarUrl)
      }
      setSessionDetailLoading(false)
    }).catch(() => {
      if (!cancelled) {
        setDisplayName(sessionId)
        setSessionDetailLoading(false)
      }
    })
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
        // 后台自动进化：和 TA 的真实聊天新增够多时增量重蒸馏画像（静默，失败不影响聊天）
        void window.electronAPI.persona.refreshIfStale(sessionId).then((evolved) => {
          if (!cancelled && evolved.success && evolved.refreshed && evolved.persona) setPersona(evolved.persona)
        }).catch(() => { /* 静默 */ })
        try {
          const last = await window.electronAPI.agent.getLastConversation({ kind: 'persona', sessionId })
          const meta = last.success && last.conversation ? (last.conversation as { id: number }) : null
          if (!meta || cancelled) return
          const loaded = await window.electronAPI.agent.loadConversation(meta.id)
          const conv = loaded.success && loaded.conversation
            ? (loaded.conversation as PersonaLoadedConversation)
            : null
          if (conv && !cancelled) restoreConversation(conv)
        } catch { /* 恢复失败就从空对话开始 */ }
      } else {
        setPhase('confirm')
      }
    })
    return () => { cancelled = true }
  }, [restoreConversation, sessionId])

  // 画像构建进度
  useEffect(() => {
    return window.electronAPI.persona.onBuildProgress((p) => {
      if (p.sessionId === sessionId) setBuildProgress(p)
    })
  }, [sessionId])

  // 每轮结束保存对话；保存后触发对话反思（主进程攒够未反思消息才真正跑，提炼导演笔记）
  // 保存时携带当前加载版本；如果数据库已有外部新消息，主进程会合并后再写回。
  useEffect(() => {
    if (status !== 'ready' || !conversationId || messages.length === 0) return
    if (messages.length === lastSavedCountRef.current) return
    lastSavedCountRef.current = messages.length
    const baseUpdatedAt = conversationUpdatedAtRef.current
    const shouldPushToWechat = conversationSourceRef.current === 'wechat' || conversationSourceRef.current === 'wechat-persona'
    const wechatPushes = shouldPushToWechat
      ? messages
        .filter((message) => message.role === 'assistant' && typeof message.id === 'string' && message.id.trim())
        .filter((message) => !wechatKnownAssistantMessageIdsRef.current.has(message.id) && !wechatPushPendingMessageIdsRef.current.has(message.id))
        .map((message) => ({ messageId: message.id, bubbles: wechatPushBubblesFromMessage(message) }))
        .filter((item) => item.bubbles.length > 0)
      : []
    for (const item of wechatPushes) wechatPushPendingMessageIdsRef.current.add(item.messageId)

    void window.electronAPI.agent.saveConversationMessages({
      id: conversationId,
      messages,
      baseUpdatedAt,
      mergeIfStale: true,
      originClientId: clientIdRef.current,
    })
      .then(async (result: any) => {
        if (result?.success && result.conversation) {
          conversationUpdatedAtRef.current = Number(result.conversation.updatedAt || conversationUpdatedAtRef.current)
          for (const item of wechatPushes) {
            try {
              const pushResult = await window.electronAPI.agent.sendConversationReplyToWechat({
                conversationId,
                messageId: item.messageId,
                bubbles: item.bubbles,
              })
              if (!pushResult.success) {
                console.warn('[PersonaChat] failed to push reply to WeChat bot', pushResult.error)
              } else {
                wechatKnownAssistantMessageIdsRef.current.add(item.messageId)
              }
            } catch (pushError) {
              console.warn('[PersonaChat] error while pushing reply to WeChat bot', pushError)
            } finally {
              wechatPushPendingMessageIdsRef.current.delete(item.messageId)
            }
          }
          if (result.staleMerged) await loadConversationIntoState(conversationId)
        } else {
          for (const item of wechatPushes) wechatPushPendingMessageIdsRef.current.delete(item.messageId)
        }
        return window.electronAPI.persona.reflect({ sessionId, conversationId })
      })
      .catch(() => {
        for (const item of wechatPushes) wechatPushPendingMessageIdsRef.current.delete(item.messageId)
        /* save failure should not interrupt chat */
      })
  }, [status, conversationId, messages, sessionId, loadConversationIntoState])

  useEffect(() => {
    return window.electronAPI.agent.onConversationUpdated((event: AgentConversationUpdatedEvent) => {
      const eventId = Number(event?.id || 0)
      if (!eventId) return
      const eventScope = event?.scope as { kind?: string; sessionId?: string } | undefined
      const matchesPersona = eventScope?.kind === 'persona' && eventScope.sessionId === sessionId
      if (matchesPersona && historyOpenRef.current) void refreshHistory()

      if (eventId !== conversationIdRef.current) return
      if (event.changeType === 'deleted') {
        setMessages([])
        setConversationId(null)
        conversationIdRef.current = null
        conversationUpdatedAtRef.current = 0
        lastSavedCountRef.current = 0
        pendingConversationReloadRef.current = null
        resetWechatPushState()
        setPlayedVoice(new Set())
        setRevealedVoice(new Set())
        return
      }
      if (event.originClientId && event.originClientId === clientIdRef.current) return
      conversationUpdatedAtRef.current = Number(event.updatedAt || conversationUpdatedAtRef.current)
      if (busyRef.current) {
        pendingConversationReloadRef.current = eventId
        return
      }
      void loadConversationIntoState(eventId)
    })
  }, [loadConversationIntoState, refreshHistory, sessionId])

  useEffect(() => {
    if (status !== 'ready' || busy) return
    const pendingId = pendingConversationReloadRef.current
    if (!pendingId) return
    pendingConversationReloadRef.current = null
    void loadConversationIntoState(pendingId)
  }, [busy, loadConversationIntoState, status])


  const handleBuild = async () => {
    setPhase('building')
    setBuildError(null)
    setBuildProgress(null)
    const res = await window.electronAPI.persona.build({ sessionId, displayName })
    if (res.success && res.persona) {
      setPersona(res.persona)
      setPhase('chat')
      onPersonaChanged?.()
    } else {
      setBuildError(res.error || '克隆失败')
      setPhase('confirm')
    }
  }

  const handleDelete = async () => {
    if (busy) stop()
    clearPending()
    await window.electronAPI.persona.delete(sessionId)
    setPersona(null)
    setMessages([])
    setConversationId(null)
    conversationIdRef.current = null
    lastSavedCountRef.current = 0
    conversationUpdatedAtRef.current = 0
    pendingConversationReloadRef.current = null
    resetWechatPushState()
    setPhase('confirm')
    onPersonaChanged?.()
  }

  const handleCloneVoice = async () => {
    if (voiceCloning || !persona) return
    setVoiceCloning(true)
    setVoiceCloneStatus({ ok: true, text: '正在复刻声音…' })
    try {
      const res = await window.electronAPI.persona.cloneVoice({ sessionId, displayName })
      if (res.success && res.persona) {
        setPersona(res.persona)
        const providerText = res.voice?.provider === 'xiaomi'
          ? '小米音色样本'
          : res.voice?.provider === 'aliyun-qwen'
            ? '通义音色'
            : '豆包音色'
        setVoiceCloneStatus({ ok: true, text: `已绑定专属${providerText}${res.warning ? `（${res.warning}）` : ''}` })
      } else {
        setVoiceCloneStatus({ ok: false, text: res.error || '声音复刻失败' })
      }
    } catch (e) {
      setVoiceCloneStatus({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setVoiceCloning(false)
    }
  }

  const openSpeakingStyleEditor = () => {
    if (!persona) return
    setSpeakingStyleDraft({
      tone: persona.card.tone || '',
      personalityTraits: listToDraft(persona.card.personalityTraits),
      catchphrases: listToDraft(persona.card.catchphrases),
      punctuationStyle: persona.card.punctuationStyle || '',
      addressing: persona.card.addressing || '',
      topics: listToDraft(persona.card.topics),
      ttsInstructions: persona.card.ttsInstructions || '',
    })
    setSpeakingStyleError('')
    setSpeakingStyleOpen(true)
  }

  const updateSpeakingStyleDraft = (key: keyof SpeakingStyleDraft, value: string) => {
    setSpeakingStyleDraft((draft) => ({ ...draft, [key]: value }))
  }

  const handleSaveSpeakingStyle = async () => {
    if (!persona || speakingStyleSaving) return
    setSpeakingStyleSaving(true)
    setSpeakingStyleError('')
    try {
      const res = await window.electronAPI.persona.updateSpeakingStyle({
        sessionId,
        card: {
          tone: speakingStyleDraft.tone,
          personalityTraits: draftToList(speakingStyleDraft.personalityTraits),
          catchphrases: draftToList(speakingStyleDraft.catchphrases),
          punctuationStyle: speakingStyleDraft.punctuationStyle,
          addressing: speakingStyleDraft.addressing,
          topics: draftToList(speakingStyleDraft.topics),
          ttsInstructions: speakingStyleDraft.ttsInstructions,
        },
      })
      if (res.success && res.persona) {
        setPersona(res.persona)
        setSpeakingStyleOpen(false)
        onPersonaChanged?.()
      } else {
        setSpeakingStyleError(res.error || '保存说话方式失败')
      }
    } catch (e) {
      setSpeakingStyleError(e instanceof Error ? e.message : String(e))
    } finally {
      setSpeakingStyleSaving(false)
    }
  }

  const handleClearConversations = async () => {
    if (busy || clearingConversations) return
    clearPending()
    setClearingConversations(true)
    try {
      const scope = { kind: 'persona', sessionId }
      const deleteViaExistingApis = async () => {
        const list = await window.electronAPI.agent.listConversations(scope)
        if (!list.success || !Array.isArray(list.conversations)) {
          throw new Error(list.error || '读取对话记录失败')
        }
        for (const item of list.conversations) {
          const id = Number((item as { id?: unknown }).id)
          if (Number.isFinite(id) && id > 0) {
            const res = await window.electronAPI.agent.deleteConversation(id)
            if (!res.success) throw new Error(res.error || '删除对话记录失败')
          }
        }
      }
      const deleteByScope = window.electronAPI.agent.deleteConversationsByScope
      if (deleteByScope) {
        try {
          const res = await deleteByScope(scope)
          if (!res.success) throw new Error(res.error || '删除对话记录失败')
        } catch (e) {
          if (!String(e instanceof Error ? e.message : e).includes('No handler registered')) throw e
          await deleteViaExistingApis()
        }
      } else {
        await deleteViaExistingApis()
      }
      setMessages([])
      setConversationId(null)
      lastSavedCountRef.current = 0
      conversationIdRef.current = null
      conversationUpdatedAtRef.current = 0
      pendingConversationReloadRef.current = null
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setClearingConversations(false)
    }
  }


  const handleHistoryOpenChange = (open: boolean) => {
    historyOpenRef.current = open
    setHistoryOpen(open)
    if (open) void refreshHistory()
  }

  /** 把历史里某条对话（含微信分身归档）载入当前窗口继续聊。 */
  const openConversation = async (id: number) => {
    setHistoryOpen(false)
    historyOpenRef.current = false
    if (busy) stop()
    clearPending()
    stopVoice()
    await loadConversationIntoState(id)
  }

  /** 开启一段全新对话：清空当前消息，conversationId 留空，首次发送时再懒创建。 */
  const startNewConversation = () => {
    setHistoryOpen(false)
    if (busy) stop()
    clearPending()
    stopVoice()
    setMessages([])
    setConversationId(null)
    conversationIdRef.current = null
    lastSavedCountRef.current = 0
    conversationUpdatedAtRef.current = 0
    pendingConversationReloadRef.current = null
    resetWechatPushState()
    setPlayedVoice(new Set())
    setRevealedVoice(new Set())
    setVisibleMessageCount(INITIAL_RENDERED_MESSAGE_COUNT)
  }

  const handleDeleteRecord = async (record: PersonaConversationRecord) => {
    const res = await window.electronAPI.agent.deleteConversation(record.id)
    if (!res.success) {
      window.alert(res.error || '删除对话记录失败')
      return
    }
    setHistoryRecords((prev) => prev.filter((item) => item.id !== record.id))
    if (record.id === conversationId) {
      setMessages([])
      setConversationId(null)
      conversationIdRef.current = null
      lastSavedCountRef.current = 0
      conversationUpdatedAtRef.current = 0
      pendingConversationReloadRef.current = null
      resetWechatPushState()
      setPlayedVoice(new Set())
      setRevealedVoice(new Set())
    }
  }

  const ensureConversation = async () => {
    inputValueRef.current = ''
    if (!conversationIdRef.current) {
      try {
        const created = await window.electronAPI.agent.createConversation({
          scope: { kind: 'persona', sessionId, displayName },
          title: `${displayName || sessionId}的分身`,
          originClientId: clientIdRef.current,
        })
        if (created.success && created.conversation) {
          const record = created.conversation as { id: number; updatedAt?: number }
          setConversationId(record.id)
          conversationIdRef.current = record.id
          conversationUpdatedAtRef.current = Number(record.updatedAt || Date.now())
          conversationSourceRef.current = String((record as { source?: unknown }).source || '')
          wechatKnownAssistantMessageIdsRef.current = new Set()
          wechatPushPendingMessageIdsRef.current = new Set()
        }
      } catch { /* 创建失败不阻塞发送，本轮不持久化 */ }
    }
  }

  const handleSendText = async (rawText: string) => {
    const text = rawText.trim()
    if (!text || busy) return
    await ensureConversation()
    // 不直接触发 AI：先进待发缓冲，停顿几秒后这一串一起交给对方回
    pendingRef.current = [...pendingRef.current, text]
    setPendingTexts(pendingRef.current)
    armFlushTimer()
  }

  // 按住说话：按下开始录音
  const startVoiceInput = async () => {
    if (busy || voiceInput !== 'idle') return
    stopVoice() // 开口即打断分身正在播的语音
    try {
      recorderRef.current = await startVoiceRecording()
      setVoiceInput('recording')
    } catch (e) {
      setVoiceCloneStatus({ ok: false, text: `无法打开麦克风：${e instanceof Error ? e.message : String(e)}` })
    }
  }

  // 松开：停止录音 → 转写 → 当作文本消息发出去（走现有待发缓冲/回复流）
  const finishVoiceInput = async (send: boolean) => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (!recorder) return
    if (!send) {
      recorder.cancel()
      setVoiceInput('idle')
      return
    }
    setVoiceInput('transcribing')
    try {
      const { wavBase64, durationSec } = await recorder.stop()
      if (durationSec < 0.4) { setVoiceInput('idle'); return } // 太短当误触，忽略
      const res = await window.electronAPI.stt.transcribeBuffer(wavBase64)
      if (!res.success || !res.transcript?.trim()) {
        setVoiceCloneStatus({ ok: false, text: res.error || '没听清，请再说一次' })
        return
      }
      await handleSendText(res.transcript.trim())
      autoPlayReplyRef.current = true // 这一轮回复自动用复刻音色念出来
    } catch (e) {
      setVoiceCloneStatus({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setVoiceInput('idle')
    }
  }

  // 通话模式：立即发送（绕过打字用的 2-4s 待发缓冲，避免通话时发闷）
  const sendNow = async (rawText: string) => {
    const text = rawText.trim()
    if (!text) return
    await ensureConversation()
    clearPending()
    await sendMessage({ parts: [{ type: 'text' as const, text }] })
  }

  // 通话模式：VAD 断句拿到一句话 → 转写 → 立即发送（回复的播放/续听在 busy→idle 的 effect 里）
  const handleCallUtterance = async (wavBase64: string) => {
    if (!callActiveRef.current) return
    const session = callSessionRef.current
    session?.pause() // 分身说话期间别听，避免外放回声自触发
    setCallPhase('recognizing')
    try {
      const res = await window.electronAPI.stt.transcribeBuffer(wavBase64)
      if (!callActiveRef.current) return
      const text = res.success ? String(res.transcript || '').trim() : ''
      if (!text) {
        setCallPhase('listening')
        session?.resume()
        return
      }
      setCallPhase('thinking')
      await sendNow(text)
    } catch {
      if (callActiveRef.current) {
        setCallPhase('listening')
        session?.resume()
      }
    }
  }
  handleCallUtteranceRef.current = handleCallUtterance // 每次渲染刷新，供常驻的通话会话回调取最新闭包

  const startCall = async () => {
    if (callActive) return
    stopVoice()
    setCallPhase('connecting')
    try {
      const session = await startVoiceCall({
        onUtterance: (wav) => handleCallUtteranceRef.current(wav),
        onError: (err) => setVoiceCloneStatus({ ok: false, text: err.message }),
      })
      callSessionRef.current = session
      callActiveRef.current = true
      setCallActive(true)
      setCallPhase('listening')
    } catch (e) {
      setVoiceCloneStatus({ ok: false, text: `无法开始通话：${e instanceof Error ? e.message : String(e)}` })
      setCallActive(false)
    }
  }

  const endCall = () => {
    callActiveRef.current = false
    setCallActive(false)
    callSessionRef.current?.stop()
    callSessionRef.current = null
    stopVoice()
  }

  const handlePromptSubmit = async (message: PromptInputMessage) => {
    if (busy) {
      stop()
      return
    }
    const text = message.text.trim()
    if (message.files.length > 0) {
      await ensureConversation()
      clearPending()
      await sendMessage({
        parts: [
          ...message.files.map((file) => ({ ...file, type: 'file' as const })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ],
      })
      return
    }
    await handleSendText(text)
  }

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">无效的会话</div>
    )
  }

  if (phase === 'loading' || sessionDetailLoading) {
    return <PersonaChatSkeleton />
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
          <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
          <span>
            克隆和聊天时，部分聊天记录会发送给你配置的 AI 模型服务商用于分析与生成。
            如使用 Ollama 等本地模型则数据不出本机。画像仅保存在本地，可随时删除。
          </span>
        </div>
        {buildError && (
          <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
            <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
            <span>{buildError}</span>
          </div>
        )}
        <Button onPress={handleBuild}>
          <FaceRobot className="size-4" />
          开始克隆
        </Button>
      </div>
    )
  }

  if (phase === 'building') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
        {/* 呼吸光环：AI 单次调用期间百分比不动，靠动画表明没卡死 */}
        <div className="relative flex size-20 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-accent/20 animation-duration-[2.4s]" />
          <span className="absolute inset-1 animate-pulse rounded-full bg-accent/15" />
          <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={64} />
        </div>
        <h2 className="text-base font-semibold text-foreground">正在克隆「{displayName}」</h2>
        <ProgressBar aria-label="克隆进度" className="w-full" value={buildProgress?.percent ?? 0} maxValue={100}>
          <Label>{buildProgress?.title || '准备中…'}</Label>
          <ProgressBar.Output />
          <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
        </ProgressBar>
        <div className="flex items-center gap-2 text-xs text-muted">
          <CircleDashed width={14} height={14} className="shrink-0 animate-spin" />
          <span className="text-center">
            {buildProgress?.detail || '分析聊天记录并调用 AI 提炼画像与真实问答，通常需要几分钟'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* 仿手机聊天头部：等待回复时只显示"对方正在输入…" */}
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border/60 px-3 sm:px-4">
        <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={44} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">{headerTitle}</div>
          <div className="truncate text-sm text-muted">
            数字分身{persona ? ` · 基于 ${persona.stats.friendMessageCount + (persona.stats.groupMessageCount || 0)} 条消息${persona.stats.groupMessageCount ? `（含群聊发言 ${persona.stats.groupMessageCount} 条）` : ''}${persona.ttsVoice ? ` · ${getPersonaVoiceLabel(persona)}` : ''}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Dropdown isOpen={historyOpen} onOpenChange={handleHistoryOpenChange}>
            <Button isIconOnly size="sm" variant="ghost" aria-label="历史对话记录">
              <ClockArrowRotateLeft width={16} height={16} />
            </Button>
            <Dropdown.Popover className="w-[min(22rem,calc(100vw-2rem))]" placement="bottom end">
              <Dropdown.Menu
                className="max-h-[min(70vh,26rem)] overflow-y-auto"
                selectedKeys={conversationId ? [String(conversationId)] : []}
                selectionMode="single"
                onAction={(key) => {
                  const id = String(key)
                  if (id === '__new__') { startNewConversation(); return }
                  if (id === '__empty__') return
                  const record = historyRecords.find((item) => String(item.id) === id)
                  if (record) void openConversation(record.id)
                }}
              >
                <Dropdown.Item id="__new__" key="__new__" textValue="开启新对话">
                  <PencilToSquare className="size-4 shrink-0 text-muted" />
                  <Label>开启新对话</Label>
                </Dropdown.Item>
                {historyRecords.length > 0 ? (
                  <Dropdown.Section>
                    <Header>历史对话</Header>
                    {historyRecords.map((record) => (
                      <Dropdown.Item className="min-h-14 gap-3 py-2.5" id={String(record.id)} key={record.id} textValue={record.title}>
                        <Dropdown.ItemIndicator />
                        <Clock className="size-4 shrink-0 text-muted" />
                        <span className="min-w-0 flex-1">
                          <Label className="block truncate text-sm font-medium">{record.title}</Label>
                          <span className="block truncate text-xs text-muted">
                            {record.source === 'wechat-persona' ? '微信 · ' : ''}
                            {new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </span>
                        <span
                          className="ms-auto flex shrink-0"
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <Button
                            aria-label={`删除 ${record.title}`}
                            className="size-8 p-0 text-muted hover:text-danger"
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            onPress={() => { setRecordPendingDelete(record); setHistoryOpen(false) }}
                          >
                            <TrashBin className="size-4" />
                          </Button>
                        </span>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Section>
                ) : (
                  <Dropdown.Item className="justify-center py-6 text-center text-sm text-muted" id="__empty__" key="__empty__" isDisabled textValue="暂无对话记录">
                    暂无对话记录
                  </Dropdown.Item>
                )}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant={persona?.ttsVoice ? 'secondary' : 'ghost'}
                aria-label={persona?.ttsVoice ? '重新克隆声音' : '克隆声音'}
                isDisabled={busy || voiceCloning}
                isPending={voiceCloning}
                onPress={handleCloneVoice}
              >
                <Microphone width={16} height={16} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">{persona?.ttsVoice ? '重新克隆声音' : '克隆声音'}</Tooltip.Content>
          </Tooltip>
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="修改说话方式"
                isDisabled={busy || !persona}
                onPress={openSpeakingStyleEditor}
              >
                <PencilToLine width={16} height={16} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">修改说话方式</Tooltip.Content>
          </Tooltip>
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button isIconOnly size="sm" variant="ghost" aria-label="重建画像" isDisabled={busy} onPress={() => setPhase('confirm')}>
                <ArrowsRotateLeft width={16} height={16} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">重建画像（聊天记录更新后可重新克隆）</Tooltip.Content>
          </Tooltip>
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="删除对话记录"
                isDisabled={busy || clearingConversations}
                isPending={clearingConversations}
                onPress={() => setConfirmAction('clearConversations')}
              >
                <CommentSlash width={16} height={16} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">删除该分身的所有对话记录</Tooltip.Content>
          </Tooltip>
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button isIconOnly size="sm" variant="ghost" aria-label="删除分身" onPress={() => setConfirmAction('deletePersona')}>
                <TrashBin width={16} height={16} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">删除分身画像</Tooltip.Content>
          </Tooltip>
        </div>
      </div>

      {voiceCloneStatus && (
        <div className={`mx-4 mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
          voiceCloneStatus.ok
            ? 'bg-success-soft text-success-soft-foreground'
            : 'bg-danger-soft text-danger-soft-foreground'
        }`}>
          {voiceCloneStatus.ok ? <CircleCheck width={14} height={14} className="mt-0.5 shrink-0" /> : <CircleExclamation width={14} height={14} className="mt-0.5 shrink-0" />}
          <span>{voiceCloneStatus.text}</span>
        </div>
      )}

      <Modal.Backdrop
        isOpen={speakingStyleOpen}
        onOpenChange={(open) => { if (!open && !speakingStyleSaving) setSpeakingStyleOpen(false) }}
      >
        <Modal.Container placement="center" size="lg">
          <Modal.Dialog className="max-h-[calc(100vh-5rem)]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
                <PencilToLine width={20} height={20} />
              </Modal.Icon>
              <Modal.Heading>修改说话方式</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="max-h-[64vh] space-y-5 overflow-y-auto pr-1">
                <section className="space-y-3">
                  <div>
                    <h3 className="m-0 text-sm font-semibold text-foreground">基础语气</h3>
                    <p className="m-0 mt-1 text-xs text-muted">控制整体聊天感觉。</p>
                  </div>
                  <SpeakingStyleField
                    label="语气风格"
                    description="描述 TA 整体怎么说话。"
                    minRows={4}
                    placeholder="例如：说话直接、短句多，偶尔开玩笑，不太正式。"
                    value={speakingStyleDraft.tone}
                    onChange={(value) => updateSpeakingStyleDraft('tone', value)}
                  />
                  <SpeakingStyleField
                    label="性格标签"
                    description="每行一个标签。"
                    placeholder={'慢热\n嘴硬\n爱吐槽'}
                    value={speakingStyleDraft.personalityTraits}
                    onChange={(value) => updateSpeakingStyleDraft('personalityTraits', value)}
                  />
                </section>

                <section className="space-y-3">
                  <div>
                    <h3 className="m-0 text-sm font-semibold text-foreground">常用表达</h3>
                    <p className="m-0 mt-1 text-xs text-muted">控制 TA 经常冒出来的词和称呼。</p>
                  </div>
                  <SpeakingStyleField
                    label="口头禅"
                    description="每行一个，聊天时只会偶尔使用。"
                    placeholder={'哈哈哈\n离谱\n算了算了'}
                    value={speakingStyleDraft.catchphrases}
                    onChange={(value) => updateSpeakingStyleDraft('catchphrases', value)}
                  />
                  <SpeakingStyleField
                    label="称呼习惯"
                    description="TA 通常怎么称呼你。"
                    placeholder="例如：一般直接叫名字，很少用亲昵称呼。"
                    value={speakingStyleDraft.addressing}
                    onChange={(value) => updateSpeakingStyleDraft('addressing', value)}
                  />
                </section>

                <section className="space-y-3">
                  <div>
                    <h3 className="m-0 text-sm font-semibold text-foreground">回复习惯</h3>
                    <p className="m-0 mt-1 text-xs text-muted">控制标点、排版和经常聊的话题。</p>
                  </div>
                  <SpeakingStyleField
                    label="标点和排版习惯"
                    description="比如是否爱用句号、波浪号、短句连发。"
                    placeholder="例如：很少用句号，喜欢分几条短消息发，偶尔用～。"
                    value={speakingStyleDraft.punctuationStyle}
                    onChange={(value) => updateSpeakingStyleDraft('punctuationStyle', value)}
                  />
                  <SpeakingStyleField
                    label="常聊话题"
                    description="每行一个话题。"
                    placeholder={'工作近况\n吃饭\n游戏\n朋友八卦'}
                    value={speakingStyleDraft.topics}
                    onChange={(value) => updateSpeakingStyleDraft('topics', value)}
                  />
                </section>

                <section className="space-y-3">
                  <div>
                    <h3 className="m-0 text-sm font-semibold text-foreground">语音回复</h3>
                    <p className="m-0 mt-1 text-xs text-muted">只影响分身发语音时的朗读风格。</p>
                  </div>
                  <SpeakingStyleField
                    label="朗读风格"
                    description="有专属音色或 TTS 可用时生效。"
                    minRows={4}
                    placeholder="例如：语速偏快，语气放松，像随口说话，不要播音腔。"
                    value={speakingStyleDraft.ttsInstructions}
                    onChange={(value) => updateSpeakingStyleDraft('ttsInstructions', value)}
                  />
                </section>
                {speakingStyleError && (
                  <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
                    <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
                    <span>{speakingStyleError}</span>
                  </div>
                )}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={speakingStyleSaving}>取消</Button>
              <Button variant="primary" isPending={speakingStyleSaving} onPress={() => void handleSaveSpeakingStyle()}>保存</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {/* 消息区 */}
      <ScrollShadow
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pt-5 pb-52 sm:px-4"
        onLoadCapture={handleMessageMediaLoad}
        onScroll={handleMessageScroll}
      >
        {messages.length === 0 && pendingTexts.length === 0 && !busy && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
            <FaceRobot width={40} height={40} />
            <p className="text-base">和「{displayName}」的分身打个招呼吧</p>
          </div>
        )}
        {hiddenMessageCount > 0 && (
          <div className="flex justify-center py-1">
            <Button size="sm" variant="tertiary" onPress={loadOlderMessages}>
              加载更早消息（还有 {hiddenMessageCount} 条）
            </Button>
          </div>
        )}
        {visibleMessages.map((message) => {
          const rawBubbles = messageTextParts(message).map((part) => part.trim()).filter(Boolean)
          const fileParts = messageFileParts(message)
          if (rawBubbles.length === 0 && fileParts.length === 0) return null
          const bubbles = rawBubbles.map(parseBubble)
          const isMine = message.role === 'user'
          return (
            <div key={message.id} className={`flex w-full gap-2 ${isMine ? 'justify-end' : 'justify-start'}`}>
              {!isMine && <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={38} />}
              <div className={`flex max-w-[76%] flex-col gap-1.5 ${isMine ? 'items-end' : 'items-start'}`}>
                {fileParts.map((file, index) => (
                  <PersonaMessageAttachment key={`${message.id}:file:${index}`} file={file} isMine={isMine} />
                ))}
                {bubbles.map((bubble, index) => {
                  const bubbleKey = `${message.id}:${index}`
                  if (bubble.sticker) {
                    return <PersonaStickerBubble key={bubbleKey} sticker={bubble.sticker} />
                  }
                  if (bubble.isVoice && !isMine) {
                    const active = speakingKey === bubbleKey
                    const loading = active && speakingState?.phase === 'loading'
                    const playing = active && speakingState?.phase === 'playing'
                    const unplayed = !playedVoice.has(bubbleKey)
                    return (
                      <div key={bubbleKey} className="flex items-center gap-1.5">
                        <button
                          aria-label={active ? '停止播放语音' : `播放语音，约 ${bubble.seconds} 秒`}
                          className={`flex cursor-pointer items-center rounded-2xl rounded-tl-sm border-0 bg-surface px-4 py-3 text-base text-foreground transition-colors hover:bg-surface/80 ${loading ? 'animate-pulse' : ''} ${playing ? 'ring-1 ring-accent/40' : ''}`}
                          onClick={() => { void handlePlayVoice(message.id, bubbles, index) }}
                          style={{ width: Math.min(260, 108 + bubble.seconds * 4) }}
                          type="button"
                        >
                          <VoiceWaves loading={loading} playing={playing} />
                          <span className="ml-auto text-xs text-muted">{loading ? '...' : `${bubble.seconds}″`}</span>
                        </button>
                        {unplayed && <span aria-label="未播放" className="size-2 shrink-0 rounded-full bg-red-500" />}
                        {revealedVoice.has(bubbleKey) && (
                          <span className="max-w-50 text-xs text-muted">{bubble.text}</span>
                        )}
                      </div>
                    )
                  }
                  return (
                    <div
                      key={bubbleKey}
                      className={`whitespace-pre-wrap wrap-break-word rounded-2xl px-4 py-2.5 text-base leading-7 ${
                        isMine
                          ? 'rounded-tr-sm bg-success-soft text-success-soft-foreground'
                          : 'rounded-tl-sm bg-surface text-foreground'
                      }`}
                    >
                      {parseWechatEmoji(bubble.text)}
                    </div>
                  )
                })}
                {!isMine && (
                  <PersonaMessageUsageLine metadata={message.metadata} />
                )}
              </div>
              {isMine && <PersonaAvatar name="我" avatarUrl={myAvatarUrl} size={38} />}
            </div>
          )
        })}
        {/* 待发缓冲气泡：已显示但还没交给 AI（等用户把话说完） */}
        {pendingTexts.length > 0 && (
          <div className="flex w-full justify-end gap-2">
            <div className="flex max-w-[76%] flex-col items-end gap-1.5">
              {pendingTexts.map((bubble, index) => (
                <div
                  key={`pending:${index}`}
                  className="whitespace-pre-wrap wrap-break-word rounded-2xl rounded-tr-sm bg-success-soft px-4 py-2.5 text-base leading-7 text-success-soft-foreground"
                >
                  {parseWechatEmoji(bubble)}
                </div>
              ))}
            </div>
            <PersonaAvatar name="我" avatarUrl={myAvatarUrl} size={38} />
          </div>
        )}
        {showTypingIndicator && (
          <div className="flex w-full items-start justify-start gap-2">
            <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={38} />
            <span className="inline-flex gap-1 rounded-2xl rounded-tl-sm bg-surface px-4 py-3">
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:0ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:150ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:300ms]" />
            </span>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
            <CircleExclamation width={16} height={16} className="mt-0.5 shrink-0" />
            <span>{error.message || '生成失败，请重试'}</span>
          </div>
        )}
      </ScrollShadow>

      {/* 输入栏 */}
      <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-56">
        <div className="absolute right-0 bottom-4 left-0 grid place-items-center px-3 sm:px-4">
        <div className="pointer-events-auto w-full max-w-none">
          <PromptInput
            accept="image/*"
            className="persona-prompt-input w-full **:data-[slot=input-group]:border-border **:data-[slot=input-group]:bg-surface/55 **:data-[slot=input-group]:shadow-lg"
            maxFiles={6}
            maxFileSize={8 * 1024 * 1024}
            multiple
            onSubmit={handlePromptSubmit}
          >
            <PromptInputHeader className="flex-col items-stretch gap-1.5 px-3 pt-2 pb-0">
              <PromptInputAttachments className="p-0">
                {(attachment) => <PromptInputAttachment data={attachment} />}
              </PromptInputAttachments>
            </PromptInputHeader>
            <PromptInputBody>
              <PromptInputTextarea
                className="min-h-13 pt-3 pb-2 text-base"
                placeholder={`给「${displayName}」发消息，Enter 发送，Shift + Enter 换行…`}
                onChange={(event) => {
                  inputValueRef.current = event.currentTarget.value
                }}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger aria-label="添加图片" variant="tertiary" />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments label="添加图片" />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                {/* 按住说话：按下录音、松开转写并发送；用复刻音色回复 */}
                <button
                  type="button"
                  aria-label={voiceInput === 'recording' ? '松开发送' : '按住说话'}
                  disabled={busy || voiceInput === 'transcribing'}
                  onPointerDown={(event) => { event.preventDefault(); void startVoiceInput() }}
                  onPointerUp={() => void finishVoiceInput(true)}
                  onPointerLeave={() => { if (voiceInput === 'recording') void finishVoiceInput(true) }}
                  onPointerCancel={() => void finishVoiceInput(false)}
                  className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface/60 disabled:opacity-40',
                    voiceInput === 'recording' && 'bg-danger/15 text-danger',
                    voiceInput === 'transcribing' && 'text-primary',
                  )}
                >
                  {voiceInput === 'transcribing'
                    ? <CircleDashed width={18} height={18} className="animate-spin" />
                    : <Microphone width={18} height={18} />}
                </button>
                {/* 语音通话：打电话式，常开麦自动断句 */}
                <button
                  type="button"
                  aria-label="语音通话"
                  disabled={busy || voiceInput !== 'idle'}
                  onClick={() => void startCall()}
                  className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface/60 disabled:opacity-40"
                >
                  <Smartphone width={18} height={18} />
                </button>
              </PromptInputTools>
              <PromptInputSubmit status={busy ? 'streaming' : undefined} />
            </PromptInputFooter>
          </PromptInput>
        </div>
        </div>
      </div>

      {/* 语音通话浮层（打电话式：常开麦 + VAD 自动断句） */}
      {callActive && (() => {
        const meta = {
          connecting: { label: '接通中…', icon: <CircleDashed width={16} height={16} className="animate-spin" /> },
          listening: { label: '请说，聆听中…', icon: <Microphone width={16} height={16} className="text-danger" /> },
          recognizing: { label: '识别中…', icon: <CircleDashed width={16} height={16} className="animate-spin" /> },
          thinking: { label: '对方正在想…', icon: <CircleDashed width={16} height={16} className="animate-spin" /> },
          speaking: { label: '对方说话中…', icon: <Volume width={16} height={16} className="text-accent" /> },
        }[callPhase]
        return (
          <div className="absolute inset-0 z-50 grid place-items-center bg-black/55 backdrop-blur-sm">
            <div className="flex w-72 flex-col items-center gap-5 rounded-3xl bg-surface/90 px-6 py-8 shadow-2xl">
              <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={88} />
              <div className="text-lg font-semibold text-foreground">{displayName || sessionId}</div>
              <div className="flex items-center gap-2 text-sm text-muted">{meta.icon}<span>{meta.label}</span></div>
              <button
                type="button"
                onClick={endCall}
                aria-label="挂断"
                className="mt-1 grid size-14 place-items-center rounded-full bg-danger text-white shadow-lg transition-colors hover:bg-danger/90"
              >
                <CircleXmarkFill width={26} height={26} />
              </button>
            </div>
          </div>
        )
      })()}

      {/* 删除分身画像确认 */}
      <AlertDialog.Backdrop
        isOpen={confirmAction === 'deletePersona'}
        onOpenChange={(open) => { if (!open) setConfirmAction(null) }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除「{displayName || sessionId}」的分身？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-muted">
                画像、真实问答索引和导演笔记都会删除，需要时可重新克隆。对话记录会保留。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">取消</Button>
              <Button slot="close" variant="danger" onPress={() => void handleDelete()}>删除分身</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      {/* 删除对话记录确认 */}
      <AlertDialog.Backdrop
        isOpen={confirmAction === 'clearConversations'}
        onOpenChange={(open) => { if (!open) setConfirmAction(null) }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除所有对话记录？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-muted">
                和「{displayName || sessionId}」分身的全部对话记录将被删除，画像会保留。此操作不可撤销。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">取消</Button>
              <Button slot="close" variant="danger" onPress={() => void handleClearConversations()}>删除记录</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      {/* 删除单条历史对话确认 */}
      <AlertDialog.Backdrop
        isOpen={recordPendingDelete !== null}
        onOpenChange={(open) => { if (!open) setRecordPendingDelete(null) }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除这条对话记录？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-muted">
                「{recordPendingDelete?.title}」将被删除，此操作不可撤销。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">取消</Button>
              <Button
                slot="close"
                variant="danger"
                onPress={() => { const record = recordPendingDelete; if (record) void handleDeleteRecord(record) }}
              >
                删除记录
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

    </div>
  )
}

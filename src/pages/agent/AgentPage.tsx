/**
 * AI Agent 对话页（Phase C）——使用 AI SDK 的 useChat + AI Elements 组件。
 * 数据：useChat 走 IpcChatTransport（IPC → AI 子进程 → 流式 UIMessageChunk）。
 * 提示词预设、记忆引导、@提及、消息渲染小组件等已拆到同目录下的多个文件，这里只保留主组件本身。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { useChat } from '@ai-sdk/react'
import { isToolUIPart, type UIMessage } from 'ai'
import { AlertDialog, Button as HeroButton, ButtonGroup, Dropdown, Header, Label, Modal, SearchField, Separator, Spinner, Surface, Switch, Toolbar, Tooltip, toast } from '@heroui/react'
import { ArrowDownToLine, ArrowUpRightFromSquare, Bulb, Check, ChevronDown, CircleInfo, Clock, Display, Globe, LayoutSideContentLeft, ListCheck, PencilToLine, PencilToSquare, Terminal, TrashBin, Xmark } from '@gravity-ui/icons'
import { toPng } from 'dom-to-image-more'
import {
  Conversation,
  ConversationAutoScroll,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
  type PromptInputMessage,
  type PromptInputControllerProps,
} from '@/components/ai-elements/prompt-input'
import { ImagePreview, type ImagePreviewOriginRect } from '@/components/ImagePreview'
import AIProviderLogo from '@/components/ai/AIProviderLogo'
import { getAIProviders, type AIModelInfo, type AIProviderInfo } from '@/types/ai'
import { Loader } from '@/components/ai-elements/loader'
import { IpcChatTransport, type AgentModelConfig, type AgentProgressEvent, type AgentReasoningEffort, type AgentScope, type AgentToolProfile, type CodeWorkspaceRef } from '@/features/aiagent/transport/ipcChatTransport'
import { CODE_WORKSPACE_FILE_REF_MIME, CodeWorkspacePanel, CodeWorkspacePanelPopover, CodeWorkspaceSidebar, type CodeWorkspaceFileDragReference, type CodeWorkspacePanelTab } from './CodeWorkspacePanel'
import * as configService from '@/services/config'
import { useTtsSpeaker } from '@/lib/ttsPlayer'
import type { CodeWorkspaceApprovalPolicy, CodeWorkspaceApprovalRequest, CodeWorkspaceEvent, CodeWorkspaceState } from '@/types/electron'
import { REASONING_EFFORT_OPTIONS, reasoningEffortLabel } from './agentPromptPresets'
import {
  AgentPromptPrimaryAction,
  CodeWorkspaceApprovalPolicyDropdown,
  PromptInputControllerBridge,
  PromptPresetButton,
  SlashCommandButton,
  type SlashCommandItem,
} from './AgentPromptToolbar'
import { AgentMemoryIntro, type AgentMemoryIntroStatus } from './AgentMemoryIntro'
import {
  AgentPromptAssetHeader,
  MENTION_SESSION_PAGE_SIZE,
  MentionField,
  MentionTriggerButton,
  buildWorkspaceFilePrefix,
  displayBasename,
  hasWorkspaceFileDrag,
  parseWorkspaceFileDragPayload,
  toMentionTarget,
  type MentionTarget,
} from './AgentMentions'
import { extractSources, getPersonaControlOutput, toolProgressKey } from './agentMessageHelpers'
import { createLiquidGlassMap, type GlassFilterMap } from '@/utils/liquidGlass'
import {
  buildFallbackConversationTitle,
  finiteNumber,
  modelConfigId,
  modelConfigProvider,
  normalizeConversationRecord,
  normalizeLoadedConversation,
  NEW_AGENT_CONVERSATION_MARKER,
  parseAgentMessageMetadata,
  prepareAgentMessagesForPersist,
  presetMatchesCurrentConfig,
  readStoredActiveAgentConversation,
  readToolElapsedFromMessage,
  resolveDefaultPresetId,
  signatureAgentMessages,
  storeActiveAgentConversation,
  STREAMING_AGENT_SAVE_INTERVAL_MS,
  type AgentConversationLoaded,
  type AgentConversationRecord,
  type AgentMessageMetadata,
} from './agentConversationHelpers'
import { UsageDetailsModal, formatTokenCount } from './AgentUsageStats'
import { AgentShareCard, buildAgentSharePreviewData, formatAgentShareFileDate, sanitizeAgentShareFileName, type AgentSharePreviewData } from './AgentShareCard'
import { AGENT_PENDING_TITLE, ModelWaitingLine, SubAgentProgressPanel, mergeSubAgentProgress, shouldDisplayAgentProgress } from './AgentSubAgentProgress'
import { ModelItem, type AgentModelItem } from './AgentMessageBlocks'
import { AgentMessageItem } from './AgentMessageItem'
import { AgentRecordsMenu } from './AgentRecordsMenu'

// 没有图片/文件附件时给输入框更高的最小高度，避免空状态输入框过矮。
function AgentPromptTextarea({ workspaceReferenceCount }: { workspaceReferenceCount: number }) {
  const { attachments } = usePromptInputController()
  const hasAssets = attachments.files.length > 0 || workspaceReferenceCount > 0
  return (
    <PromptInputTextarea
      className={hasAssets ? 'min-h-10 max-h-40 py-2 text-sm leading-5' : 'min-h-14 max-h-40 py-2 text-sm leading-5'}
      placeholder="问问你的聊天记录，Enter 发送，Shift + Enter 换行…"
    />
  )
}

// 滚动到底部按钮的液态玻璃折射滤镜：圆形按钮 36px，复用朋友圈图标的位移贴图参数。
// 贴图生成完成后 onReady 触发 .agent-glass-ready，CSS 再叠加 url(#agent-glass-36) 折射。
const AGENT_SCROLL_GLASS_SIZE = 36
const GLASS_CIRCLE = { halfX: 0.18, halfY: 0.18, radius: 0.18, edge: 0.02, feather: 0.35, strength: 3 }

function AgentGlassDefs({ onReady }: { onReady: () => void }) {
  const [map, setMap] = useState<GlassFilterMap | null>(null)
  useEffect(() => {
    const m = createLiquidGlassMap(AGENT_SCROLL_GLASS_SIZE, AGENT_SCROLL_GLASS_SIZE, GLASS_CIRCLE)
    if (m) {
      setMap(m)
      onReady()
    }
  }, [onReady])
  if (!map) return null
  return (
    <svg className="agent-glass-defs" aria-hidden="true" focusable="false">
      <filter
        id="agent-glass-36"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
        width={map.width}
        height={map.height}
        x="0"
        y="0"
      >
        <feImage href={map.href} xlinkHref={map.href} width={map.width} height={map.height} result="displacementMap" />
        <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={map.scale} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  )
}

export default function AgentPage() {
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [providersInfo, setProvidersInfo] = useState<AIProviderInfo[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('current')
  const [reasoningEffort, setReasoningEffort] = useState<AgentReasoningEffort>('auto')
  const [generatedImagePreview, setGeneratedImagePreview] = useState<{ src: string; originRect?: ImagePreviewOriginRect } | null>(null)
  // 滚动到底部按钮液态玻璃：位移贴图就绪后给根容器加 .agent-glass-ready
  const [agentGlassReady, setAgentGlassReady] = useState(false)
  const handleAgentGlassReady = useCallback(() => setAgentGlassReady(true), [])
  // 计划模式：开启后本轮只出执行计划、不下结论，等用户点"开始执行"再跑（参考 ClaudeCode/Codex）
  const [planMode, setPlanMode] = useState(false)
  const planModeRef = useRef(planMode)
  planModeRef.current = planMode
  // 标记当前在途的这次运行是否为计划模式（finish 前 metadata 还没回来，流式期间靠它判定计划卡片）
  const runIsPlanRef = useRef(false)
  // 联网搜索（Tavily）：全局开关，存在 config，模型自己决定何时联网；+ 菜单里快捷开关
  const [webSearchOn, setWebSearchOn] = useState(false)
  const [webSearchHasKey, setWebSearchHasKey] = useState(false)
  useEffect(() => {
    void window.electronAPI.webSearch?.getConfig().then((res) => {
      if (res.success && res.config) {
        const cfg = res.config as { enabled?: boolean; apiKey?: string }
        setWebSearchOn(Boolean(cfg.enabled))
        setWebSearchHasKey(Boolean(cfg.apiKey))
      }
    })
  }, [])
  const toggleWebSearch = useCallback(async () => {
    const next = !webSearchOn
    if (next) {
      // 重新读一遍配置，避免本次会话内刚在设置里填了 key 但缓存还是“无 key”
      const res = await window.electronAPI.webSearch?.getConfig()
      const hasKey = res?.success ? Boolean((res.config as { apiKey?: string } | undefined)?.apiKey) : webSearchHasKey
      setWebSearchHasKey(hasKey)
      if (!hasKey) {
        setAgentNotice('请先在 设置 → AI 接入 → 联网 里填写 Tavily API Key，再开启联网搜索。')
        return
      }
    }
    setWebSearchOn(next)
    void window.electronAPI.webSearch?.setConfig({ enabled: next })
  }, [webSearchOn, webSearchHasKey])
  const [codeWorkspaceState, setCodeWorkspaceState] = useState<CodeWorkspaceState | null>(null)
  const [codeWorkspaceApproval, setCodeWorkspaceApproval] = useState<CodeWorkspaceApprovalRequest | null>(null)
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(false)
  const [codeWorkspacePanelOpen, setCodeWorkspacePanelOpen] = useState(false)
  const [codeWorkspacePanelTab, setCodeWorkspacePanelTab] = useState<CodeWorkspacePanelTab>('preview')
  const [codeWorkspaceLogs, setCodeWorkspaceLogs] = useState<string[]>([])
  const codeWorkspaceRef = useRef<CodeWorkspaceRef | null>(null)
  codeWorkspaceRef.current = codeWorkspaceState?.workspace ?? null
  const handleSelectCodeWorkspace = useCallback(async () => {
    const result = await window.electronAPI.agentWorkspace.selectWorkspace()
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
      setAgentNotice('')
    } else if (!result.canceled) {
      setAgentNotice(`代码工作区选择失败：${result.error || '未知错误'}`)
    }
  }, [])
  const handleCodeWorkspaceApprovalPolicyChange = useCallback(async (policy: CodeWorkspaceApprovalPolicy) => {
    const result = await window.electronAPI.agentWorkspace.setApprovalPolicy(policy)
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
      setAgentNotice('')
    } else {
      setAgentNotice(`代码权限设置失败：${result.error || '未知错误'}`)
    }
  }, [])
  const handleApproveCodeWorkspace = useCallback((requestId: string) => {
    setCodeWorkspaceApproval(null)
    void window.electronAPI.agentWorkspace.approve(requestId)
  }, [])
  const handleRejectCodeWorkspace = useCallback((requestId: string) => {
    setCodeWorkspaceApproval(null)
    void window.electronAPI.agentWorkspace.reject(requestId)
  }, [])
  const handleStopCodeDevServer = useCallback(async () => {
    const result = await window.electronAPI.agentWorkspace.stopDevServer()
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
    } else if (!result.success) {
      setAgentNotice(`停止开发服务器失败：${result.error || '未知错误'}`)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.agentWorkspace.getState().then((result) => {
      if (cancelled || !result.success || !result.state) return
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
    })
    const offApproval = window.electronAPI.agentWorkspace.onApprovalRequest((request) => {
      setCodeWorkspaceApproval(request)
    })
    const offEvent = window.electronAPI.agentWorkspace.onWorkspaceEvent((event: CodeWorkspaceEvent) => {
      if (event.state) {
        setCodeWorkspaceState(event.state)
        setCodeWorkspaceLogs(event.state.recentLogs || [])
      }
      if (event.log) {
        setCodeWorkspaceLogs((prev) => [...prev, event.log!].slice(-600))
      }
      if (event.type === 'preview-url') {
        setCodeWorkspacePanelTab('preview')
      }
      if (event.type === 'approval-resolved' && event.requestId) {
        setCodeWorkspaceApproval((current) => current?.requestId === event.requestId ? null : current)
      }
    })
    return () => {
      cancelled = true
      offApproval()
      offEvent()
    }
  }, [])
  const [currentProviderId, setCurrentProviderId] = useState('')
  const [currentModelId, setCurrentModelId] = useState('')
  const [currentProviderConfig, setCurrentProviderConfig] = useState<configService.AiProviderConfig | null>(null)
  const [toolElapsedByKey, setToolElapsedByKey] = useState<Record<string, number>>({})
  const [agentProgress, setAgentProgress] = useState<AgentProgressEvent[]>([])
  const [agentRunPending, setAgentRunPending] = useState(false)
  const [subAgentProgress, setSubAgentProgress] = useState<AgentProgressEvent[]>([])
  const toolElapsedByKeyRef = useRef(toolElapsedByKey)
  toolElapsedByKeyRef.current = toolElapsedByKey
  const subAgentProgressRef = useRef(subAgentProgress)
  subAgentProgressRef.current = subAgentProgress
  const [agentNotice, setAgentNotice] = useState('')
  const [usageDetailsModal, setUsageDetailsModal] = useState<AgentMessageMetadata | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const { speakingKey: speakingMessageId, speak: speakMessage, stop: stopSpeakingMessage } = useTtsSpeaker()
  const promptInputControllerRef = useRef<PromptInputControllerProps | null>(null)
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) || null,
    [presets, selectedPresetId]
  )
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
  const models = useMemo<AgentModelItem[]>(() => {
    const list = presets.map((preset) => ({
      chef: preset.provider || '其他',
      chefSlug: preset.provider || '',
      id: preset.id,
      name: preset.name,
      modelDetail: modelInfoByKey.get(`${preset.provider}::${preset.model}`) || modelInfoByKey.get(preset.model),
      disabled: (() => {
        const detail = modelInfoByKey.get(`${preset.provider}::${preset.model}`) || modelInfoByKey.get(preset.model)
        return detail ? !detail.capabilities.toolCall : false
      })(),
    }))
    if (presets.some((preset) => presetMatchesCurrentConfig(preset, currentProviderId, currentProviderConfig))) {
      return list
    }
    if (!currentProviderId && !currentModelId) return list
    const currentDetail = modelInfoByKey.get(`${currentProviderId}::${currentModelId}`) || modelInfoByKey.get(currentModelId)
    return [{
      chef: currentProviderId || 'custom',
      chefSlug: currentProviderId,
      id: 'current',
      name: currentModelId ? `当前配置 · ${currentModelId}` : '当前配置',
      modelDetail: currentDetail,
      disabled: currentDetail ? !currentDetail.capabilities.toolCall : false,
    }, ...list]
  }, [currentModelId, currentProviderConfig, currentProviderId, presets, modelInfoByKey])
  const chefs = useMemo(() => [...new Set(models.map((model) => model.chef))], [models])
  const disabledModelKeys = useMemo(() => models.filter((model) => model.disabled).map((model) => model.id), [models])
  const selectedModelKeys = useMemo(() => new Set([selectedPresetId]), [selectedPresetId])
  const selectedModelData = models.find((model) => model.id === selectedPresetId)
  const selectedModelSupportsTools = selectedModelData?.modelDetail
    ? selectedModelData.modelDetail.capabilities.toolCall
    : true
  useEffect(() => {
    const selected = models.find((model) => model.id === selectedPresetId)
    if (!selected?.disabled) return
    const fallback = models.find((model) => !model.disabled)
    if (fallback) setSelectedPresetId(fallback.id)
  }, [models, selectedPresetId])
  const selectedModelConfig = useMemo<AgentModelConfig | null>(() => {
    if (!selectedPreset) return { reasoningEffort }
    return {
      provider: selectedPreset.provider,
      apiKey: selectedPreset.apiKey,
      model: selectedPreset.model,
      baseURL: selectedPreset.baseURL,
      protocol: selectedPreset.protocol,
      reasoningEffort,
    }
  }, [selectedPreset, reasoningEffort])
  const selectedModelConfigRef = useRef<AgentModelConfig | null>(null)
  selectedModelConfigRef.current = selectedModelConfig

  // @ 提及：会话列表（选择源）+ 已选对象
  const [sessions, setSessions] = useState<MentionTarget[]>([])
  const [mentionHasMore, setMentionHasMore] = useState(true)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentions, setMentions] = useState<MentionTarget[]>([])
  const [workspaceFileReferences, setWorkspaceFileReferences] = useState<CodeWorkspaceFileDragReference[]>([])
  const [workspaceFileDragOver, setWorkspaceFileDragOver] = useState(false)
  const [sourceNameById, setSourceNameById] = useState<Record<string, string>>({})
  const mentionOffsetRef = useRef(0)
  const mentionLoadingRef = useRef(false)
  const mentionHasMoreRef = useRef(true)
  const mentionConnectedRef = useRef(false)
  const mentionSeenRef = useRef(new Set<string>())
  const mentionSearchSeqRef = useRef(0)
  const addMention = useCallback(
    (m: MentionTarget) => setMentions((prev) => (prev.some((x) => x.username === m.username) ? prev : [...prev, m])),
    []
  )
  const removeMention = useCallback((m: MentionTarget) => {
    setMentions((prev) => prev.filter((item) => item.username !== m.username))
  }, [])
  const addWorkspaceFileReference = useCallback((ref: CodeWorkspaceFileDragReference) => {
    setWorkspaceFileReferences((prev) => (prev.some((item) => item.path === ref.path) ? prev : [...prev, ref]))
  }, [])
  const removeWorkspaceFileReference = useCallback((path: string) => {
    setWorkspaceFileReferences((prev) => prev.filter((item) => item.path !== path))
  }, [])
  useEffect(() => {
    setWorkspaceFileReferences([])
    setWorkspaceFileDragOver(false)
  }, [codeWorkspaceState?.workspace?.id])
  const handleWorkspaceFileDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setWorkspaceFileDragOver(true)
  }, [])
  const handleWorkspaceFileDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget && event.currentTarget.contains(nextTarget)) return
    setWorkspaceFileDragOver(false)
  }, [])
  const handleWorkspaceFileDrop = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    event.preventDefault()
    setWorkspaceFileDragOver(false)
    const ref = parseWorkspaceFileDragPayload(event.dataTransfer.getData(CODE_WORKSPACE_FILE_REF_MIME))
    if (ref) addWorkspaceFileReference(ref)
  }, [addWorkspaceFileReference])
  const processedPersonaActionsRef = useRef(new Set<string>())
  // 单个 @ → 锁定该会话 scope；多个/零个 → 全局（多个走消息注入，见 handleSubmit）
  const scopeRef = useRef<AgentScope>({ kind: 'global' })
  const submitScopeRef = useRef<AgentScope | null>(null)
  const activeScopeRef = useRef<AgentScope>({ kind: 'global' })
  scopeRef.current =
    mentions.length === 1
      ? { kind: 'session', sessionId: mentions[0].username, displayName: mentions[0].displayName }
      : { kind: 'global' }

  const handleAgentProgress = useCallback((progress: AgentProgressEvent) => {
    const displayProgress = shouldDisplayAgentProgress(progress)
    // 准备阶段的 run_started 步骤只进执行过程链，不推桌宠气泡。
    const petWorthy = progress.stage !== 'run_started'
    if ((progress.depth ?? 0) === 0 && petWorthy && (displayProgress || progress.stage === 'run_finished' || progress.stage === 'error')) {
      window.electronAPI.pet.sendAgentProgress({
        stage: progress.stage,
        title: progress.stage === 'run_finished' && !displayProgress ? 'AI 助手已完成' : progress.title,
        detail: progress.detail,
      })
    }
    if ((progress.depth ?? 0) > 0) {
      if (displayProgress) setSubAgentProgress((prev) => mergeSubAgentProgress(prev, progress))
    } else {
      if (displayProgress) {
        setAgentProgress((prev) => {
          const withoutLocalPending = prev.filter((item) => item.title !== AGENT_PENDING_TITLE)
          return mergeSubAgentProgress(withoutLocalPending, progress)
        })
      }
      if (progress.stage === 'run_started') {
        setSubAgentProgress([])
      } else if (progress.stage === 'run_finished' || progress.stage === 'error') {
        setAgentRunPending(false)
      }
    }

    if (progress.stage === 'tool_finished' && progress.toolName && progress.elapsedMs) {
      setToolElapsedByKey((prev) => ({
        ...prev,
        [toolProgressKey(progress.toolName!, progress.toolCallId)]: progress.elapsedMs!,
      }))
    }
  }, [])

  const handleCopyAssistantMessage = useCallback(async (messageId: string, text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(text)
    setCopiedMessageId(messageId)
    window.setTimeout(() => {
      setCopiedMessageId((current) => current === messageId ? null : current)
    }, 1600)
  }, [])

  const handleCopyUserMessage = useCallback(async (messageId: string, text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(text)
    setCopiedMessageId(messageId)
    window.setTimeout(() => {
      setCopiedMessageId((current) => current === messageId ? null : current)
    }, 1600)
  }, [])

  const handleSpeakAssistantMessage = useCallback((messageId: string, text: string) => {
    if (!text) return
    void speakMessage(messageId, text)
  }, [speakMessage])

  useEffect(() => {
    return () => { stopSpeakingMessage() }
  }, [stopSpeakingMessage])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const applyConversationId = useCallback((nextId: number | null) => {
    const normalized = nextId && nextId > 0 ? nextId : null
    setConversationId(normalized)
    conversationIdRef.current = normalized
    storeActiveAgentConversation(normalized)
  }, [])
  const transport = useMemo(
    () => new IpcChatTransport(
      () => submitScopeRef.current ?? scopeRef.current,
      () => selectedModelConfigRef.current,
      () => conversationIdRef.current,
      handleAgentProgress,
      () => planModeRef.current,
      () => (codeWorkspaceRef.current ? 'hybrid' : 'chat') as AgentToolProfile,
      () => codeWorkspaceRef.current,
    ),
    [handleAgentProgress]
  )
  // 流式 chunk 合并到每 50ms 更新一次 UI，避免 token 级高频重渲染拖卡滚动
  const { messages, sendMessage, regenerate, setMessages, status, stop } = useChat({
    transport,
    experimental_throttle: 50,
    // 主进程/子进程侧的请求失败（限流、参数不支持等）此前只进日志，聊天区什么都不显示，用户分不清是没回应还是报错了
    onError: (error) => setAgentNotice(error instanceof Error ? error.message : String(error)),
  })
  const messagesRef = useRef<UIMessage[]>(messages)
  messagesRef.current = messages
  const lastSavedMessagesRef = useRef('')
  const streamingSaveTimerRef = useRef<number | null>(null)
  const lastStreamingSaveAtRef = useRef(0)
  const [modelOpen, setModelOpen] = useState(false)
  const busy = status === 'submitted' || status === 'streaming'
  const [memoryIntroStatus, setMemoryIntroStatus] = useState<AgentMemoryIntroStatus>('checking')
  const markMemoryIntroSatisfied = useCallback(() => {
    setMemoryIntroStatus('hidden')
  }, [])
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.memory.list({
      sourceTypes: ['profile', 'fact', 'relationship'],
      limit: 1,
    })
      .then((res) => {
        if (cancelled) return
        const hasUserMemory = res.success && Array.isArray(res.items) && res.items.length > 0
        setMemoryIntroStatus(hasUserMemory ? 'hidden' : 'needed')
      })
      .catch(() => {
        if (!cancelled) setMemoryIntroStatus('hidden')
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!busy && !agentRunPending) return
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (let index = 0; index < message.parts.length; index += 1) {
        const output = getPersonaControlOutput(message.parts[index])
        if (!output?.success || !output.action || !output.sessionId) continue
        const key = `${message.id}:${index}:${output.action}:${output.sessionId}`
        if (processedPersonaActionsRef.current.has(key)) continue
        processedPersonaActionsRef.current.add(key)

        const displayName = output.displayName || output.sessionId
        if (output.action === 'open_persona_chat') {
          setAgentNotice(`正在打开「${displayName}」的数字分身...`)
          void window.electronAPI.window.openPersonaChatWindow(output.sessionId)
            .then(() => setAgentNotice(`已打开「${displayName}」的数字分身。`))
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '打开数字分身失败'))
          continue
        }

        if (output.action === 'build_session_vectors') {
          setAgentNotice(`正在为「${displayName}」建立语义索引...`)
          void window.electronAPI.embedding.buildSession(output.sessionId)
            .then((result) => {
              setAgentNotice(result.success
                ? `「${displayName}」的语义索引已建立。`
                : `语义索引建立失败：${result.error || '未知错误'}`)
            })
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '语义索引建立失败'))
          continue
        }

        if (output.action === 'build_persona') {
          setAgentNotice(`正在克隆「${displayName}」的数字分身...`)
          void window.electronAPI.persona.build({ sessionId: output.sessionId, displayName })
            .then((result) => {
              setAgentNotice(result.success
                ? `「${displayName}」的数字分身已创建成功。请重新说「打开${displayName}数字分身」进入对话。`
                : `数字分身克隆失败：${result.error || '未知错误'}`)
            })
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '数字分身克隆失败'))
        }
      }
    }
  }, [agentRunPending, busy, messages])
  // 模型空窗期：流已建立（status=streaming）但助手消息还没有任何可见输出（最多只有 step-start），
  // 即"模型首 token 还没到"——这段最长可达十几秒，用轮播文案兜住
  const lastMessageForWait = messages[messages.length - 1]
  const waitingFirstModelOutput = busy && (
    !lastMessageForWait
    || lastMessageForWait.role === 'user'
    || (lastMessageForWait.role === 'assistant' && !lastMessageForWait.parts.some((part) => part.type !== 'step-start'))
  )
  const latestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i].id
    }
    return ''
  }, [messages])
  const shouldAnchorLatestUser = busy && !!latestUserMessageId
  const lastAssistantMessageHasDelegateTool = useMemo(() => {
    const last = messages[messages.length - 1]
    return !!last && last.role === 'assistant' && last.parts.some((part) => (
      isToolUIPart(part) && part.type.replace(/^tool-/, '') === 'delegate_analysis'
    ))
  }, [messages])
  // 本次会话累计 token 用量（各助手消息 usage 求和），供输入框底部展示
  const conversationUsage = useMemo(() => {
    let input = 0
    let output = 0
    let hasAny = false
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const usage = parseAgentMessageMetadata(message.metadata)?.usage
      if (!usage) continue
      hasAny = true
      input += finiteNumber(usage.inputTokens) ?? 0
      output += finiteNumber(usage.outputTokens) ?? 0
    }
    return { input, output, total: input + output, hasAny }
  }, [messages])
  const [conversationTitle, setConversationTitle] = useState('新对话')
  const [titleLoading, setTitleLoading] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleCommitInFlightRef = useRef(false)
  const titleIgnoreBlurRef = useRef(false)
  const titleRequestSeqRef = useRef(0)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [conversationRecords, setConversationRecords] = useState<AgentConversationRecord[]>([])
  const [recordPendingDelete, setRecordPendingDelete] = useState<AgentConversationRecord | null>(null)
  const [recordDeleting, setRecordDeleting] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareSearch, setShareSearch] = useState('')
  const [shareSelectedId, setShareSelectedId] = useState<number | null>(null)
  const [sharePreviewData, setSharePreviewData] = useState<AgentSharePreviewData | null>(null)
  const [shareLoading, setShareLoading] = useState(false)
  const [shareSaving, setShareSaving] = useState(false)
  const [shareError, setShareError] = useState('')
  const shareCardRef = useRef<HTMLDivElement | null>(null)
  // Agent 运行状态 → 桌宠动作：跑→run，报错→failed，收尾→done(挥手 2.6s)。
  const petAgentState = busy ? 'running' : (agentNotice && !agentNotice.startsWith('状态：') ? 'failed' : 'idle')
  const petPrevBusyRef = useRef(false)
  useEffect(() => {
    if (petAgentState === 'idle' && petPrevBusyRef.current) {
      window.electronAPI.pet?.setAgentState('done')
      const timer = window.setTimeout(() => {
        window.electronAPI.pet?.setAgentState('idle')
      }, 2600)
      petPrevBusyRef.current = false
      return () => window.clearTimeout(timer)
    }
    petPrevBusyRef.current = petAgentState === 'running'
    window.electronAPI.pet?.setAgentState(petAgentState)
  }, [petAgentState])

  const appendMentionTargets = useCallback((items: MentionTarget[]) => {
    if (items.length === 0) return
    setSessions((prev) => {
      const next = [...prev]
      for (const item of items) {
        if (mentionSeenRef.current.has(item.username)) continue
        mentionSeenRef.current.add(item.username)
        next.push(item)
      }
      return next
    })
  }, [])

  const updateMentionHasMore = useCallback((hasMore: boolean) => {
    mentionHasMoreRef.current = hasMore
    setMentionHasMore(hasMore)
  }, [])

  const loadMentionSessions = useCallback(async () => {
    if (mentionLoadingRef.current) {
      console.info('[AgentMention][renderer] load skipped: already loading')
      return
    }
    mentionLoadingRef.current = true
    setMentionLoading(true)
    const chat = (window as any)?.electronAPI?.chat
    const offset = mentionOffsetRef.current

    console.info('[AgentMention][renderer] load start', {
      offset,
      limit: MENTION_SESSION_PAGE_SIZE,
      knownSessions: sessions.length,
      hasMore: mentionHasMoreRef.current,
      connected: mentionConnectedRef.current,
      hasChatApi: !!chat,
      hasGetMentionTargets: !!chat?.getMentionTargets,
    })

    try {
      if (!mentionConnectedRef.current) {
        try {
          const connectResult = await chat?.connect?.()
          console.info('[AgentMention][renderer] chat connect result', {
            success: connectResult?.success,
            error: connectResult?.error,
          })
        } catch (error) {
          console.warn('[AgentMention][renderer] chat connect threw', { error: String(error) })
        }
        mentionConnectedRef.current = true
      }

      const res = await chat?.getMentionTargets?.(offset, MENTION_SESSION_PAGE_SIZE)
      console.info('[AgentMention][renderer] load result', {
        success: res?.success,
        sessions: Array.isArray(res?.sessions) ? res.sessions.length : null,
        hasMore: res?.hasMore,
        error: res?.error,
      })
      if (res?.success && Array.isArray(res.sessions)) {
        appendMentionTargets(
          res.sessions
            .map((s: any) => toMentionTarget(s.username, s.displayName, s.avatarUrl))
        )
        mentionOffsetRef.current = offset + MENTION_SESSION_PAGE_SIZE
        updateMentionHasMore(!!res.hasMore)
        return
      }
      updateMentionHasMore(sessions.length === 0)
    } catch (error) {
      console.warn('[AgentMention][renderer] load threw', { error: String(error) })
      updateMentionHasMore(sessions.length === 0)
    } finally {
      mentionLoadingRef.current = false
      setMentionLoading(false)
    }
  }, [appendMentionTargets, sessions.length, updateMentionHasMore])

  const searchMentionSessions = useCallback(async (query: string) => {
    const keyword = query.trim()
    if (!keyword) return
    const seq = ++mentionSearchSeqRef.current
    const chat = (window as any)?.electronAPI?.chat
    setMentionLoading(true)
    console.info('[AgentMention][renderer] search start', {
      seq,
      keywordLength: keyword.length,
      limit: MENTION_SESSION_PAGE_SIZE,
      connected: mentionConnectedRef.current,
      hasChatApi: !!chat,
      hasGetMentionTargets: !!chat?.getMentionTargets,
    })

    try {
      if (!mentionConnectedRef.current) {
        try {
          const connectResult = await chat?.connect?.()
          console.info('[AgentMention][renderer] search connect result', {
            seq,
            success: connectResult?.success,
            error: connectResult?.error,
          })
        } catch (error) {
          console.warn('[AgentMention][renderer] search connect threw', { seq, error: String(error) })
        }
        mentionConnectedRef.current = true
      }

      const res = await chat?.getMentionTargets?.(0, MENTION_SESSION_PAGE_SIZE, keyword)
      console.info('[AgentMention][renderer] search result', {
        seq,
        latestSeq: mentionSearchSeqRef.current,
        success: res?.success,
        sessions: Array.isArray(res?.sessions) ? res.sessions.length : null,
        hasMore: res?.hasMore,
        error: res?.error,
      })
      if (seq === mentionSearchSeqRef.current && res?.success && Array.isArray(res.sessions)) {
        appendMentionTargets(
          res.sessions.map((s: any) => toMentionTarget(s.username, s.displayName, s.avatarUrl))
        )
      }
    } catch (error) {
      console.warn('[AgentMention][renderer] search threw', { seq, error: String(error) })
    } finally {
      if (seq === mentionSearchSeqRef.current) setMentionLoading(false)
    }
  }, [appendMentionTargets])

  const refreshConversationRecords = useCallback(async () => {
    const result = await window.electronAPI.agent.listConversations()
    if (!result.success || !Array.isArray(result.conversations)) return []
    const records = result.conversations
      .map(normalizeConversationRecord)
      .filter((item): item is AgentConversationRecord => !!item)
    setConversationRecords(records)
    return records
  }, [])

  const handleRecordsOpenChange = useCallback((open: boolean) => {
    setRecordsOpen(open)
    if (open) void refreshConversationRecords()
  }, [refreshConversationRecords])

  const saveConversationMessages = useCallback((
    targetId: number | null,
    nextMessages: UIMessage[],
    nextScope: AgentScope,
  ) => {
    if (!targetId || nextMessages.length === 0) return null
    const config = selectedModelConfigRef.current
    return window.electronAPI.agent.saveConversationMessages({
      id: targetId,
      messages: nextMessages,
      scope: nextScope,
      modelProvider: modelConfigProvider(config),
      modelId: modelConfigId(config),
    })
  }, [])

  const persistConversationMessages = useCallback(async (
    targetId: number | null,
    nextMessages: UIMessage[],
    nextScope: AgentScope,
  ) => {
    const result = await saveConversationMessages(targetId, nextMessages, nextScope)
    if (result?.success) void refreshConversationRecords()
  }, [refreshConversationRecords, saveConversationMessages])

  const flushConversationMessagesToStorage = useCallback((options: { refreshRecords?: boolean } = {}) => {
    const targetId = conversationIdRef.current
    const currentMessages = messagesRef.current
    if (!targetId || currentMessages.length === 0) return false

    const messagesToPersist = prepareAgentMessagesForPersist(
      currentMessages,
      subAgentProgressRef.current,
      toolElapsedByKeyRef.current,
    )
    if (messagesToPersist !== currentMessages) {
      setMessages(messagesToPersist)
      messagesRef.current = messagesToPersist
    }

    const signature = signatureAgentMessages(messagesToPersist)
    if (signature === lastSavedMessagesRef.current) return false
    lastSavedMessagesRef.current = signature

    if (options.refreshRecords) {
      void persistConversationMessages(targetId, messagesToPersist, activeScopeRef.current)
    } else {
      void saveConversationMessages(targetId, messagesToPersist, activeScopeRef.current)
    }
    return true
  }, [persistConversationMessages, saveConversationMessages, setMessages])

  const saveCurrentConversationForShare = useCallback(async (): Promise<number | null> => {
    const targetId = conversationIdRef.current
    const currentMessages = messagesRef.current
    if (!targetId || currentMessages.length === 0) return targetId

    const messagesToPersist = prepareAgentMessagesForPersist(
      currentMessages,
      subAgentProgressRef.current,
      toolElapsedByKeyRef.current,
    )
    if (messagesToPersist !== currentMessages) {
      setMessages(messagesToPersist)
      messagesRef.current = messagesToPersist
    }

    const signature = signatureAgentMessages(messagesToPersist)
    if (signature !== lastSavedMessagesRef.current) {
      lastSavedMessagesRef.current = signature
      await persistConversationMessages(targetId, messagesToPersist, activeScopeRef.current)
    }
    return targetId
  }, [persistConversationMessages, setMessages])

  const createConversation = useCallback(async (scope: AgentScope, title: string): Promise<number | null> => {
    const config = selectedModelConfigRef.current
    const result = await window.electronAPI.agent.createConversation({
      scope,
      title,
      modelProvider: modelConfigProvider(config),
      modelId: modelConfigId(config),
    })
    const record = result.success ? normalizeConversationRecord(result.conversation) : null
    if (!record) return null
    applyConversationId(record.id)
    setConversationTitle(record.title)
    void refreshConversationRecords()
    return record.id
  }, [applyConversationId, refreshConversationRecords])

  const restoreLoadedConversation = useCallback((
    loaded: AgentConversationLoaded,
    options: { closeRecords?: boolean } = {},
  ) => {
    setMessages(loaded.messages)
    messagesRef.current = loaded.messages
    lastSavedMessagesRef.current = signatureAgentMessages(loaded.messages)
    applyConversationId(loaded.id)
    setConversationTitle(loaded.title)
    setTitleEditing(false)
    setTitleDraft('')
    activeScopeRef.current = loaded.scope || { kind: 'global' }
    setMentions([])
    const restoredToolElapsed: Record<string, number> = {}
    for (const message of loaded.messages) Object.assign(restoredToolElapsed, readToolElapsedFromMessage(message))
    setToolElapsedByKey(restoredToolElapsed)
    setAgentProgress([])
    setAgentRunPending(false)
    setSubAgentProgress([])
    setAgentNotice('')
    setTitleLoading(false)
    titleRequestSeqRef.current += 1
    if (options.closeRecords !== false) setRecordsOpen(false)
  }, [applyConversationId, setMessages])

  const loadConversationById = useCallback(async (
    id: number,
    options: { closeRecords?: boolean } = {},
  ): Promise<boolean> => {
    const result = await window.electronAPI.agent.loadConversation(id)
    const loaded = result.success ? normalizeLoadedConversation(result.conversation) : null
    if (!loaded) return false
    restoreLoadedConversation(loaded, options)
    return true
  }, [restoreLoadedConversation])

  const shareFilteredRecords = useMemo(() => {
    const keyword = shareSearch.trim().toLowerCase()
    if (!keyword) return conversationRecords
    return conversationRecords.filter((record) => record.title.toLowerCase().includes(keyword))
  }, [conversationRecords, shareSearch])

  const loadShareConversation = useCallback(async (record: AgentConversationRecord) => {
    setShareSelectedId(record.id)
    setShareLoading(true)
    setShareError('')
    try {
      const result = await window.electronAPI.agent.loadConversation(record.id)
      const loaded = result.success ? normalizeLoadedConversation(result.conversation) : null
      if (!loaded) {
        setSharePreviewData(null)
        setShareError(result.error || '加载对话失败')
        return
      }
      setSharePreviewData(buildAgentSharePreviewData(loaded))
    } catch (error) {
      setSharePreviewData(null)
      setShareError(error instanceof Error ? error.message : '加载对话失败')
    } finally {
      setShareLoading(false)
    }
  }, [])

  const handleOpenShare = useCallback(async () => {
    if (busy) {
      setAgentNotice('当前 Agent 正在输出，等这轮结束后再分享。')
      return
    }
    const currentId = await saveCurrentConversationForShare()
    if (!currentId && messagesRef.current.length > 0) {
      setAgentNotice('当前对话还没有可分享的记录。')
      return
    }
    setShareOpen(true)
    setShareError('')
    setShareSearch('')
    setSharePreviewData(null)
    setShareSelectedId(null)
    void refreshConversationRecords().then((records) => {
      const target = records.find((record) => record.id === currentId) || records[0]
      if (target) void loadShareConversation(target)
    })
  }, [busy, loadShareConversation, refreshConversationRecords, saveCurrentConversationForShare])

  const handleSaveShareImage = useCallback(async () => {
    if (!sharePreviewData || !shareCardRef.current) return
    setShareSaving(true)
    setShareError('')
    try {
      const fileName = `CipherTalk-Agent-${sanitizeAgentShareFileName(sharePreviewData.title)}-${formatAgentShareFileDate()}.png`
      const saveResult = await window.electronAPI.dialog.saveFile({
        title: '保存 Agent 分享图',
        defaultPath: fileName,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      })
      if (saveResult.canceled || !saveResult.filePath) return

      const dataUrl = await toPng(shareCardRef.current, {
        bgcolor: '#f8fafc',
        cacheBust: true,
        scale: 2,
      })
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
      const writeResult = await window.electronAPI.file.writeBase64(saveResult.filePath, base64)
      if (!writeResult.success) {
        setShareError(writeResult.error || '保存图片失败')
        return
      }
      toast.success('分享图已保存')
    } catch (error) {
      setShareError(error instanceof Error ? error.message : '生成图片失败')
    } finally {
      setShareSaving(false)
    }
  }, [sharePreviewData])

  const generateTitleFromFirstMessage = useCallback((firstMessage: string) => {
    const fallback = buildFallbackConversationTitle(firstMessage)
    setConversationTitle(fallback)
    setTitleLoading(true)
    const requestSeq = ++titleRequestSeqRef.current
    const targetConversationId = conversationIdRef.current
    void window.electronAPI.agent
      .generateTitle(firstMessage, selectedModelConfigRef.current)
      .then((result) => {
        if (requestSeq !== titleRequestSeqRef.current || targetConversationId !== conversationIdRef.current) return
        if (result.success && result.title?.trim()) {
          const nextTitle = result.title.trim().slice(0, 24)
          setConversationTitle(nextTitle)
          if (targetConversationId) {
            void window.electronAPI.agent.renameConversation(targetConversationId, nextTitle).then(() => refreshConversationRecords())
          }
        }
      })
      .finally(() => {
        if (requestSeq === titleRequestSeqRef.current && targetConversationId === conversationIdRef.current) {
          setTitleLoading(false)
        }
      })
  }, [])

  const handleNewConversation = useCallback(() => {
    if (busy) void stop()
    setMessages([])
    messagesRef.current = []
    setMentions([])
    setConversationTitle('新对话')
    setTitleEditing(false)
    setTitleDraft('')
    setTitleLoading(false)
    setToolElapsedByKey({})
    setAgentProgress([])
    setAgentRunPending(false)
    setSubAgentProgress([])
    setAgentNotice('')
    activeScopeRef.current = { kind: 'global' }
    lastSavedMessagesRef.current = ''
    titleRequestSeqRef.current += 1
    applyConversationId(null)
    setRecordsOpen(false)
  }, [applyConversationId, busy, setMessages, stop])

  const handleOpenRecord = useCallback((record: AgentConversationRecord) => {
    if (busy) void stop()
    void loadConversationById(record.id)
  }, [busy, loadConversationById, stop])

  const handleDeleteRecord = useCallback(async (record: AgentConversationRecord) => {
    try {
      const result = await window.electronAPI.agent.deleteConversation(record.id)
      if (!result.success) {
        setAgentNotice(result.error || '删除对话失败')
        return false
      }
      setConversationRecords((prev) => prev.filter((item) => item.id !== record.id))
      if (conversationIdRef.current === record.id) {
        setMessages([])
        messagesRef.current = []
        applyConversationId(null)
        setConversationTitle('新对话')
        setTitleEditing(false)
        setTitleDraft('')
        activeScopeRef.current = { kind: 'global' }
        lastSavedMessagesRef.current = ''
        setToolElapsedByKey({})
        setAgentProgress([])
        setAgentRunPending(false)
        setSubAgentProgress([])
      }
      return true
    } catch (error) {
      setAgentNotice(error instanceof Error ? error.message : '删除对话失败')
      return false
    }
  }, [applyConversationId, setMessages])

  const confirmDeleteRecord = useCallback(async () => {
    if (!recordPendingDelete) return
    const target = recordPendingDelete
    setRecordDeleting(true)
    const deleted = await handleDeleteRecord(target)
    setRecordDeleting(false)
    if (deleted) setRecordPendingDelete(null)
  }, [handleDeleteRecord, recordPendingDelete])

  const slashCommands = useMemo<SlashCommandItem[]>(() => [
    {
      id: 'status',
      commands: ['/status'],
      aliases: ['zhuangtai', '状态'],
      label: '查看状态',
      description: '显示模型、工作区、预览和 token 状态',
      icon: CircleInfo,
      action: () => {
        const workspace = codeWorkspaceState?.workspace
        const devServer = codeWorkspaceState?.devServer
        const tokenLine = conversationUsage.hasAny
          ? `Token：输入 ${formatTokenCount(conversationUsage.input)}，输出 ${formatTokenCount(conversationUsage.output)}，共 ${formatTokenCount(conversationUsage.total)}`
          : 'Token：暂无本次会话用量'
        setAgentNotice([
          '状态：',
          `模型：${selectedModelData?.name || '未选择'}`,
          `工作区：${workspace ? displayBasename(workspace.root) : '未选择'}`,
          `开发服务器：${devServer?.running ? (devServer.previewUrl || devServer.command || '运行中') : '未运行'}`,
          `联网搜索：${webSearchOn ? '已开启' : '未开启'}`,
          `计划模式：${planMode ? '已开启' : '未开启'}`,
          tokenLine,
        ].join('\n'))
      },
    },
    {
      id: 'plan',
      commands: ['/plan'],
      aliases: ['jihua', '计划'],
      label: planMode ? '关闭计划模式' : '开启计划模式',
      description: '切换下一轮是否先生成执行计划',
      icon: ListCheck,
      action: () => setPlanMode((value) => !value),
    },
    {
      id: 'clear',
      commands: ['/clear', '/new'],
      aliases: ['qingkong', 'xin', '清空', '新对话'],
      label: '新对话 / 清空',
      description: '清空当前线程并回到新对话',
      icon: PencilToSquare,
      action: handleNewConversation,
    },
    {
      id: 'workspace',
      commands: ['/workspace'],
      aliases: ['code', 'files', '工作区', '文件'],
      label: '打开工作区',
      description: '打开左侧文件树和工作区选择',
      icon: LayoutSideContentLeft,
      action: () => setWorkspaceSidebarOpen(true),
    },
    {
      id: 'preview',
      commands: ['/preview'],
      aliases: ['yulan', '预览'],
      label: '打开预览',
      description: '打开代码工作区预览面板',
      icon: Display,
      action: () => {
        setCodeWorkspacePanelTab('preview')
        setCodeWorkspacePanelOpen(true)
      },
    },
    {
      id: 'logs',
      commands: ['/logs'],
      aliases: ['rizhi', 'terminal', '日志', '终端'],
      label: '打开日志',
      description: '打开开发服务器日志面板',
      icon: Terminal,
      action: () => {
        setCodeWorkspacePanelTab('logs')
        setCodeWorkspacePanelOpen(true)
      },
    },
    {
      id: 'model',
      commands: ['/model'],
      aliases: ['moxing', '模型'],
      label: '选择模型',
      description: '打开模型和思考强度选择',
      icon: Bulb,
      action: () => setModelOpen(true),
    },
    {
      id: 'search',
      commands: ['/search'],
      aliases: ['web', '联网', '搜索'],
      label: webSearchOn ? '关闭联网搜索' : '开启联网搜索',
      description: '切换 Tavily 联网搜索工具',
      icon: Globe,
      action: () => toggleWebSearch(),
    },
  ], [
    codeWorkspaceState,
    conversationUsage,
    handleNewConversation,
    planMode,
    selectedModelData,
    toggleWebSearch,
    webSearchOn,
  ])

  const slashCommandByName = useMemo(() => {
    const map = new Map<string, SlashCommandItem>()
    for (const command of slashCommands) {
      for (const name of command.commands) map.set(name.toLowerCase(), command)
    }
    return map
  }, [slashCommands])

  const runSlashCommandText = useCallback(async (value: string) => {
    const match = value.trim().match(/^\/[^\s/]+$/)
    if (!match) return false
    const command = slashCommandByName.get(match[0].toLowerCase())
    if (!command) return false
    await command.action()
    return true
  }, [slashCommandByName])

  const beginTitleEdit = useCallback(() => {
    titleRequestSeqRef.current += 1
    titleIgnoreBlurRef.current = false
    titleCommitInFlightRef.current = false
    setTitleLoading(false)
    setTitleDraft(conversationTitle)
    setTitleEditing(true)
  }, [conversationTitle])

  const cancelTitleEdit = useCallback(() => {
    titleIgnoreBlurRef.current = true
    setTitleEditing(false)
    setTitleDraft('')
  }, [])

  const commitTitleEdit = useCallback(async () => {
    if (titleCommitInFlightRef.current) return
    titleCommitInFlightRef.current = true
    const nextTitle = titleDraft.trim().slice(0, 80) || '新对话'
    const currentTitle = conversationTitle.trim() || '新对话'
    setTitleEditing(false)
    setTitleDraft('')
    if (nextTitle === currentTitle) {
      titleCommitInFlightRef.current = false
      return
    }

    setConversationTitle(nextTitle)
    const targetId = conversationIdRef.current
    if (!targetId) {
      titleCommitInFlightRef.current = false
      return
    }

    setTitleSaving(true)
    try {
      const result = await window.electronAPI.agent.renameConversation(targetId, nextTitle)
      if (result.success) {
        const record = normalizeConversationRecord(result.conversation)
        if (record) {
          setConversationRecords((prev) => prev.map((item) => item.id === record.id ? record : item))
        } else {
          void refreshConversationRecords()
        }
      } else {
        setAgentNotice(result.error || '重命名对话失败')
      }
    } finally {
      setTitleSaving(false)
      titleCommitInFlightRef.current = false
    }
  }, [conversationTitle, refreshConversationRecords, titleDraft])

  useEffect(() => {
    if (!titleEditing) return
    const timer = window.setTimeout(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [titleEditing])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [items, provider, activePresetId] = await Promise.all([
        configService.getAiConfigPresets(),
        configService.getAiProvider(),
        configService.getActiveAiConfigPresetId(),
      ])
      const currentConfig = await configService.getAiProviderConfig(provider)
      if (cancelled) return
      setPresets(items)
      setCurrentProviderId(provider)
      setCurrentModelId(currentConfig?.model || '')
      setCurrentProviderConfig(currentConfig)
      const defaultPresetId = resolveDefaultPresetId(items, provider, currentConfig, activePresetId)
      setSelectedPresetId((current) => {
        if (current !== 'current' && items.some((item) => item.id === current)) return current
        return defaultPresetId
      })
    })()
    void getAIProviders().then((items) => {
      if (!cancelled) setProvidersInfo(items)
    })
    void window.electronAPI.agent.listConversations().then((result) => {
      if (cancelled || !result.success || !Array.isArray(result.conversations)) return
      setConversationRecords(
        result.conversations
          .map(normalizeConversationRecord)
          .filter((item): item is AgentConversationRecord => !!item)
      )
    })
    return () => {
      cancelled = true
    }
  }, [refreshConversationRecords])

  useEffect(() => {
    let cancelled = false

    const loadIfStillEmpty = async (id: number): Promise<boolean> => {
      if (cancelled || conversationIdRef.current || messagesRef.current.length > 0) return false
      const result = await window.electronAPI.agent.loadConversation(id)
      if (cancelled || conversationIdRef.current || messagesRef.current.length > 0) return false
      const loaded = result.success ? normalizeLoadedConversation(result.conversation) : null
      if (!loaded) return false
      restoreLoadedConversation(loaded, { closeRecords: false })
      return true
    }

    void (async () => {
      const stored = readStoredActiveAgentConversation()
      if (stored === NEW_AGENT_CONVERSATION_MARKER) return
      if (typeof stored === 'number' && await loadIfStillEmpty(stored)) return
      if (cancelled || conversationIdRef.current || messagesRef.current.length > 0) return

      const result = await window.electronAPI.agent.getLastConversation()
      const record = result.success ? normalizeConversationRecord(result.conversation) : null
      if (!record) return
      await loadIfStillEmpty(record.id)
    })().catch(() => {
      // 恢复失败时保持空白新对话。
    })

    return () => {
      cancelled = true
    }
  }, [restoreLoadedConversation])

  const handleSubmit = async (message: PromptInputMessage) => {
    if (busy) {
      void stop()
      setSubAgentProgress([])
      return
    }
    const currentMentions = mentions
    if (message.files.length === 0 && currentMentions.length === 0 && workspaceFileReferences.length === 0 && await runSlashCommandText(message.text)) {
      return
    }
    if (!selectedModelSupportsTools) {
      setAgentNotice('当前模型不支持工具调用，无法查询本地聊天记录。请切换到带“工具调用”能力的模型。')
      return
    }
    const isFirstUserMessage = messages.length === 0
    const firstMessageForTitle = message.text.trim()
    let text = message.text.trim()
    const currentWorkspaceFileReferences = workspaceFileReferences
    if (currentMentions.length > 0) {
      const mentionLine = currentMentions.map((m) => `@${m.displayName}[${m.username}]`).join(' ')
      text = text ? `${mentionLine}\n${text}` : mentionLine
    }
    if (currentWorkspaceFileReferences.length > 0) {
      const workspaceFilePrefix = buildWorkspaceFilePrefix(currentWorkspaceFileReferences)
      text = text ? `${workspaceFilePrefix}\n${text}` : workspaceFilePrefix
    }
    if (!text && message.files.length === 0) return

    const submitScope: AgentScope =
      currentMentions.length === 1
        ? { kind: 'session', sessionId: currentMentions[0].username, displayName: currentMentions[0].displayName }
        : { kind: 'global' }
    activeScopeRef.current = submitScope
    submitScopeRef.current = submitScope
    runIsPlanRef.current = planModeRef.current
    setAgentNotice('')
    setAgentProgress([])
    setAgentRunPending(true)
    setSubAgentProgress([])

    try {
      const titleText = firstMessageForTitle || currentWorkspaceFileReferences.map((ref) => ref.name || displayBasename(ref.path)).join(' ')
      if (!conversationIdRef.current) {
        const fallback = buildFallbackConversationTitle(titleText || text)
        setConversationTitle(fallback)
        await createConversation(submitScope, fallback)
      }

      if (isFirstUserMessage) generateTitleFromFirstMessage(titleText || text)

      const sendPromise = Promise.resolve(sendMessage({ text, files: message.files })).finally(() => {
        submitScopeRef.current = null
        setAgentRunPending(false)
      })
      void sendPromise
      setMentions([])
      setWorkspaceFileReferences([])
    } catch (error) {
      submitScopeRef.current = null
      setAgentRunPending(false)
      throw error
    }
  }

  // 三个都用 messagesRef.current 而不是闭包里的 messages：后者每次流式 tick 都变，
  // 会导致这几个回调的引用跟着每 tick 重建，直接传给逐条消息的 memo 组件时白白让它们全部重渲染。
  const handleRegenerateAssistantMessage = useCallback((messageIndex: number) => {
    if (busy || !selectedModelSupportsTools) return
    const currentMessages = messagesRef.current
    const assistantMessage = currentMessages[messageIndex]
    if (!assistantMessage || assistantMessage.role !== 'assistant') return
    const userIndex = (() => {
      for (let index = messageIndex - 1; index >= 0; index -= 1) {
        if (currentMessages[index]?.role === 'user') return index
      }
      return -1
    })()
    if (userIndex < 0) return

    stopSpeakingMessage()
    setAgentNotice('')
    setAgentProgress([])
    setAgentRunPending(true)
    setSubAgentProgress([])
    runIsPlanRef.current = planModeRef.current
    submitScopeRef.current = activeScopeRef.current
    const nextMessages = currentMessages.slice(0, messageIndex)
    messagesRef.current = nextMessages

    const sendPromise = Promise.resolve(regenerate({ messageId: assistantMessage.id })).finally(() => {
      submitScopeRef.current = null
      setAgentRunPending(false)
    })
    void sendPromise
  }, [busy, regenerate, selectedModelSupportsTools])

  const handleRetryUserMessage = useCallback((messageIndex: number) => {
    if (busy || !selectedModelSupportsTools) return
    const currentMessages = messagesRef.current
    const userMessage = currentMessages[messageIndex]
    if (!userMessage || userMessage.role !== 'user') return

    stopSpeakingMessage()
    setAgentNotice('')
    setAgentProgress([])
    setAgentRunPending(true)
    setSubAgentProgress([])
    runIsPlanRef.current = planModeRef.current
    submitScopeRef.current = activeScopeRef.current
    const nextMessages = currentMessages.slice(0, messageIndex + 1)
    setMessages(nextMessages)
    messagesRef.current = nextMessages

    const sendPromise = Promise.resolve(regenerate({ messageId: userMessage.id })).finally(() => {
      submitScopeRef.current = null
      setAgentRunPending(false)
    })
    void sendPromise
  }, [busy, regenerate, selectedModelSupportsTools, setMessages, stopSpeakingMessage])

  const handleEditUserMessage = useCallback((messageIndex: number, text: string) => {
    if (busy) return
    const currentMessages = messagesRef.current
    const userMessage = currentMessages[messageIndex]
    if (!userMessage || userMessage.role !== 'user') return
    promptInputControllerRef.current?.textInput.setInput(text)
    const nextMessages = currentMessages.slice(0, messageIndex)
    setMessages(nextMessages)
    messagesRef.current = nextMessages
    setAgentNotice('')
    setAgentProgress([])
    setSubAgentProgress([])
  }, [busy, setMessages])

  // 计划模式确认：关闭计划模式并让 Agent 按上一条计划开始执行（沿用当前会话 scope）
  const handleExecutePlan = useCallback(() => {
    if (busy || !selectedModelSupportsTools) return
    planModeRef.current = false
    runIsPlanRef.current = false
    setPlanMode(false)
    setAgentNotice('')
    setAgentProgress([])
    setAgentRunPending(true)
    setSubAgentProgress([])
    submitScopeRef.current = activeScopeRef.current
    const sendPromise = Promise.resolve(sendMessage({ text: '请按上面的计划开始执行，按需调用工具或委托子助手，直接给出最终结果，不要再重复计划。', files: [] })).finally(() => {
      submitScopeRef.current = null
      setAgentRunPending(false)
    })
    void sendPromise
  }, [busy, selectedModelSupportsTools, sendMessage])

  const handleModelSelect = useCallback((id: string) => {
    const model = models.find((item) => item.id === id)
    if (!model || model.disabled) return
    setSelectedPresetId(id)
    setModelOpen(false)
  }, [models])

  const handleReasoningEffortSelect = useCallback((value: string) => {
    if (!REASONING_EFFORT_OPTIONS.some((option) => option.value === value)) return
    setReasoningEffort(value as AgentReasoningEffort)
    setModelOpen(false)
  }, [])

  useEffect(() => {
    if (!conversationId || messages.length === 0) return

    if (busy) {
      if (streamingSaveTimerRef.current !== null) return
      const elapsedMs = Date.now() - lastStreamingSaveAtRef.current
      const delayMs = Math.max(0, STREAMING_AGENT_SAVE_INTERVAL_MS - elapsedMs)
      streamingSaveTimerRef.current = window.setTimeout(() => {
        streamingSaveTimerRef.current = null
        lastStreamingSaveAtRef.current = Date.now()
        flushConversationMessagesToStorage()
      }, delayMs)
      return
    }

    if (streamingSaveTimerRef.current !== null) {
      window.clearTimeout(streamingSaveTimerRef.current)
      streamingSaveTimerRef.current = null
    }
    lastStreamingSaveAtRef.current = Date.now()
    flushConversationMessagesToStorage({ refreshRecords: true })
  }, [busy, conversationId, flushConversationMessagesToStorage, messages, subAgentProgress, toolElapsedByKey])

  useEffect(() => {
    return () => {
      if (streamingSaveTimerRef.current !== null) {
        window.clearTimeout(streamingSaveTimerRef.current)
        streamingSaveTimerRef.current = null
      }
      flushConversationMessagesToStorage()
    }
  }, [flushConversationMessagesToStorage])

  // 出处：会话名解析
  const sessionNameMap = useMemo(() => new Map(sessions.map((s) => [s.username, s.displayName])), [sessions])
  const sourceSessionIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const source of extractSources(message.parts)) ids.add(source.sessionId)
    }
    return Array.from(ids).sort().join('\n')
  }, [messages])
  useEffect(() => {
    const ids = sourceSessionIdKey.split('\n').filter(Boolean)
    const missing = ids.filter((id) => !sessionNameMap.has(id) && !sourceNameById[id])
    if (missing.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        await window.electronAPI.chat.connect?.()
      } catch {
        // 未连接时仍尝试走头像/联系人查询兜底。
      }
      return Promise.all(
        missing.map(async (id) => {
          try {
            const result = await window.electronAPI.chat.getContactAvatar(id)
            return [id, result?.displayName || id] as const
          } catch {
            return [id, id] as const
          }
        })
      )
    })().then((entries) => {
      if (cancelled) return
      setSourceNameById((prev) => {
        const next = { ...prev }
        for (const [id, displayName] of entries) next[id] = displayName
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [sessionNameMap, sourceNameById, sourceSessionIdKey])
  const sessionNameOf = useCallback((sessionId: string) => (
    sessionNameMap.get(sessionId) || sourceNameById[sessionId] || sessionId
  ), [sessionNameMap, sourceNameById])

  return (
    <Surface
      className={`relative flex h-full min-h-0 flex-col overflow-hidden${agentGlassReady ? ' agent-glass-ready' : ''}`}
      style={{ '--agent-radius': '12px' } as CSSProperties}
      variant="transparent"
    >
      <AgentGlassDefs onReady={handleAgentGlassReady} />
      <div className="relative flex h-14 shrink-0 items-center justify-center border-b border-border/60 px-3">
        <div className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center">
          <Tooltip delay={0}>
            <HeroButton
              aria-label="工作区文件树"
              className="size-9 p-0"
              isIconOnly
              onPress={() => setWorkspaceSidebarOpen((open) => !open)}
              size="md"
              variant={workspaceSidebarOpen ? 'secondary' : 'tertiary'}
            >
              <LayoutSideContentLeft className="size-4.5" />
            </HeroButton>
            <Tooltip.Content placement="bottom">{workspaceSidebarOpen ? '隐藏工作区文件树' : '显示工作区文件树'}</Tooltip.Content>
          </Tooltip>
        </div>
        <div className="absolute left-1/2 top-1/2 min-w-0 max-w-[min(36rem,calc(100%-14rem))] -translate-x-1/2 -translate-y-1/2">
          {titleEditing ? (
            <input
              aria-label="编辑对话名称"
              className="h-9 w-90 max-w-[calc(100vw-14rem)] rounded-(--agent-radius,12px) border border-border bg-background px-3 text-center font-medium text-foreground text-sm outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30"
              disabled={titleSaving}
              onBlur={() => {
                if (titleIgnoreBlurRef.current) {
                  titleIgnoreBlurRef.current = false
                  return
                }
                void commitTitleEdit()
              }}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitTitleEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelTitleEdit()
                }
              }}
              ref={titleInputRef}
              value={titleDraft}
            />
          ) : (
            <Tooltip delay={0}>
              <button
                className="group inline-flex h-9 min-w-0 max-w-full items-center justify-center gap-1.5 rounded-(--agent-radius,12px) px-3 text-center hover:bg-accent/40"
                onClick={beginTitleEdit}
                type="button"
              >
                <span className="truncate font-medium text-sm text-foreground">
                  {titleSaving ? '保存中...' : titleLoading ? '生成标题中...' : conversationTitle}
                </span>
                <PencilToLine className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
              <Tooltip.Content placement="bottom">
                {titleLoading ? '正在生成标题' : `编辑对话名称：${conversationTitle}`}
              </Tooltip.Content>
            </Tooltip>
          )}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <Toolbar aria-label="对话操作" className="gap-1.5 p-0">
            <CodeWorkspacePanelPopover
              activeTab={codeWorkspacePanelTab}
              isOpen={codeWorkspacePanelOpen}
              logs={codeWorkspaceLogs}
              onActiveTabChange={setCodeWorkspacePanelTab}
              onOpenChange={setCodeWorkspacePanelOpen}
              onStopDevServer={handleStopCodeDevServer}
              state={codeWorkspaceState}
            />
            <div className="flex items-center gap-1.5">
              <AgentRecordsMenu
                isOpen={recordsOpen}
                onOpenChange={handleRecordsOpenChange}
                records={conversationRecords}
                selectedId={conversationId}
                onOpenRecord={handleOpenRecord}
                onDeleteRecord={(record) => {
                  setRecordPendingDelete(record)
                  setRecordsOpen(false)
                }}
              />
              <Tooltip delay={0}>
                <HeroButton
                  aria-label="分享对话"
                  className="size-9 p-0"
                  isDisabled={busy}
                  isIconOnly
                  onPress={handleOpenShare}
                  size="md"
                  variant="tertiary"
                >
                  <ArrowUpRightFromSquare className="size-4.5" />
                </HeroButton>
                <Tooltip.Content placement="bottom">{busy ? '输出结束后可分享' : '分享对话'}</Tooltip.Content>
              </Tooltip>
              <Tooltip delay={0}>
                <HeroButton
                  aria-label="新建对话"
                  className="size-9 p-0"
                  isIconOnly
                  onPress={handleNewConversation}
                  size="md"
                  variant="tertiary"
                >
                  <PencilToSquare className="size-4.5" />
                </HeroButton>
                <Tooltip.Content placement="bottom">新建对话</Tooltip.Content>
              </Tooltip>
            </div>
          </Toolbar>
        </div>
      </div>
      {memoryIntroStatus === 'checking' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
          <Loader />
        </div>
      ) : memoryIntroStatus === 'needed' ? (
        <AgentMemoryIntro onMemoryCreated={markMemoryIntroSatisfied} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {workspaceSidebarOpen && (
            <CodeWorkspaceSidebar
              onSelect={handleSelectCodeWorkspace}
              state={codeWorkspaceState}
            />
          )}
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <Conversation className="min-h-0 flex-1">
        <ConversationAutoScroll enabled={shouldAnchorLatestUser} trigger={latestUserMessageId} />
        <ConversationContent
          className={
            messages.length === 0
              ? 'mx-auto h-full w-full min-w-80 max-w-[82%] pt-4 pb-48'
              : 'mx-auto w-full min-w-80 max-w-[82%] pt-4 pb-48'
          }
        >
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="开始查询聊天记录"
              description="输入问题后，助手会基于本地聊天数据回答"
            />
          ) : (
            messages.map((message, messageIndex) => (
              <AgentMessageItem
                busy={busy}
                copied={copiedMessageId === message.id}
                isLastMessage={messageIndex === messages.length - 1}
                key={message.id}
                message={message}
                messageIndex={messageIndex}
                onCopyAssistant={handleCopyAssistantMessage}
                onCopyUser={handleCopyUserMessage}
                onEdit={handleEditUserMessage}
                onExecutePlan={handleExecutePlan}
                onOpenUsageDetails={setUsageDetailsModal}
                onPreviewGeneratedImage={setGeneratedImagePreview}
                onRegenerate={handleRegenerateAssistantMessage}
                onRetry={handleRetryUserMessage}
                onSpeak={handleSpeakAssistantMessage}
                runIsPlan={runIsPlanRef.current}
                selectedModelSupportsTools={selectedModelSupportsTools}
                sessionNameOf={sessionNameOf}
                speaking={speakingMessageId === message.id}
                status={status}
                subAgentProgress={subAgentProgress}
                toolElapsedByKey={toolElapsedByKey}
              />
            ))
          )}
          {waitingFirstModelOutput && (
            <Message from="assistant">
              <MessageContent>
                <ModelWaitingLine />
              </MessageContent>
            </Message>
          )}
          {agentNotice && (
            <div
              className={`mt-3 whitespace-pre-line rounded-(--agent-radius,12px) border px-3 py-2 text-xs ${
                agentNotice.startsWith('状态：')
                  ? 'border-border bg-muted/35 text-muted-foreground'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              }`}
            >
              {agentNotice}
            </div>
          )}
         {busy && subAgentProgress.length > 0 && !lastAssistantMessageHasDelegateTool && <SubAgentProgressPanel events={subAgentProgress} />}
        </ConversationContent>
        <ConversationScrollButton className="bottom-36 z-30 agent-scroll-glass" />
      </Conversation>

      <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-44">
        <div className="absolute right-0 bottom-3 left-0 grid place-items-center px-5">
          <div className="pointer-events-auto w-full max-w-4xl">
        <PromptInputProvider>
          <PromptInputControllerBridge controllerRef={promptInputControllerRef} />
          <PromptInput
            accept="image/*,.txt,.md,.json,.csv,.pdf,application/pdf"
            className={`agent-prompt-input w-full **:data-[slot=input-group]:border-border **:data-[slot=input-group]:bg-surface/55 **:data-[slot=input-group]:shadow-lg ${workspaceFileDragOver ? '**:data-[slot=input-group]:ring-2 **:data-[slot=input-group]:ring-primary/45' : ''}`}
            maxFiles={6}
            maxFileSize={8 * 1024 * 1024}
            multiple
            onDragLeave={handleWorkspaceFileDragLeave}
            onDragOver={handleWorkspaceFileDragOver}
            onDrop={handleWorkspaceFileDrop}
            onSubmit={handleSubmit}
          >
            <AgentPromptAssetHeader
              onRemoveWorkspaceFileReference={removeWorkspaceFileReference}
              workspaceFileReferences={workspaceFileReferences}
            />

            <PromptInputBody>
              <MentionField
                hasMore={mentionHasMore}
                isLoading={mentionLoading}
                mentions={mentions}
                onAdd={addMention}
                onLoadMore={loadMentionSessions}
                onRemove={removeMention}
                onSearch={searchMentionSessions}
                sessions={sessions}
              />
              <PromptInputTextarea
                className="min-h-10 max-h-40 py-2 text-sm leading-5"
                placeholder="问问你的聊天记录，Enter 发送，Shift + Enter 换行…"
              />
            </PromptInputBody>

            <PromptInputFooter className="items-center gap-1.5 px-2.5 pt-1 pb-2">
              <PromptInputTools className="flex-wrap gap-1.5">
                <ButtonGroup size="sm" variant="tertiary">
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger aria-label="更多输入操作" variant="tertiary" />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments label="添加图片或文件" />
                      <Dropdown.Item
                        id="plan-mode"
                        textValue="计划模式"
                        onAction={() => setPlanMode((value) => !value)}
                      >
                        <ListCheck className="size-4 shrink-0 text-muted" />
                        <Label>计划模式</Label>
                        <span className="ml-auto inline-flex pointer-events-none">
                          <Switch aria-label="计划模式" isSelected={planMode}>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                          </Switch>
                        </span>
                      </Dropdown.Item>
                      <Dropdown.Item
                        id="web-search"
                        textValue="联网搜索"
                        onAction={toggleWebSearch}
                      >
                        <Globe className="size-4 shrink-0 text-muted" />
                        <Label>联网搜索</Label>
                        <span className="ml-auto inline-flex pointer-events-none">
                          <Switch aria-label="联网搜索" isSelected={webSearchOn}>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                          </Switch>
                        </span>
                      </Dropdown.Item>
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                  <PromptPresetButton showGroupSeparator />
                  <SlashCommandButton
                    commands={slashCommands}
                    showGroupSeparator
                  />
                  <MentionTriggerButton showGroupSeparator />
                </ButtonGroup>

                {planMode && (
                  <HeroButton
                    aria-label="关闭计划模式"
                    className="gap-1"
                    onPress={() => setPlanMode(false)}
                    size="sm"
                    variant="secondary"
                  >
                    <ListCheck className="size-3.5" />
                    计划模式
                    <Xmark className="size-3" />
                  </HeroButton>
                )}

                {webSearchOn && (
                  <HeroButton
                    aria-label="关闭联网搜索"
                    className="gap-1"
                    onPress={toggleWebSearch}
                    size="sm"
                    variant="secondary"
                  >
                    <Globe className="size-3.5" />
                    联网搜索
                    <Xmark className="size-3" />
                  </HeroButton>
                )}

                {codeWorkspaceState?.workspace && (
                  <CodeWorkspaceApprovalPolicyDropdown
                    policy={codeWorkspaceState.workspace.approvalPolicy}
                    onChange={handleCodeWorkspaceApprovalPolicyChange}
                  />
                )}
              </PromptInputTools>

              <div className="flex items-center gap-2">
                <Dropdown isOpen={modelOpen} onOpenChange={setModelOpen}>
                  <HeroButton aria-label="选择模型" className="max-w-56" size="sm" variant="tertiary">
                    {selectedModelData?.chefSlug && (
                      <AIProviderLogo providerId={selectedModelData.chefSlug} alt={selectedModelData.chef} className="shrink-0" size={18} />
                    )}
                    {selectedModelData?.name && (
                      <span className="min-w-0 flex-1 truncate text-left">{selectedModelData.name}</span>
                    )}
                    <ChevronDown className="size-3.5 shrink-0" />
                  </HeroButton>
                  <Dropdown.Popover className="max-h-96 min-w-72 overflow-y-auto" placement="top end">
                    <Dropdown.Menu
                      disabledKeys={disabledModelKeys}
                      selectedKeys={selectedModelKeys}
                      selectionMode="single"
                      onAction={(key) => handleModelSelect(String(key))}
                    >
                      <Dropdown.SubmenuTrigger>
                        <Dropdown.Item id="reasoning-effort" textValue="思考强度">
                          <Bulb className="size-4 shrink-0 text-muted" />
                          <Label className="min-w-0 flex-1 text-left">思考强度</Label>
                          <span className="shrink-0 text-muted-foreground text-xs">
                            {reasoningEffortLabel(reasoningEffort, true)}
                          </span>
                          <Dropdown.SubmenuIndicator />
                        </Dropdown.Item>
                        <Dropdown.Popover className="min-w-44" placement="right top">
                          <Dropdown.Menu
                            selectedKeys={new Set([reasoningEffort])}
                            selectionMode="single"
                            onAction={(key) => handleReasoningEffortSelect(String(key))}
                          >
                            {REASONING_EFFORT_OPTIONS.map((option) => (
                              <Dropdown.Item id={option.value} key={option.value} textValue={option.label}>
                                <Dropdown.ItemIndicator />
                                <Label>{option.label}</Label>
                              </Dropdown.Item>
                            ))}
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown.SubmenuTrigger>
                      <Separator />
                      {chefs.map((chef) => (
                        <Dropdown.Section key={chef}>
                          <Header>{chef}</Header>
                          {models
                            .filter((model) => model.chef === chef)
                            .map((model) => (
                              <ModelItem key={model.id} model={model} />
                            ))}
                        </Dropdown.Section>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
                <ButtonGroup size="sm">
                  <AgentPromptPrimaryAction busy={busy} status={status} workspaceReferenceCount={workspaceFileReferences.length} />
                </ButtonGroup>
              </div>
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
        <div className="mt-2 flex w-full items-center justify-between gap-3 px-2">
          <CodeWorkspacePanel
            approval={codeWorkspaceApproval}
            className="min-w-0 flex-1"
            onApprove={handleApproveCodeWorkspace}
            onReject={handleRejectCodeWorkspace}
            onSelect={handleSelectCodeWorkspace}
            onStopDevServer={handleStopCodeDevServer}
            state={codeWorkspaceState}
          />
          {conversationUsage.hasAny && (
            <div className="ml-auto flex shrink-0 items-center justify-end gap-3 whitespace-nowrap text-[11px] text-muted-foreground">
              <span>本次会话Token用量</span>
              <span>输入 {formatTokenCount(conversationUsage.input)}</span>
              <span>输出 {formatTokenCount(conversationUsage.output)}</span>
              <span className="font-medium text-foreground/80">共 {formatTokenCount(conversationUsage.total)}</span>
            </div>
          )}
        </div>
          </div>
        </div>
      </div>
          </div>
        </div>
      )}
      {usageDetailsModal !== null && (
        <UsageDetailsModal
          data={usageDetailsModal}
          modelInfoByKey={modelInfoByKey}
          onClose={() => setUsageDetailsModal(null)}
        />
      )}
      <AlertDialog.Backdrop
        isOpen={recordPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !recordDeleting) setRecordPendingDelete(null)
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <TrashBin className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>删除这条对话记录？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>删除后无法恢复。</p>
              {recordPendingDelete && (
                <p className="mt-2 truncate font-medium text-foreground">{recordPendingDelete.title}</p>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <HeroButton
                isDisabled={recordDeleting}
                variant="tertiary"
                onPress={() => setRecordPendingDelete(null)}
              >
                取消
              </HeroButton>
              <HeroButton isDisabled={recordDeleting} variant="danger" onPress={confirmDeleteRecord}>
                {recordDeleting ? '删除中...' : '删除'}
              </HeroButton>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
      <Modal.Backdrop
        isOpen={shareOpen}
        onOpenChange={(open) => {
          if (shareSaving) return
          setShareOpen(open)
        }}
      >
        <Modal.Container placement="center" size="cover">
          <Modal.Dialog className="max-h-[calc(100vh-5rem)]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
                <ArrowUpRightFromSquare className="size-5" />
              </Modal.Icon>
              <Modal.Heading>分享 Agent 对话</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="grid min-h-136 gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
                <div className="min-h-0 rounded-(--agent-radius,12px) border border-border bg-muted/20 p-3">
                  <SearchField
                    aria-label="搜索对话"
                    className="mb-3"
                    value={shareSearch}
                    onChange={setShareSearch}
                  >
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input placeholder="搜索对话标题" />
                      <SearchField.ClearButton />
                    </SearchField.Group>
                  </SearchField>
                  <div className="ct-agent-scrollbar max-h-120 space-y-1 overflow-y-auto pr-1">
                    {conversationRecords.length === 0 ? (
                      <div className="flex min-h-40 items-center justify-center rounded-(--agent-radius,12px) border border-dashed border-border text-muted-foreground text-sm">
                        暂无对话记录
                      </div>
                    ) : shareFilteredRecords.length === 0 ? (
                      <div className="flex min-h-40 items-center justify-center rounded-(--agent-radius,12px) border border-dashed border-border text-muted-foreground text-sm">
                        没有匹配的对话
                      </div>
                    ) : shareFilteredRecords.map((record) => {
                      const selected = shareSelectedId === record.id
                      return (
                        <button
                          className={`flex w-full items-center gap-3 rounded-(--agent-radius,12px) border px-3 py-2.5 text-left transition ${
                            selected
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-transparent hover:border-border hover:bg-background'
                          }`}
                          key={record.id}
                          onClick={() => { void loadShareConversation(record) }}
                          type="button"
                        >
                          <Clock className="size-4 shrink-0 opacity-70" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-sm">{record.title}</span>
                            <span className="block truncate text-muted-foreground text-xs">
                              {new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </span>
                          {selected && <Check className="size-4 shrink-0" />}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="min-h-0 overflow-hidden rounded-(--agent-radius,12px) border border-border bg-muted/30">
                  <div className="flex items-center justify-between gap-3 border-border border-b bg-background/80 px-4 py-3">
                    <div className="min-w-0">
                      <Label className="block truncate">分享图预览</Label>
                      <p className="truncate text-muted-foreground text-xs">仅包含用户与 Agent 的文本问答</p>
                    </div>
                    {sharePreviewData?.truncated && (
                      <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-700 text-xs dark:text-amber-300">
                        已截取
                      </span>
                    )}
                  </div>
                  <div className="ct-agent-scrollbar max-h-124 overflow-auto p-5">
                    {shareLoading ? (
                      <div className="flex min-h-80 items-center justify-center gap-2 text-muted-foreground text-sm">
                        <Spinner size="sm" />
                        正在加载预览
                      </div>
                    ) : sharePreviewData ? (
                      <div className="flex justify-center">
                        <div className="origin-top scale-[0.72] md:scale-[0.78] lg:scale-[0.82]">
                          <AgentShareCard data={sharePreviewData} />
                        </div>
                        <div
                          aria-hidden
                          className="pointer-events-none fixed -left-2500 top-0"
                        >
                          <AgentShareCard captureRef={shareCardRef} data={sharePreviewData} />
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-h-80 items-center justify-center text-muted-foreground text-sm">
                        选择一个对话生成预览
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {shareError && (
                <div className="mt-3 rounded-(--agent-radius,12px) border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
                  {shareError}
                </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <HeroButton
                isDisabled={shareSaving}
                variant="tertiary"
                onPress={() => setShareOpen(false)}
              >
                取消
              </HeroButton>
              <HeroButton
                isDisabled={!sharePreviewData || sharePreviewData.messages.length === 0 || shareLoading}
                isPending={shareSaving}
                variant="primary"
                onPress={handleSaveShareImage}
              >
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : <ArrowDownToLine className="size-4" />}
                    保存图片
                  </>
                )}
              </HeroButton>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
      {generatedImagePreview && (
        <ImagePreview
          src={generatedImagePreview.src}
          originRect={generatedImagePreview.originRect}
          onClose={() => setGeneratedImagePreview(null)}
        />
      )}
    </Surface>
  )
}

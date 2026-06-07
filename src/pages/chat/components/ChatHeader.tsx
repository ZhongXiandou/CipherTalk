import { Aperture, Image as ImageIcon, Loader2, Mic, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Tooltip } from '@heroui/react'
import { DateJumpPicker } from './DateJumpPicker'
import type { ChatSession } from '../../../types/models'
import type { EmbeddingBuildProgress, EmbeddingVectorStoreInfo } from '../../../types/electron'
import { isGroupChat } from '../utils/messageGuards'
import { SessionAvatar } from './SessionSidebar'

type Progress = {
  current: number
  total: number
}

function formatVectorProgress(progress: EmbeddingBuildProgress | null): string {
  if (!progress) return '准备语义索引…'
  if (progress.total > 0) return `${progress.message} ${progress.current}/${progress.total} 段`
  return progress.message
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatUpdatedAt(ms: number | null): string {
  if (!ms) return '无'
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface ChatHeaderProps {
  currentSession: ChatSession
  currentSessionId: string | null
  isRefreshingMessages: boolean
  isLoadingMessages: boolean
  isUpdating: boolean
  onRefreshMessages: () => void | Promise<void>
  selectedDate: string
  onSelectedDateChange: (value: string) => void
  onJumpToDate: (dateValue?: string) => void | Promise<void>
  isJumpingToDate: boolean
  isBatchTranscribing: boolean
  batchTranscribeProgress: Progress
  onBatchTranscribe: () => void | Promise<void>
  isBatchDecrypting: boolean
  batchDecryptProgress: Progress
  onBatchDecrypt: () => void | Promise<void>
}

export function ChatHeader({
  currentSession,
  currentSessionId,
  isRefreshingMessages,
  isLoadingMessages,
  isUpdating,
  onRefreshMessages,
  selectedDate,
  onSelectedDateChange,
  onJumpToDate,
  isJumpingToDate,
  isBatchTranscribing,
  batchTranscribeProgress,
  onBatchTranscribe,
  isBatchDecrypting,
  batchDecryptProgress,
  onBatchDecrypt
}: ChatHeaderProps) {
  // 向量化（语义索引）状态：null=未知/未启用嵌入，count=已建片段数
  const [vecBuilding, setVecBuilding] = useState(false)
  const [vecStatus, setVecStatus] = useState<{ enabled: boolean; count: number } | null>(null)
  const [vecError, setVecError] = useState<string | null>(null)
  const [vecProgress, setVecProgress] = useState<EmbeddingBuildProgress | null>(null)
  const [vecStore, setVecStore] = useState<EmbeddingVectorStoreInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    setVecError(null)
    setVecProgress(null)
    setVecStore(null)
    if (!currentSessionId) {
      setVecStatus(null)
      return
    }
    void window.electronAPI.embedding.sessionStatus(currentSessionId).then((res) => {
      if (!cancelled && res.success) {
        setVecStatus({ enabled: !!res.enabled, count: res.count ?? 0 })
        setVecStore(res.store ?? null)
      }
    })
    return () => { cancelled = true }
  }, [currentSessionId])

  useEffect(() => {
    return window.electronAPI.embedding.onBuildProgress((progress) => {
      if (!currentSessionId || progress.sessionId !== currentSessionId) return
      setVecProgress(progress)
      if (progress.stage === 'done') {
        setVecStatus({ enabled: true, count: progress.indexed })
      }
    })
  }, [currentSessionId])

  const handleVectorize = async () => {
    if (!currentSessionId || vecBuilding) return
    setVecBuilding(true)
    setVecError(null)
    setVecProgress({
      sessionId: currentSessionId,
      stage: 'loading',
      current: 0,
      total: 0,
      indexed: vecStatus?.count ?? 0,
      message: '准备语义索引'
    })
    try {
      const res = await window.electronAPI.embedding.buildSession(currentSessionId)
      if (res.success) {
        setVecStatus({ enabled: true, count: res.indexed ?? 0 })
        const status = await window.electronAPI.embedding.sessionStatus(currentSessionId)
        if (status.success) setVecStore(status.store ?? null)
      } else setVecError(res.error || '向量化失败')
    } catch (e) {
      setVecError(e instanceof Error ? e.message : String(e))
    } finally {
      setVecBuilding(false)
    }
  }

  const vecDisabled = !currentSessionId || vecBuilding || (vecStatus !== null && !vecStatus.enabled)
  const vecTooltip = vecBuilding
    ? formatVectorProgress(vecProgress)
    : vecError
      ? `向量化失败：${vecError}`
      : vecStatus && !vecStatus.enabled
        ? '未启用嵌入模型（设置 → 嵌入）'
        : vecStatus && vecStatus.count > 0
          ? `已向量化 ${vecStatus.count} 段 · 点击更新`
          : '为此会话建立语义索引'
  const vectorEvidenceRows = vecStore
    ? [
        `片段：${vecStore.count} 段`,
        `维度：${vecStore.dimensions.length > 0 ? vecStore.dimensions.join(', ') : '无'}`,
        `文件：${vecStore.exists ? formatBytes(vecStore.sizeBytes) : '未创建'}`,
        `更新：${formatUpdatedAt(vecStore.updatedAtMs)}`,
        vecStore.dbPath,
      ]
    : []

  return (
    <div className="message-header">
      <SessionAvatar session={currentSession} size={40} />
      <div className="header-info">
        <h3>
          {currentSession.displayName || currentSession.username}
          {currentSession.isWeCom && (
            currentSession.weComCorp
              ? <span className="wecom-corp" title="企业微信">@{currentSession.weComCorp}</span>
              : <span className="wecom-badge" title="企业微信">企</span>
          )}
        </h3>
        {isGroupChat(currentSession.username) && (
          <div className="header-subtitle">群聊</div>
        )}
        {vecBuilding && (
          <div className="header-subtitle">{formatVectorProgress(vecProgress)}</div>
        )}
      </div>
      <div className="header-actions">
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="刷新消息"
              onPress={onRefreshMessages}
              isDisabled={isRefreshingMessages || isLoadingMessages}
            >
              <RefreshCw size={18} className={isRefreshingMessages || isUpdating ? 'animate-spin' : ''} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>刷新消息</Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="向量化（语义索引）"
              onPress={handleVectorize}
              isDisabled={vecDisabled}
            >
              {vecBuilding
                ? <Loader2 size={18} className="animate-spin" />
                : <Sparkles size={18} className={vecStatus && vecStatus.count > 0 ? 'text-primary' : ''} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content className="max-w-96">
            <div className="space-y-1">
              <div>{vecTooltip}</div>
              {vectorEvidenceRows.length > 0 && (
                <div className="space-y-0.5 text-xs text-muted-foreground">
                  {vectorEvidenceRows.map((row, index) => (
                    <div className={index === vectorEvidenceRows.length - 1 ? 'max-w-88 truncate font-mono' : ''} key={`${index}:${row}`}>
                      {row}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Tooltip.Content>
        </Tooltip>

        {!isGroupChat(currentSession.username) && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="查看朋友圈"
                onPress={() => window.electronAPI.window.openMomentsWindow(currentSession.username)}
              >
                <Aperture size={18} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>查看朋友圈</Tooltip.Content>
          </Tooltip>
        )}

        <DateJumpPicker
          value={selectedDate}
          onChange={onSelectedDateChange}
          onJump={onJumpToDate}
          disabled={!currentSessionId || isJumpingToDate}
          loading={isJumpingToDate}
        />

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="批量语音转文字"
              onPress={onBatchTranscribe}
              isDisabled={isBatchTranscribing || !currentSessionId}
            >
              {isBatchTranscribing ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            {isBatchTranscribing ? `批量转写中 (${batchTranscribeProgress.current}/${batchTranscribeProgress.total})` : '批量语音转文字'}
          </Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="批量解密图片"
              onPress={onBatchDecrypt}
              isDisabled={isBatchDecrypting || !currentSessionId}
            >
              {isBatchDecrypting ? <Loader2 size={18} className="animate-spin" /> : <ImageIcon size={18} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            {isBatchDecrypting ? `批量解密中 (${batchDecryptProgress.current}/${batchDecryptProgress.total})` : '批量解密图片'}
          </Tooltip.Content>
        </Tooltip>
      </div>
    </div>
  )
}

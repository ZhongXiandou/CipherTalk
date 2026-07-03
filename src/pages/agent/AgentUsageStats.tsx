/**
 * 消息用量/费用统计：token 明细格式化、按本地模型价格表估算费用、消息底部的操作条 + 详情弹窗。
 * 从 AgentPage.tsx 拆出。
 */
import type { ReactNode } from 'react'
import { Button as HeroButton, Modal, Table } from '@heroui/react'
import { ArrowsRotateLeft, Check, CircleInfo, Copy, Volume } from '@gravity-ui/icons'
import type { UIMessage } from 'ai'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import type { AIModelInfo } from '@/types/ai'
import { finiteNumber, parseAgentMessageMetadata, type AgentMessageMetadata } from './agentConversationHelpers'

export function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

export function formatEstimatedCost(value: number): string {
  if (value <= 0) return '约 $0.0000'
  return `约 $${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

export function formatFinishReason(value: string): string {
  switch (value) {
    case 'stop':
      return '正常结束'
    case 'tool-calls':
      return '工具调用'
    case 'length':
      return '长度限制'
    case 'content-filter':
      return '内容过滤'
    case 'error':
      return '出错'
    case 'other':
      return '其他'
    default:
      return value
  }
}

function estimateUsageCost(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): number | null {
  const usage = metadata.usage
  if (!usage) return null
  const modelInfo = metadata.modelProvider && metadata.modelId
    ? modelInfoByKey.get(`${metadata.modelProvider}::${metadata.modelId}`) || modelInfoByKey.get(metadata.modelId)
    : metadata.modelId
      ? modelInfoByKey.get(metadata.modelId)
      : undefined
  const cost = modelInfo?.cost
  if (!cost) return null

  const inputTokens = finiteNumber(usage.inputTokens)
  const cacheReadTokens = finiteNumber(usage.inputTokenDetails?.cacheReadTokens)
  const cacheWriteTokens = finiteNumber(usage.inputTokenDetails?.cacheWriteTokens)
  const noCacheTokens = finiteNumber(usage.inputTokenDetails?.noCacheTokens)
    ?? (inputTokens !== undefined
      ? Math.max(0, inputTokens - (cacheReadTokens || 0) - (cacheWriteTokens || 0))
      : undefined)
  const outputTokens = finiteNumber(usage.outputTokens)

  let total = 0
  let priced = false
  const add = (tokens: number | undefined, pricePerMillion: number | undefined) => {
    if (tokens === undefined || pricePerMillion === undefined) return
    total += (tokens / 1_000_000) * pricePerMillion
    priced = true
  }

  add(noCacheTokens, cost.input)
  add(cacheReadTokens, cost.cacheRead ?? cost.input)
  add(cacheWriteTokens, cost.cacheWrite ?? cost.input)
  add(outputTokens, cost.output)
  return priced ? total : null
}

function estimateCacheSavings(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): number | null {
  const usage = metadata.usage
  if (!usage) return null
  const modelInfo = metadata.modelProvider && metadata.modelId
    ? modelInfoByKey.get(`${metadata.modelProvider}::${metadata.modelId}`) || modelInfoByKey.get(metadata.modelId)
    : metadata.modelId
      ? modelInfoByKey.get(metadata.modelId)
      : undefined
  const cost = modelInfo?.cost
  const inputPrice = finiteNumber(cost?.input)
  const cacheReadPrice = finiteNumber(cost?.cacheRead)
  const cacheReadTokens = finiteNumber(usage.inputTokenDetails?.cacheReadTokens)
  if (inputPrice === undefined || cacheReadPrice === undefined || cacheReadTokens === undefined || cacheReadTokens <= 0) return null
  return Math.max(0, (cacheReadTokens / 1_000_000) * (inputPrice - cacheReadPrice))
}

type UsageDetailRow = {
  id: string
  label: string
  value: ReactNode
  note?: string
}

export function buildUsageDetailRows(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): UsageDetailRow[] {
  const rows: UsageDetailRow[] = []
  const usage = metadata.usage
  const add = (id: string, label: string, value: unknown, note?: string) => {
    if (value === undefined || value === null || value === '') return
    rows.push({ id, label, value: String(value), note })
  }
  const addTokens = (id: string, label: string, value: unknown, note?: string) => {
    const n = finiteNumber(value)
    if (n !== undefined) rows.push({ id, label, value: formatTokenCount(n), note })
  }

  add('model', '模型', [metadata.modelProvider, metadata.modelId].filter(Boolean).join(' / '))
  if (metadata.finishReason) add('finishReason', '结束原因', formatFinishReason(metadata.finishReason), metadata.rawFinishReason)

  addTokens('inputTokens', '输入 tokens', usage?.inputTokens)
  const cacheHitRate = finiteNumber(usage?.cacheHitRate)
    ?? (() => {
      const inputTokens = finiteNumber(usage?.inputTokens)
      const cacheReadTokens = finiteNumber(usage?.inputTokenDetails?.cacheReadTokens)
      return inputTokens && cacheReadTokens !== undefined ? cacheReadTokens / inputTokens : undefined
    })()
  if (cacheHitRate !== undefined) add('cacheHitRate', '缓存命中率', formatPercent(cacheHitRate))
  addTokens('noCacheTokens', '普通输入 tokens', usage?.inputTokenDetails?.noCacheTokens)
  addTokens('cacheReadTokens', '缓存读 tokens', usage?.inputTokenDetails?.cacheReadTokens)
  addTokens('cacheWriteTokens', '缓存写入 tokens', usage?.inputTokenDetails?.cacheWriteTokens)
  addTokens('outputTokens', '输出 tokens', usage?.outputTokens)
  addTokens('textTokens', '文本输出 tokens', usage?.outputTokenDetails?.textTokens)
  addTokens('reasoningTokens', '推理 tokens', usage?.outputTokenDetails?.reasoningTokens)
  addTokens('totalTokens', '总 tokens', usage?.totalTokens, '服务商口径，可能包含推理或额外开销')

  const estimatedCost = estimateUsageCost(metadata, modelInfoByKey)
  if (estimatedCost !== null) add('estimatedCost', '估算费用', formatEstimatedCost(estimatedCost), '按本地模型价格表估算')
  const cacheSavings = estimateCacheSavings(metadata, modelInfoByKey)
  if (cacheSavings !== null && cacheSavings > 0) add('cacheSavings', '缓存节省', formatEstimatedCost(cacheSavings), '按普通输入价与缓存读价差估算')

  if (usage?.raw) {
    rows.push({
      id: 'rawUsage',
      label: '服务商原始 usage',
      value: (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 text-[11px]">
          {JSON.stringify(usage.raw, null, 2)}
        </pre>
      ),
    })
  }

  return rows
}

export function messageTextOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
}

export function MessageUsageStats({
  canRegenerate,
  metadata,
  messageText,
  copied,
  regenerating,
  speaking,
  onCopy,
  onOpenDetails,
  onRegenerate,
  onSpeak,
}: {
  canRegenerate: boolean
  metadata: unknown
  messageText: string
  copied: boolean
  regenerating: boolean
  speaking: boolean
  onCopy: () => void
  onOpenDetails: (data: AgentMessageMetadata) => void
  onRegenerate: () => void
  onSpeak: () => void
}) {
  const parsed = parseAgentMessageMetadata(metadata)
  if (!parsed && !messageText) return null

  return (
    <div className="mt-3 border-border/60 border-t pt-2 text-[11px] leading-5 text-muted-foreground">
      <div className="flex items-center">
        <MessageActions className="shrink-0">
          <MessageAction
            disabled={!messageText}
            label="复制"
            onClick={onCopy}
            tooltip={copied ? '已复制' : '复制'}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </MessageAction>
          <MessageAction
            disabled={!messageText}
            label={speaking ? '停止播放' : '播放'}
            onClick={onSpeak}
            tooltip={speaking ? '停止播放' : '播放'}
          >
            <Volume className={`size-3.5 ${speaking ? 'text-accent-foreground' : ''}`} />
          </MessageAction>
          <MessageAction
            disabled={!canRegenerate || regenerating}
            label="重新生成"
            onClick={onRegenerate}
            tooltip="重新生成"
          >
            <ArrowsRotateLeft className={`size-3.5 ${regenerating ? 'animate-spin' : ''}`} />
          </MessageAction>
          <MessageAction
            disabled={!parsed}
            label="详情"
            onClick={() => parsed && onOpenDetails(parsed)}
            startsGroup
            tooltip="详情"
          >
            <CircleInfo className="size-3.5" />
          </MessageAction>
        </MessageActions>
      </div>
    </div>
  )
}

export function UsageDetailsModal({
  data,
  modelInfoByKey,
  onClose,
}: {
  data: AgentMessageMetadata
  modelInfoByKey: Map<string, AIModelInfo>
  onClose: () => void
}) {
  const rows = buildUsageDetailRows(data, modelInfoByKey)

  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) onClose() }}>
        <Modal.Container className="px-3 sm:px-6" placement="center">
          <Modal.Dialog aria-label="AI 用量详情" className="w-fit! max-w-[calc(100vw-24px)]! overflow-hidden! border-0! bg-transparent! p-0! shadow-none! sm:max-w-260!">
            <Table>
              <Table.ScrollContainer className="max-h-[calc(100vh-124px)] overflow-auto">
                <Table.Content aria-label="AI 用量详情" className="min-w-150">
                  <Table.Header>
                    <Table.Column isRowHeader>项目</Table.Column>
                    <Table.Column>值</Table.Column>
                    <Table.Column>说明</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {rows.map((row) => (
                      <Table.Row id={row.id} key={row.id}>
                        <Table.Cell className="font-medium text-foreground">{row.label}</Table.Cell>
                        <Table.Cell>{row.value}</Table.Cell>
                        <Table.Cell className="text-muted-foreground">{row.note || ''}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
              <Table.Footer className="justify-end">
                <HeroButton size="sm" variant="secondary" onPress={onClose}>关闭</HeroButton>
              </Table.Footer>
            </Table>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

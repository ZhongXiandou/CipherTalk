import { useEffect, useMemo, useState } from 'react'
import {
  AlertDialog,
  Button,
  ButtonGroup,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Skeleton,
  Surface,
  Table,
  TextArea,
  Toolbar,
  Typography,
} from '@heroui/react'
import { Check, Download, Eye, Pencil, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import type { AgentMemoryItem } from '../../../types/electron'

interface MemoryTabProps {
  showMessage: (text: string, success: boolean) => void
}

function kindLabel(kind: string) {
  if (kind === 'profile') return '画像'
  if (kind === 'fact') return '事实'
  if (kind === 'relationship') return '关系'
  return kind
}

function memoryKindFromValue(value: unknown): 'profile' | 'fact' | 'relationship' {
  if (value === 'profile') return 'profile'
  if (value === 'relationship') return 'relationship'
  return 'fact'
}

function formatTime(value: number): string {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN')
}

function isPendingMemory(item: AgentMemoryItem): boolean {
  return item.tags?.includes('pending')
}

type MemoryDraft = {
  content: string
  sourceType: 'profile' | 'fact' | 'relationship'
  importance: number
  confidence: number
  tagsText: string
}

type MemoryFilter = 'all' | 'auto' | 'pending' | 'high'

export default function MemoryTab({ showMessage }: MemoryTabProps) {
  const [items, setItems] = useState<AgentMemoryItem[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [filter, setFilter] = useState<MemoryFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const filteredItems = useMemo(() => {
    if (filter === 'auto') return items.filter((item) => item.tags?.includes('auto'))
    if (filter === 'pending') return items.filter(isPendingMemory)
    if (filter === 'high') return items.filter((item) => item.importance >= 0.75 && item.confidence >= 0.75)
    return items
  }, [filter, items])

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) || null,
    [items, selectedId],
  )

  const load = async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.memory.list({ sourceTypes: ['profile', 'fact', 'relationship'], limit: 500 })
      if (res.success) {
        const merged = [...(res.items ?? [])]
          .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
        setItems(merged)
        setCount(merged.length)
      } else {
        showMessage(res.error || '加载记忆失败', false)
      }
    } catch {
      showMessage('加载记忆失败', false)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const handleDelete = async (id: number) => {
    const res = await window.electronAPI.memory.delete(id)
    if (res.success) {
      setItems((prev) => prev.filter((m) => m.id !== id))
      setCount((c) => Math.max(0, c - 1))
      if (selectedId === id) setSelectedId(null)
    } else {
      showMessage(res.error || '删除失败', false)
    }
  }

  const startEdit = (item: AgentMemoryItem) => {
    setEditingId(item.id)
    setDraft({
      content: item.content,
      sourceType: memoryKindFromValue(item.sourceType),
      importance: item.importance,
      confidence: item.confidence,
      tagsText: item.tags.join(', '),
    })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraft(null)
  }

  const handleSave = async (id: number) => {
    if (!draft) return
    const content = draft.content.trim()
    if (!content) {
      showMessage('记忆内容不能为空', false)
      return
    }
    const tags = draft.tagsText
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
    try {
      const res = await window.electronAPI.memory.update({
        id,
        sourceType: draft.sourceType,
        content,
        importance: draft.importance,
        confidence: draft.confidence,
        tags,
      })
      if (res.success && res.item) {
        setItems((prev) => prev.map((m) => (m.id === id ? res.item! : m)))
        cancelEdit()
        showMessage('记忆已更新', true)
      } else {
        showMessage(res.error || '更新失败', false)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showMessage(message.includes('No handler registered')
        ? '记忆保存 IPC 尚未加载，请重启应用后再试'
        : `更新失败：${message}`, false)
    }
  }

  const handleConsolidate = async () => {
    const res = await window.electronAPI.memory.consolidate()
    if (res.success) {
      showMessage(`整理完成，清理 ${res.result?.removed ?? 0} 条`, true)
      void load()
    } else {
      showMessage(res.error || '整理失败', false)
    }
  }

  const handleConfirmMemory = async (item: AgentMemoryItem) => {
    const tags = (item.tags || []).filter((tag) => tag !== 'pending')
    const res = await window.electronAPI.memory.update({
      id: item.id,
      sourceType: memoryKindFromValue(item.sourceType),
      content: item.content,
      importance: Math.max(item.importance, 0.75),
      confidence: Math.max(item.confidence, 0.85),
      tags,
    })
    if (res.success && res.item) {
      setItems((prev) => prev.map((m) => (m.id === item.id ? res.item! : m)))
      showMessage('已确认自动记忆', true)
    } else {
      showMessage(res.error || '确认失败', false)
    }
  }

  const handleExportMarkdown = async () => {
    try {
      const picked = await window.electronAPI.dialog.openFile({ title: '选择记忆导出目录', properties: ['openDirectory'] })
      if (picked.canceled || picked.filePaths.length === 0) return
      const res = await window.electronAPI.memory.exportMarkdown(picked.filePaths[0])
      if (res.success) {
        showMessage(`已导出 ${res.result?.itemCount ?? 0} 条记忆`, true)
      } else {
        showMessage(res.error || '导出失败', false)
      }
    } catch {
      showMessage('导出失败', false)
    }
  }

  return (
    <>
      <Surface className="mb-4 flex items-center justify-between gap-4" variant="transparent">
        <div>
          <Chip color="accent" size="sm" variant="soft">{count} 条</Chip>
          <Chip size="sm" variant="soft">画像 / 事实</Chip>
          <Description>
            AI 跨对话记住的关于你的画像、偏好和事实。内容存放在缓存目录的 memory-bank Markdown 文件夹，可在此查看、修改或删除。
          </Description>
        </div>
        <Toolbar aria-label="记忆操作">
          <Button variant="secondary" onPress={() => void handleExportMarkdown()}>
            <Download />
            导出 Markdown
          </Button>
          <Button isDisabled={loading} variant="secondary" onPress={() => void load()}>
            <RefreshCw />
            刷新
          </Button>
          <Button variant="secondary" onPress={() => void handleConsolidate()}>
            <Sparkles />
            整理去冗余
          </Button>
        </Toolbar>
      </Surface>

      <Surface className="mb-4 flex flex-wrap items-center gap-2" variant="transparent">
        <ButtonGroup variant="tertiary">
          <Button onPress={() => setFilter('all')} variant={filter === 'all' ? 'secondary' : 'tertiary'}>全部</Button>
          <Button onPress={() => setFilter('auto')} variant={filter === 'auto' ? 'secondary' : 'tertiary'}>自动</Button>
          <Button onPress={() => setFilter('pending')} variant={filter === 'pending' ? 'secondary' : 'tertiary'}>待确认</Button>
          <Button onPress={() => setFilter('high')} variant={filter === 'high' ? 'secondary' : 'tertiary'}>高重要度</Button>
        </ButtonGroup>
        <Description>当前显示 {filteredItems.length} / {count} 条。</Description>
      </Surface>

      {filteredItems.length === 0 ? (
        <Surface variant="transparent">
          {loading ? (
            <>
              <Skeleton className="h-5 w-48 rounded-lg" />
              <Skeleton className="h-4 w-80 rounded-lg" />
              <Skeleton className="h-4 w-64 rounded-lg" />
            </>
          ) : (
            <Typography.Paragraph color="muted">
              还没有任何长期记忆。和 AI 聊聊你的偏好 / 身份，它会自动记下来。
            </Typography.Paragraph>
          )}
        </Surface>
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="AI 长期记忆">
              <Table.Header>
                <Table.Column isRowHeader>内容</Table.Column>
                <Table.Column>类型</Table.Column>
                <Table.Column>重要度</Table.Column>
                <Table.Column>置信度</Table.Column>
                <Table.Column>标签</Table.Column>
                <Table.Column>关于</Table.Column>
                <Table.Column>操作</Table.Column>
              </Table.Header>
              <Table.Body>
                {filteredItems.map((m) => {
                  const isEditing = editingId === m.id && draft
                  return (
                    <Table.Row key={m.id} id={m.id} textValue={m.content}>
                      <Table.Cell>
                        {isEditing ? (
                          <TextArea
                            aria-label="记忆内容"
                            fullWidth
                            rows={3}
                            value={draft.content}
                            variant="secondary"
                            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                          />
                        ) : (
                          <Typography.Paragraph size="sm">{m.content}</Typography.Paragraph>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {isEditing ? (
                          <Select
                            aria-label="记忆类型"
                            fullWidth
                            value={draft.sourceType}
                            variant="secondary"
                            onChange={(value) => setDraft({ ...draft, sourceType: memoryKindFromValue(value) })}
                          >
                            <Select.Trigger>
                              <Select.Value />
                              <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover>
                              <ListBox>
                                <ListBox.Item id="profile" textValue="画像">
                                  画像
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                                <ListBox.Item id="fact" textValue="事实">
                                  事实
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                                <ListBox.Item id="relationship" textValue="关系">
                                  关系
                                  <ListBox.ItemIndicator />
                                </ListBox.Item>
                              </ListBox>
                            </Select.Popover>
                          </Select>
                        ) : (
                          <Chip size="sm">{kindLabel(m.sourceType)}</Chip>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {isEditing ? (
                          <NumberField
                            aria-label="重要度"
                            maxValue={1}
                            minValue={0}
                            step={0.05}
                            value={draft.importance}
                            variant="secondary"
                            onChange={(value) => setDraft({ ...draft, importance: value ?? 0 })}
                          >
                            <Label>重要度</Label>
                            <NumberField.Group>
                              <NumberField.DecrementButton />
                              <NumberField.Input />
                              <NumberField.IncrementButton />
                            </NumberField.Group>
                          </NumberField>
                        ) : (
                          <Typography type="body-sm">{Math.round(m.importance * 100) / 100}</Typography>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {isEditing ? (
                          <NumberField
                            aria-label="置信度"
                            maxValue={1}
                            minValue={0}
                            step={0.05}
                            value={draft.confidence}
                            variant="secondary"
                            onChange={(value) => setDraft({ ...draft, confidence: value ?? 0 })}
                          >
                            <Label>置信度</Label>
                            <NumberField.Group>
                              <NumberField.DecrementButton />
                              <NumberField.Input />
                              <NumberField.IncrementButton />
                            </NumberField.Group>
                          </NumberField>
                        ) : (
                          <Typography type="body-sm">{Math.round(m.confidence * 100) / 100}</Typography>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {isEditing ? (
                          <Input
                            aria-label="记忆标签"
                            fullWidth
                            placeholder="用逗号分隔"
                            value={draft.tagsText}
                            variant="secondary"
                            onChange={(event) => setDraft({ ...draft, tagsText: event.target.value })}
                          />
                        ) : (
                          <>
                            {m.tags?.includes('auto') && <Chip size="sm">自动</Chip>}
                            {m.tags?.includes('pending') && <Chip color="warning" size="sm" variant="soft">待确认</Chip>}
                            {m.tags?.filter((tag) => tag !== 'auto').map((tag) => (
                              tag === 'pending' ? null : <Chip key={tag} size="sm">{tag}</Chip>
                            ))}
                          </>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {m.sessionId ? <Typography type="body-sm" truncate>关于 {m.sessionId}</Typography> : <Typography type="body-sm" color="muted">全局</Typography>}
                      </Table.Cell>
                      <Table.Cell>
                        <ButtonGroup variant="tertiary">
                          <Button isIconOnly aria-label="查看详情" onPress={() => setSelectedId(m.id)}>
                            <Eye />
                          </Button>
                          {!isEditing && isPendingMemory(m) && (
                            <Button isIconOnly aria-label="确认这条自动记忆" onPress={() => void handleConfirmMemory(m)}>
                              <Check />
                            </Button>
                          )}
                          {isEditing ? (
                            <>
                              <Button isIconOnly aria-label="保存修改" onPress={() => void handleSave(m.id)}>
                                <Check />
                              </Button>
                              <Button isIconOnly aria-label="取消编辑" onPress={cancelEdit}>
                                <X />
                              </Button>
                            </>
                          ) : (
                            <Button isIconOnly aria-label="编辑这条记忆" onPress={() => startEdit(m)}>
                              <Pencil />
                            </Button>
                          )}
                          <AlertDialog>
                            <Button isIconOnly aria-label="删除这条记忆" variant="danger">
                              <Trash2 />
                            </Button>
                            <AlertDialog.Backdrop>
                              <AlertDialog.Container>
                                <AlertDialog.Dialog>
                                  <AlertDialog.CloseTrigger />
                                  <AlertDialog.Header>
                                    <AlertDialog.Icon status="danger" />
                                    <AlertDialog.Heading>删除这条记忆？</AlertDialog.Heading>
                                  </AlertDialog.Header>
                                  <AlertDialog.Body>
                                    <Typography.Paragraph size="sm">
                                      删除后，AI 不会再把这条内容作为长期记忆参考。此操作不可撤销。
                                    </Typography.Paragraph>
                                    <Typography.Paragraph size="sm" color="muted">
                                      {m.content}
                                    </Typography.Paragraph>
                                  </AlertDialog.Body>
                                  <AlertDialog.Footer>
                                    <Button slot="close" variant="tertiary">取消</Button>
                                    <Button slot="close" variant="danger" onPress={() => void handleDelete(m.id)}>
                                      删除
                                    </Button>
                                  </AlertDialog.Footer>
                                </AlertDialog.Dialog>
                              </AlertDialog.Container>
                            </AlertDialog.Backdrop>
                          </AlertDialog>
                        </ButtonGroup>
                      </Table.Cell>
                    </Table.Row>
                  )
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
      {selectedItem && (
        <Surface className="mt-4 space-y-2" variant="transparent">
          <div className="flex items-center justify-between gap-3">
            <Typography.Heading level={3} className="text-lg font-semibold text-foreground">
              记忆详情 #{selectedItem.id}
            </Typography.Heading>
            <Button isIconOnly aria-label="关闭详情" variant="tertiary" onPress={() => setSelectedId(null)}>
              <X />
            </Button>
          </div>
          <div className="grid gap-2 text-sm md:grid-cols-2">
            <Typography.Paragraph size="sm">类型：{kindLabel(selectedItem.sourceType)}</Typography.Paragraph>
            <Typography.Paragraph size="sm">关于：{selectedItem.sessionId || selectedItem.contactId || selectedItem.groupId || '全局'}</Typography.Paragraph>
            <Typography.Paragraph size="sm">重要度：{selectedItem.importance.toFixed(2)}</Typography.Paragraph>
            <Typography.Paragraph size="sm">置信度：{selectedItem.confidence.toFixed(2)}</Typography.Paragraph>
            <Typography.Paragraph size="sm">创建：{formatTime(selectedItem.createdAt)}</Typography.Paragraph>
            <Typography.Paragraph size="sm">更新：{formatTime(selectedItem.updatedAt)}</Typography.Paragraph>
          </div>
          <Typography.Paragraph size="sm">{selectedItem.content}</Typography.Paragraph>
          {selectedItem.sourceRefs && selectedItem.sourceRefs.length > 0 && (
            <div className="space-y-1">
              <Typography.Paragraph size="sm" color="muted">证据引用</Typography.Paragraph>
              {selectedItem.sourceRefs.map((ref) => (
                <Typography.Paragraph key={`${ref.sessionId}:${ref.localId}:${ref.sortSeq}`} size="sm" color="muted">
                  {ref.sessionId} / {ref.localId} / {ref.excerpt || '无摘要'}
                </Typography.Paragraph>
              ))}
            </div>
          )}
        </Surface>
      )}
    </>
  )
}

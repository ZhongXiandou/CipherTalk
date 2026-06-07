import { useEffect, useState } from 'react'
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
import { Check, Pencil, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import type { AgentMemoryItem } from '../../../types/electron'

interface MemoryTabProps {
  showMessage: (text: string, success: boolean) => void
}

function kindLabel(kind: string) {
  if (kind === 'profile') return '画像'
  if (kind === 'fact') return '事实'
  return kind
}

function memoryKindFromValue(value: unknown): 'profile' | 'fact' {
  return value === 'profile' ? 'profile' : 'fact'
}

type MemoryDraft = {
  content: string
  sourceType: 'profile' | 'fact'
  importance: number
  tagsText: string
}

export default function MemoryTab({ showMessage }: MemoryTabProps) {
  const [items, setItems] = useState<AgentMemoryItem[]>([])
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<MemoryDraft | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [profileRes, factRes] = await Promise.all([
        window.electronAPI.memory.list({ sourceType: 'profile', limit: 300 }),
        window.electronAPI.memory.list({ sourceType: 'fact', limit: 300 }),
      ])
      if (profileRes.success && factRes.success) {
        const merged = [...(profileRes.items ?? []), ...(factRes.items ?? [])]
          .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)
        setItems(merged)
        setCount(merged.length)
      } else {
        showMessage(profileRes.error || factRes.error || '加载记忆失败', false)
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
    } else {
      showMessage(res.error || '删除失败', false)
    }
  }

  const startEdit = (item: AgentMemoryItem) => {
    setEditingId(item.id)
    setDraft({
      content: item.content,
      sourceType: item.sourceType === 'profile' ? 'profile' : 'fact',
      importance: item.importance,
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

  return (
    <>
      <Surface className="mb-4 flex items-center justify-between gap-4" variant="transparent">
        <div>
          <Chip color="accent" size="sm" variant="soft">{count} 条</Chip>
          <Chip size="sm" variant="soft">画像 / 事实</Chip>
          <Description>
            AI 跨对话记住的关于你的画像、偏好和事实。由 AI 在对话中自动记录，可在此查看、修改或删除。
          </Description>
        </div>
        <Toolbar aria-label="记忆操作">
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

      {items.length === 0 ? (
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
                <Table.Column>标签</Table.Column>
                <Table.Column>关于</Table.Column>
                <Table.Column>操作</Table.Column>
              </Table.Header>
              <Table.Body>
                {items.map((m) => {
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
                            {m.tags?.filter((tag) => tag !== 'auto').map((tag) => (
                              <Chip key={tag} size="sm">{tag}</Chip>
                            ))}
                          </>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {m.sessionId ? <Typography type="body-sm" truncate>关于 {m.sessionId}</Typography> : <Typography type="body-sm" color="muted">全局</Typography>}
                      </Table.Cell>
                      <Table.Cell>
                        <ButtonGroup variant="tertiary">
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
    </>
  )
}

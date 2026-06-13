import { User, Users, MessageSquare } from 'lucide-react'
import { Spinner, ListBox, Avatar, Chip, Label, Description, Typography, type Selection } from '@heroui/react'
import type { Contact } from '../types'
import { getAvatarLetter } from '../utils'

interface ContactListProps {
  isLoading: boolean
  contacts: Contact[]
  selectedContacts: Set<string>
  onSelectionChange: (next: Set<string>) => void
}

function contactTypeIcon(type: string) {
  switch (type) {
    case 'friend': return <User size={12} />
    case 'group': return <Users size={12} />
    case 'official': return <MessageSquare size={12} />
    default: return <User size={12} />
  }
}

function contactTypeName(type: string) {
  switch (type) {
    case 'friend': return '好友'
    case 'group': return '群聊'
    case 'official': return '公众号'
    default: return '其他'
  }
}

export default function ContactList({ isLoading, contacts, selectedContacts, onSelectionChange }: ContactListProps) {
  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <Spinner size="md" />
        <Typography type="body-sm">加载中...</Typography>
      </div>
    )
  }

  if (contacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Typography type="body-sm">暂无联系人</Typography>
      </div>
    )
  }

  const shown = contacts.slice(0, 100)
  const visibleSet = new Set(shown.map(c => c.username))
  const selectedVisible = new Set([...selectedContacts].filter(u => visibleSet.has(u)))

  const handleChange = (keys: Selection) => {
    const next = keys === 'all' ? new Set(visibleSet) : new Set(Array.from(keys, String))
    for (const u of selectedContacts) if (!visibleSet.has(u)) next.add(u)
    onSelectionChange(next)
  }

  return (
    <>
      <ListBox
        aria-label="联系人列表"
        selectionMode="multiple"
        selectedKeys={selectedVisible}
        onSelectionChange={handleChange}
        className="w-full"
      >
        {shown.map(contact => (
          <ListBox.Item
            key={contact.username}
            id={contact.username}
            textValue={contact.displayName}
            className="data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-soft-foreground"
          >
            <Avatar size="sm">
              {contact.avatarUrl && <Avatar.Image alt="" loading="lazy" src={contact.avatarUrl} />}
              <Avatar.Fallback>{getAvatarLetter(contact.displayName)}</Avatar.Fallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <Label className="truncate">{contact.displayName}</Label>
              {contact.remark && contact.remark !== contact.displayName && (
                <Description className="truncate">备注: {contact.remark}</Description>
              )}
            </div>
            <Chip variant="secondary" size="sm" className="shrink-0">
              {contactTypeIcon(contact.type)}
              {contactTypeName(contact.type)}
            </Chip>
            <ListBox.ItemIndicator />
          </ListBox.Item>
        ))}
      </ListBox>
      {contacts.length > 100 && (
        <Typography type="body-sm" className="py-2 text-center text-muted">
          还有 {contacts.length - 100} 个联系人...
        </Typography>
      )}
    </>
  )
}

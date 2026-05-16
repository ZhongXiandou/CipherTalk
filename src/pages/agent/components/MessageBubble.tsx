import { useState, useRef, useEffect } from 'react'
import { Bot, Check, Copy, Database, FileText, Hash, RefreshCw, Share2, User } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import AIProviderLogo from '../../../components/ai/AIProviderLogo'
import type { AssistantBlock, Message, TextBlock } from '../types'
import { AssistantBlocks } from './AssistantBlocks'
import { ShareModal } from './ShareModal'

interface Props {
  message: Message
  userMessage?: Message
  onCancel?: () => void
  onRegenerate?: () => void
  aiProvider?: string
}

function extractMarkdown(blocks: AssistantBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n\n')
}

function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*(.+?)\*/gs, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, m => m.replace(/```\w*\n?/g, '').trim())
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '---')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch(() => {})
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  const handle = () => {
    copyText(text)
    setDone(true)
    setTimeout(() => setDone(false), 1800)
  }
  return (
    <button type="button" className="agent-action-btn" title="复制" onClick={handle}>
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function CopyDropdown({ blocks }: { blocks: AssistantBlock[] }) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const copy = (format: 'md' | 'txt') => {
    const md = extractMarkdown(blocks)
    copyText(format === 'txt' ? stripMarkdown(md) : md)
    setDone(true)
    setOpen(false)
    setTimeout(() => setDone(false), 1800)
  }

  return (
    <div className="agent-copy-wrap" ref={ref}>
      <button
        type="button"
        className={`agent-action-btn${open ? ' is-open' : ''}`}
        title="复制"
        onClick={() => setOpen(v => !v)}
      >
        {done ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {open && (
        <div className="agent-copy-menu">
          <button type="button" onClick={() => copy('txt')}>
            <FileText size={12} />
            纯文本
          </button>
          <button type="button" onClick={() => copy('md')}>
            <Hash size={12} />
            Markdown
          </button>
        </div>
      )}
    </div>
  )
}

export function MessageBubble({ message, userMessage, onCancel, onRegenerate, aiProvider }: Props) {
  const isUser = message.role === 'user'
  const blocks = message.blocks || (message.content ? [{ type: 'text' as const, text: message.content }] : [])
  const userInfo = useAppStore(s => s.userInfo)
  const showActions = !message.streaming
  const [showShare, setShowShare] = useState(false)

  return (
    <article className={`agent-message agent-message--${isUser ? 'user' : 'assistant'} qa-message ${isUser ? 'user' : 'assistant'}`}>
      {!isUser ? (
        <div className="agent-message__avatar" aria-hidden="true">
          {aiProvider
            ? <AIProviderLogo providerId={aiProvider} alt={aiProvider} size={22} />
            : <Bot size={18} />
          }
        </div>
      ) : (
        <div className="agent-message__user-avatar" aria-hidden="true">
          {userInfo?.avatarUrl
            ? <img src={userInfo.avatarUrl} alt="" />
            : <User size={15} />
          }
        </div>
      )}

      {isUser ? (
        <div className="agent-message__user-content">
          {message.attached && message.attached.length > 0 && (
            <div className="agent-user-attached">
              {message.attached.map(r => (
                <div key={r.id} className="agent-user-attached-chip">
                  <Database size={11} />
                  <span>{r.label}</span>
                </div>
              ))}
            </div>
          )}
          <div className="agent-message__user-bubble qa-bubble">
            <span>{message.content}</span>
          </div>
          {showActions && (
            <div className="agent-message__actions agent-message__actions--user">
              <CopyButton text={message.content || ''} />
            </div>
          )}
        </div>
      ) : (
        <div className="agent-message__assistant-body qa-message-body">
          <AssistantBlocks blocks={blocks} streaming={message.streaming} onStop={onCancel} />
          {showActions && (
            <div className="agent-message__actions agent-message__actions--assistant">
              <CopyDropdown blocks={blocks} />
              <button type="button" className="agent-action-btn" title="重新生成" onClick={onRegenerate}>
                <RefreshCw size={13} />
              </button>
              <button type="button" className="agent-action-btn" title="分享" onClick={() => setShowShare(true)}>
                <Share2 size={13} />
              </button>
              {showShare && (
                <ShareModal
                  message={message}
                  userMessage={userMessage}
                  aiProvider={aiProvider}
                  onClose={() => setShowShare(false)}
                />
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

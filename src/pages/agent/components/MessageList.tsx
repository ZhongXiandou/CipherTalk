import { useEffect, useRef } from 'react'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'
import type { Message } from '../types'

interface Props {
  messages: Message[]
  loading: boolean
  onCancel?: () => void
}

export function MessageList({ messages, loading, onCancel }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, loading])

  const hasStreamingMessage = messages.some(message => message.streaming)

  return (
    <div className="agent-message-list" ref={scrollRef}>
      <div className="agent-message-list__inner">
        <div className="agent-message-list__items">
          {messages.length === 0 && !loading ? (
            <div className="agent-empty-state">暂无对话内容</div>
          ) : null}
          {messages.map(msg => (
            <MessageBubble key={msg.id} message={msg} onCancel={onCancel} />
          ))}
          {loading && !hasStreamingMessage && <TypingIndicator onCancel={onCancel} />}
        </div>
        <div className="agent-message-list__end" ref={bottomRef} />
      </div>
    </div>
  )
}

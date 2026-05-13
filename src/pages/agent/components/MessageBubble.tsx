import { Bot, User } from 'lucide-react'
import type { Message } from '../types'
import { AssistantBlocks } from './AssistantBlocks'

interface Props {
  message: Message
  onCancel?: () => void
}

export function MessageBubble({ message, onCancel }: Props) {
  const isUser = message.role === 'user'
  const blocks = message.blocks || (message.content ? [{ type: 'text' as const, text: message.content }] : [])

  return (
    <article className={`agent-message agent-message--${isUser ? 'user' : 'assistant'} qa-message ${isUser ? 'user' : 'assistant'}`}>
      {!isUser ? (
        <div className="agent-message__avatar" aria-hidden="true">
          <Bot size={16} />
        </div>
      ) : null}

      {isUser ? (
        <div className="agent-message__user-bubble qa-bubble">
          <User size={14} />
          <span>{message.content}</span>
        </div>
      ) : (
        <div className="agent-message__assistant-body qa-message-body">
          <AssistantBlocks blocks={blocks} streaming={message.streaming} onStop={onCancel} />
        </div>
      )}
    </article>
  )
}

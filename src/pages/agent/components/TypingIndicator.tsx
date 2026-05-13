import { Bot } from 'lucide-react'
import { AssistantBlocks } from './AssistantBlocks'

export function TypingIndicator({ onCancel }: { onCancel?: () => void }) {
  return (
    <article className="agent-message agent-message--assistant qa-message assistant">
      <div className="agent-message__avatar" aria-hidden="true">
        <Bot size={16} />
      </div>
      <div className="agent-message__assistant-body qa-message-body">
        <AssistantBlocks
          streaming
          onStop={onCancel}
          blocks={[
            {
              type: 'thinking',
              text: '准备生成回复',
              streaming: true,
            },
            {
              type: 'tool',
              name: 'agent_runtime',
              status: 'running',
              args: { task: 'compose_answer' },
            },
          ]}
        />
      </div>
    </article>
  )
}

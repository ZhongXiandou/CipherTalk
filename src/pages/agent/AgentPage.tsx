import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import { Bot } from 'lucide-react'
import { MessageList } from './components/MessageList'
import { ChatInput } from './components/ChatInput'
import { useAgentChat } from './hooks/useAgentChat'

function AgentPage() {
  const { messages, loading, send } = useAgentChat()

  return (
    <Box sx={{ display: 'flex', height: '100%' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, p: 3 }}>
        <Box sx={{ mb: 2 }}>
          <Typography
            variant="h6"
            sx={{ fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 1 }}
          >
            <Bot size={22} />
            Agent 对话
          </Typography>
          <Typography variant="body2" sx={{ color: 'var(--text-secondary)', mt: 0.5 }}>
            与 AI 助手对话，分析你的聊天数据
          </Typography>
        </Box>

        <MessageList messages={messages} loading={loading} />
        <ChatInput onSend={send} disabled={loading} />
      </Box>
    </Box>
  )
}

export default AgentPage

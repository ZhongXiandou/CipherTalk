import { useState } from 'react'
import { MessageList } from './components/MessageList'
import { ChatInput } from './components/ChatInput'
import { AgentSidebar } from './components/AgentSidebar'
import { useAgentChat } from './hooks/useAgentChat'
import { useMcpSkillsData } from '../../hooks/useMcpSkillsData'
import { AGENT_ATTACH_MENU, AGENT_HISTORY, AGENT_SLASH_COMMANDS, AGENT_SUGGESTIONS } from './data'
import './AgentPage.scss'

function AgentPage() {
  const { messages, loading, send, cancel } = useAgentChat()
  const { mcpServers, skills, busyServers, toggleServer } = useMcpSkillsData()
  const [collapsed, setCollapsed] = useState(false)
  const [activeConversationId, setActiveConversationId] = useState('new')
  const [query, setQuery] = useState('')

  return (
    <div className="agent-page">
      <AgentSidebar
        collapsed={collapsed}
        conversations={AGENT_HISTORY}
        activeId={activeConversationId}
        query={query}
        onQueryChange={setQuery}
        onToggle={() => setCollapsed(value => !value)}
        onSelect={setActiveConversationId}
      />
      <main className="agent-main" aria-label="Agent 对话">
        <MessageList
          messages={messages}
          loading={loading}
          onCancel={cancel}
        />
        <ChatInput
          onSend={send}
          disabled={loading}
          suggestions={AGENT_SUGGESTIONS}
          slashCommands={AGENT_SLASH_COMMANDS}
          attachMenu={AGENT_ATTACH_MENU}
          mcpServers={mcpServers}
          busyServers={busyServers}
          onToggleServer={toggleServer}
          skills={skills}
        />
      </main>
    </div>
  )
}

export default AgentPage

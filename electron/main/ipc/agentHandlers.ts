import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

const requestMap = new Map<string, AbortController>()

function genRequestId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function registerAgentHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('agent:sendMessage', async (event, options: {
    requestId?: string
    conversationId?: number
    history: Array<{ role: string; content: string }>
    message: string
    provider: string
    apiKey: string
    model: string
    enableThinking?: boolean
    systemPrompt?: string
    enabledTools?: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>
  }) => {
    const requestId = options.requestId?.trim() || genRequestId()
    if (requestMap.has(requestId)) {
      return { success: false, requestId, error: '相同 requestId 的请求已存在' }
    }

    const controller = new AbortController()
    requestMap.set(requestId, controller)

    let convId: number | undefined = options.conversationId

    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      const { agentChatService } = await import('../../services/agentChatService')

      if (agentConversationDb.isInitialized()) {
        if (!convId) {
          const firstLine = options.message.slice(0, 20) || '新对话'
          convId = agentConversationDb.createConversation(firstLine)
        }
        agentConversationDb.appendMessage(convId, 'user', options.message)
      }

      void (async () => {
        let assistantText = ''
        try {
          assistantText = await agentChatService.sendMessage({
            history: options.history as any,
            message: options.message,
            provider: options.provider,
            apiKey: options.apiKey,
            model: options.model,
            enableThinking: options.enableThinking !== false,
            systemPrompt: options.systemPrompt,
            signal: controller.signal,
            enabledTools: options.enabledTools as any,
            onStreamEvent: (streamEvent) => {
              event.sender.send('agent:streamEvent', { requestId, event: streamEvent })
            },
            mcpCallTool: async (serverName, toolName, args) => {
              try {
                const { mcpClientService } = await import('../../services/mcpClientService')
                return await mcpClientService.callTool(serverName, toolName, args)
              } catch (e) {
                return { success: false, error: String(e) }
              }
            }
          })

          if (convId && agentConversationDb.isInitialized()) {
            agentConversationDb.appendMessage(convId, 'assistant', assistantText)
          }

          event.sender.send('agent:done', { requestId, conversationId: convId })
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg !== 'Aborted') {
            ctx.getLogService()?.error('Agent', '对话失败', { error: msg })
            event.sender.send('agent:error', { requestId, message: msg })
          } else {
            event.sender.send('agent:done', { requestId, conversationId: convId })
          }
        } finally {
          requestMap.delete(requestId)
        }
      })()

      return { success: true, requestId, conversationId: convId }
    } catch (e) {
      requestMap.delete(requestId)
      return { success: false, requestId, error: String(e) }
    }
  })

  ipcMain.handle('agent:cancel', async (_, requestId: string) => {
    const controller = requestMap.get(requestId)
    if (controller) {
      controller.abort()
      requestMap.delete(requestId)
      return { success: true }
    }
    return { success: false, error: '未找到对应请求' }
  })

  ipcMain.handle('agent:listConversations', async () => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: true, conversations: [] }
      return { success: true, conversations: agentConversationDb.listConversations() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:loadConversation', async (_, id: number) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      return { success: true, messages: agentConversationDb.getMessages(id) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:deleteConversation', async (_, id: number) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      agentConversationDb.deleteConversation(id)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:newConversation', async () => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      const id = agentConversationDb.createConversation()
      return { success: true, id }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:updateTitle', async (_, id: number, title: string) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      agentConversationDb.updateTitle(id, title)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}

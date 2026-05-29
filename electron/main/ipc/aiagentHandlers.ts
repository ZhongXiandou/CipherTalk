import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { conversationStore } from '../../services/aiagent/conversationStore'
import { aiagentJobService } from '../../services/aiagent/jobService'
import { generateTitle } from '../../services/aiagent/providers'
import type { ConversationRequest, ProviderCfg, Scope } from '../../services/aiagent/types'

type LocalMessageInput = {
  role: 'user' | 'assistant'
  content?: string
  blocks?: unknown[]
}

function ensureStoreReady(): { success: true } | { success: false; error: string } {
  if (conversationStore.isInitialized()) return { success: true }
  return { success: false, error: 'AI Agent 会话数据库未初始化' }
}

export function registerAiAgentHandlers(_ctx: MainProcessContext): void {
  ipcMain.handle('aiagent:send', async (event, request: ConversationRequest) => {
    try {
      return aiagentJobService.start(request, event.sender)
    } catch (error) {
      return {
        success: false,
        requestId: request?.requestId || '',
        error: String(error)
      }
    }
  })

  ipcMain.handle('aiagent:cancel', async (_, requestId: string) => {
    try {
      return await aiagentJobService.cancel(requestId)
    } catch (error) {
      return { success: false, requestId, error: String(error) }
    }
  })

  ipcMain.handle('aiagent:listConversations', async (_, scope: Scope) => {
    try {
      const ready = ensureStoreReady()
      if (!ready.success) return ready
      return { success: true, conversations: conversationStore.listConversations(scope) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('aiagent:loadConversation', async (_, id: number) => {
    try {
      const ready = ensureStoreReady()
      if (!ready.success) return ready
      const conversation = conversationStore.loadConversation(id)
      return conversation
        ? { success: true, conversation }
        : { success: false, error: '会话不存在' }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('aiagent:newConversation', async (_, scope: Scope, title?: string) => {
    try {
      const ready = ensureStoreReady()
      if (!ready.success) return ready
      const id = conversationStore.createConversation(scope, title)
      const conversation = conversationStore.loadConversation(id)
      return { success: true, id, conversation }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('aiagent:deleteConversation', async (_, id: number) => {
    try {
      const ready = ensureStoreReady()
      if (!ready.success) return ready
      conversationStore.deleteConversation(id)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('aiagent:updateTitle', async (_, id: number, title: string) => {
    try {
      const ready = ensureStoreReady()
      if (!ready.success) return ready
      conversationStore.updateTitle(id, title)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('aiagent:getLastConversationId', async (_, scope: Scope) => {
    try {
      const ready = ensureStoreReady()
      if (!ready.success) return ready
      const id = conversationStore.getLastConversationId(scope)
      return { success: true, id: id ?? undefined }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('aiagent:appendLocalMessages', async (_, options: {
    conversationId?: number
    scope: Scope
    messages: LocalMessageInput[]
  }) => {
    try {
      const ready = ensureStoreReady()
      if (!ready.success) return ready
      let conversationId = options.conversationId
      if (!conversationId || !conversationStore.hasConversation(conversationId)) {
        conversationId = conversationStore.createConversation(options.scope)
      }

      for (const message of options.messages || []) {
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const content = String(message.content || '')
        const blocksJson = Array.isArray(message.blocks) && message.blocks.length > 0
          ? JSON.stringify(message.blocks)
          : undefined
        conversationStore.appendMessage(conversationId, role, content, blocksJson)
      }

      return { success: true, conversationId }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('aiagent:generateTitle', async (_, options: {
    conversationId: number
    userMessage: string
    assistantResponse: string
    provider: ProviderCfg
  }) => {
    try {
      const title = await generateTitle(options)
      if (conversationStore.isInitialized()) {
        conversationStore.updateTitle(options.conversationId, title)
      }
      return { success: true, title }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}

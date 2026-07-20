import { CodexAppServerClient, resolveBundledCodexExecutable } from './codexAppServerClient'

export type CodexSubscriptionStatus = {
  available: boolean
  authenticated: boolean
  email?: string
  planType?: string
  requiresOpenaiAuth?: boolean
  error?: string
}

export type CodexSubscriptionModel = {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  hidden: boolean
  defaultReasoningEffort?: string
}

class CodexSubscriptionService {
  private client: CodexAppServerClient | null = null
  private statusListeners = new Set<(status: CodexSubscriptionStatus) => void>()

  onStatusChanged(listener: (status: CodexSubscriptionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async getStatus(refreshToken = false): Promise<CodexSubscriptionStatus> {
    try {
      resolveBundledCodexExecutable()
      const result = await this.getClient().request<any>('account/read', { refreshToken })
      const account = result?.account
      return {
        available: true,
        authenticated: account?.type === 'chatgpt',
        email: account?.type === 'chatgpt' && typeof account.email === 'string' ? account.email : undefined,
        planType: account?.type === 'chatgpt' ? String(account.planType || 'unknown') : undefined,
        requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth),
      }
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async startLogin(): Promise<{ loginId: string; authUrl: string }> {
    const result = await this.getClient().request<any>('account/login/start', {
      type: 'chatgpt',
    })
    if (result?.type !== 'chatgpt' || !result.loginId || !result.authUrl) {
      throw new Error('Codex App Server 未返回 ChatGPT 登录地址')
    }
    return { loginId: String(result.loginId), authUrl: String(result.authUrl) }
  }

  async logout(): Promise<void> {
    await this.getClient().request('account/logout', {})
    this.emitStatus(await this.getStatus())
  }

  async listModels(): Promise<CodexSubscriptionModel[]> {
    const status = await this.getStatus(true)
    if (!status.authenticated) throw new Error(status.error || '请先登录 ChatGPT 账号')

    const client = this.getClient()
    const models: CodexSubscriptionModel[] = []
    let cursor: string | null = null
    do {
      const result = await client.request<any>('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      })
      for (const model of Array.isArray(result?.data) ? result.data : []) {
        const id = String(model?.model || model?.id || '').trim()
        if (!id || model?.hidden === true) continue
        models.push({
          id,
          displayName: String(model?.displayName || id),
          description: String(model?.description || ''),
          isDefault: model?.isDefault === true,
          hidden: model?.hidden === true,
          defaultReasoningEffort: model?.defaultReasoningEffort ? String(model.defaultReasoningEffort) : undefined,
        })
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null
    } while (cursor)

    return models
  }

  shutdown(): void {
    this.client?.dispose()
    this.client = null
    this.statusListeners.clear()
  }

  private getClient(): CodexAppServerClient {
    if (this.client) return this.client
    const client = new CodexAppServerClient()
    client.onNotification((message) => {
      if (message.method !== 'account/updated' && message.method !== 'account/login/completed') return
      void this.getStatus().then((status) => this.emitStatus(status))
    })
    this.client = client
    return client
  }

  private emitStatus(status: CodexSubscriptionStatus): void {
    for (const listener of this.statusListeners) {
      try { listener(status) } catch { /* ignore */ }
    }
  }
}

export const codexSubscriptionService = new CodexSubscriptionService()

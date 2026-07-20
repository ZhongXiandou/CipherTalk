import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'
import readline from 'readline'
import { getCipherTalkCodexHome } from '../runtimePaths'

type JsonRpcId = number | string

export type CodexAppServerMessage = {
  id?: JsonRpcId
  method?: string
  params?: any
  result?: any
  error?: { code?: number; message?: string; data?: unknown }
}

export type CodexServerRequestHandler = (message: Required<Pick<CodexAppServerMessage, 'id' | 'method'>> & CodexAppServerMessage) => Promise<unknown>
export type CodexNotificationHandler = (message: Required<Pick<CodexAppServerMessage, 'method'>> & CodexAppServerMessage) => void

type PendingRequest = {
  resolve: (value: any) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 30_000
export const CODEX_CHATGPT_MODEL_PROVIDER = 'openai'

const TARGETS: Record<string, { packageName: string; triple: string; executable: string }> = {
  'win32:x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe' },
  'win32:arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', executable: 'codex.exe' },
  'darwin:x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', executable: 'codex' },
  'darwin:arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', executable: 'codex' },
  'linux:x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', executable: 'codex' },
  'linux:arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', executable: 'codex' },
}

function unpackedAsarPath(value: string): string {
  return value.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

export function resolveBundledCodexExecutable(): string {
  const override = String(process.env.CIPHERTALK_CODEX_PATH || '').trim()
  if (override) {
    if (!existsSync(override)) throw new Error(`CIPHERTALK_CODEX_PATH 指向的文件不存在: ${override}`)
    return override
  }

  const target = TARGETS[`${process.platform}:${process.arch}`]
  if (!target) throw new Error(`Codex 不支持当前平台: ${process.platform}/${process.arch}`)

  const require = createRequire(import.meta.url)
  let packageJsonPath = ''
  try {
    packageJsonPath = require.resolve(`${target.packageName}/package.json`)
  } catch {
    throw new Error(`缺少当前平台的 Codex 运行时依赖: ${target.packageName}`)
  }

  const executablePath = unpackedAsarPath(path.join(
    path.dirname(packageJsonPath),
    'vendor',
    target.triple,
    'bin',
    target.executable,
  ))
  if (!existsSync(executablePath)) throw new Error(`Codex 可执行文件不存在: ${executablePath}`)
  return executablePath
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private pending = new Map<JsonRpcId, PendingRequest>()
  private notificationHandlers = new Set<CodexNotificationHandler>()
  private serverRequestHandler: CodexServerRequestHandler | null = null
  private seq = 0
  private stderrTail = ''
  private disposed = false

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  setServerRequestHandler(handler: CodexServerRequestHandler | null): void {
    this.serverRequestHandler = handler
  }

  async start(): Promise<void> {
    if (this.child) return
    if (this.startPromise) return this.startPromise
    if (this.disposed) throw new Error('Codex App Server 客户端已关闭')

    this.startPromise = this.startInternal()
    try {
      await this.startPromise
    } catch (error) {
      this.startPromise = null
      throw error
    }
  }

  async request<T = any>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    await this.start()
    return this.requestStarted<T>(method, params, timeoutMs)
  }

  notify(method: string, params?: unknown): void {
    if (!this.child) throw new Error('Codex App Server 尚未启动')
    this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  dispose(): void {
    this.disposed = true
    const child = this.child
    this.child = null
    this.startPromise = null
    this.rejectPending(new Error('Codex App Server 已关闭'))
    this.notificationHandlers.clear()
    this.serverRequestHandler = null
    if (child) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    }
  }

  private async startInternal(): Promise<void> {
    const executable = resolveBundledCodexExecutable()
    const codexHome = getCipherTalkCodexHome()
    mkdirSync(codexHome, { recursive: true })
    const env = { ...process.env, CODEX_HOME: codexHome }
    delete env.OPENAI_API_KEY
    delete env.OPENAI_BASE_URL
    delete env.OPENAI_API_BASE
    const child = spawn(executable, [
      '-c',
      `model_provider="${CODEX_CHATGPT_MODEL_PROVIDER}"`,
      '-c',
      'cli_auth_credentials_store="file"',
      'app-server',
      '--listen',
      'stdio://',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    })
    this.child = child

    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => this.handleLine(line))
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-6000)
    })
    child.on('error', (error) => this.handleExit(new Error(`Codex App Server 启动失败: ${error.message}`)))
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      const detail = this.stderrTail.trim()
      this.handleExit(new Error(`Codex App Server 已退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）${detail ? `: ${detail}` : ''}`))
    })

    await this.requestStarted('initialize', {
      clientInfo: {
        name: 'ciphertalk',
        title: 'CipherTalk',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    })
    this.notify('initialized', {})
  }

  private requestStarted<T>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.child) return Promise.reject(new Error('Codex App Server 尚未启动'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex App Server 请求超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  private write(message: CodexAppServerMessage): void {
    const child = this.child
    if (!child || child.stdin.destroyed) throw new Error('Codex App Server 连接不可用')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    const text = line.trim()
    if (!text) return
    let message: CodexAppServerMessage
    try {
      message = JSON.parse(text)
    } catch {
      return
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || `Codex App Server 错误 ${message.error.code ?? ''}`.trim()))
      else pending.resolve(message.result)
      return
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message as Required<Pick<CodexAppServerMessage, 'id' | 'method'>> & CodexAppServerMessage)
      return
    }

    if (message.method) {
      for (const handler of this.notificationHandlers) {
        try { handler(message as Required<Pick<CodexAppServerMessage, 'method'>> & CodexAppServerMessage) } catch { /* ignore */ }
      }
    }
  }

  private async handleServerRequest(message: Required<Pick<CodexAppServerMessage, 'id' | 'method'>> & CodexAppServerMessage): Promise<void> {
    try {
      if (!this.serverRequestHandler) throw new Error(`未处理的 Codex App Server 请求: ${message.method}`)
      const result = await this.serverRequestHandler(message)
      this.write({ id: message.id, result })
    } catch (error) {
      this.write({
        id: message.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private handleExit(error: Error): void {
    this.child = null
    this.startPromise = null
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

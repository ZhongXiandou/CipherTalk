import type { WebContents } from 'electron'
import { Worker } from 'worker_threads'
import { getElectronWorkerEnv } from '../../services/workerEnvironment'
import { findElectronWorkerPath } from './electronWorkerPath'

type SessionMemoryBuildWorkerMessage = {
  type?: 'progress' | 'completed' | 'error'
  sessionId?: string
  progress?: any
  state?: any
  error?: string
}

type SessionMemoryBuildJob = {
  worker: Worker
  sender: WebContents
  promise: Promise<any>
}

const sessionMemoryBuildJobs = new Map<string, SessionMemoryBuildJob>()

/**
 * 会话记忆构建 Job 管理。
 * 记忆构建是长任务，同一 session 只允许一个 Worker；重复请求只更新进度接收方，
 * 防止多个 Worker 同时写入同一份记忆状态。
 */
export async function getSessionMemoryBuildStateForUi(sessionId: string) {
  const { memoryBuildService } = await import('../../services/memory/memoryBuildService')
  const state = memoryBuildService.getSessionState(sessionId)
  return {
    ...state,
    isRunning: state.isRunning || sessionMemoryBuildJobs.has(sessionId)
  }
}

function sendSessionMemoryBuildProgress(sender: WebContents, progress: any) {
  if (!sender || sender.isDestroyed()) return
  sender.send('ai:sessionMemoryBuildProgress', progress)
}

export async function startSessionMemoryBuildJob(sessionId: string, sender: WebContents) {
  const existing = sessionMemoryBuildJobs.get(sessionId)
  if (existing) {
    existing.sender = sender
    return existing.promise
  }

  const workerPath = findElectronWorkerPath('sessionMemoryBuildWorker.js')
  if (!workerPath) {
    throw new Error('未找到 sessionMemoryBuildWorker.js')
  }

  const worker = new Worker(workerPath, {
    env: getElectronWorkerEnv(),
    workerData: { sessionId }
  })

  const promise = new Promise<any>((resolve, reject) => {
    worker.on('message', (message: SessionMemoryBuildWorkerMessage) => {
      const currentJob = sessionMemoryBuildJobs.get(sessionId)
      const targetSender = currentJob?.sender || sender

      if (message?.type === 'progress' && message.progress) {
        sendSessionMemoryBuildProgress(targetSender, message.progress)
        return
      }

      if (message?.type === 'completed') {
        sessionMemoryBuildJobs.delete(sessionId)
        void worker.terminate().catch(() => undefined)
        resolve(message.state)
        return
      }

      if (message?.type === 'error') {
        sessionMemoryBuildJobs.delete(sessionId)
        void worker.terminate().catch(() => undefined)
        reject(new Error(message.error || '会话记忆构建失败'))
      }
    })

    worker.on('error', (error) => {
      sessionMemoryBuildJobs.delete(sessionId)
      reject(error)
    })

    worker.on('exit', (code) => {
      const currentJob = sessionMemoryBuildJobs.get(sessionId)
      if (!currentJob) return
      sessionMemoryBuildJobs.delete(sessionId)
      if (code !== 0) {
        reject(new Error(`会话记忆构建 Worker 异常退出，代码：${code}`))
      }
    })
  })

  sessionMemoryBuildJobs.set(sessionId, {
    worker,
    sender,
    promise
  })

  return promise
}

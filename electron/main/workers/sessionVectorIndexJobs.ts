import type { WebContents } from 'electron'
import { Worker } from 'worker_threads'
import { dataManagementService } from '../../services/dataManagementService'
import { getElectronWorkerEnv } from '../../services/workerEnvironment'
import { findElectronWorkerPath } from './electronWorkerPath'

type SessionVectorIndexWorkerMessage = {
  type?: 'progress' | 'completed' | 'error'
  sessionId?: string
  progress?: any
  state?: any
  error?: string
}

type SessionVectorIndexJob = {
  worker: Worker
  sender: WebContents
  cancelRequested: boolean
  aiPauseReleased: boolean
}

const sessionVectorIndexJobs = new Map<string, SessionVectorIndexJob>()

/**
 * 会话向量索引 Job 管理。
 * 向量化会大量读写索引文件，运行期间需要暂停数据管理自动增量同步；
 * 无论成功、失败、取消还是 Worker 异常退出，都必须释放 pause，避免后台同步永久停住。
 */
function releaseSessionVectorIndexPause(job: SessionVectorIndexJob): void {
  if (job.aiPauseReleased) return
  job.aiPauseReleased = true
  dataManagementService.resumeFromAi()
}

function finishSessionVectorIndexJob(sessionId: string, job?: SessionVectorIndexJob): SessionVectorIndexJob | null {
  const currentJob = job || sessionVectorIndexJobs.get(sessionId)
  if (!currentJob) return null

  sessionVectorIndexJobs.delete(sessionId)
  releaseSessionVectorIndexPause(currentJob)
  return currentJob
}

export async function getSessionVectorIndexStateForUi(sessionId: string) {
  const { chatSearchIndexService } = await import('../../services/search/chatSearchIndexService')
  const state = chatSearchIndexService.getSessionVectorIndexState(sessionId)
  return {
    ...state,
    isVectorRunning: state.isVectorRunning || sessionVectorIndexJobs.has(sessionId)
  }
}

function sendSessionVectorIndexProgress(sender: WebContents, progress: any) {
  if (!sender || sender.isDestroyed()) return
  sender.send('ai:sessionVectorIndexProgress', progress)
}

async function sendSessionVectorIndexFailure(sender: WebContents, sessionId: string, error: string) {
  try {
    const state = await getSessionVectorIndexStateForUi(sessionId)
    sendSessionVectorIndexProgress(sender, {
      sessionId,
      stage: 'vectorizing_messages',
      status: 'failed',
      processedCount: state.vectorizedCount || 0,
      totalCount: state.indexedCount || 0,
      message: error,
      vectorModel: state.vectorModel || ''
    })
  } catch {
    sendSessionVectorIndexProgress(sender, {
      sessionId,
      stage: 'vectorizing_messages',
      status: 'failed',
      processedCount: 0,
      totalCount: 0,
      message: error,
      vectorModel: ''
    })
  }
}

export async function startSessionVectorIndexJob(sessionId: string, sender: WebContents) {
  const existing = sessionVectorIndexJobs.get(sessionId)
  if (existing) {
    // 同一会话重复触发时只切换事件接收方，避免并发 Worker 写同一份索引。
    existing.sender = sender
    return getSessionVectorIndexStateForUi(sessionId)
  }

  const workerPath = findElectronWorkerPath('sessionVectorIndexWorker.js')
  if (!workerPath) {
    throw new Error('未找到 sessionVectorIndexWorker.js')
  }

  const worker = new Worker(workerPath, {
    env: getElectronWorkerEnv(),
    workerData: { sessionId }
  })
  const job: SessionVectorIndexJob = {
    worker,
    sender,
    cancelRequested: false,
    aiPauseReleased: false
  }
  sessionVectorIndexJobs.set(sessionId, job)
  dataManagementService.pauseForAi()

  worker.on('message', (message: SessionVectorIndexWorkerMessage) => {
    const currentJob = sessionVectorIndexJobs.get(sessionId)
    const targetSender = currentJob?.sender || sender

    if (message?.type === 'progress' && message.progress) {
      sendSessionVectorIndexProgress(targetSender, message.progress)
      return
    }

    if (message?.type === 'completed') {
      finishSessionVectorIndexJob(sessionId, currentJob)
      void worker.terminate().catch(() => undefined)
      return
    }

    if (message?.type === 'error') {
      finishSessionVectorIndexJob(sessionId, currentJob)
      void sendSessionVectorIndexFailure(targetSender, sessionId, message.error || '向量化失败')
      void worker.terminate().catch(() => undefined)
    }
  })

  worker.on('error', (error) => {
    const currentJob = finishSessionVectorIndexJob(sessionId)
    void sendSessionVectorIndexFailure(currentJob?.sender || sender, sessionId, String(error))
  })

  worker.on('exit', (code) => {
    const currentJob = finishSessionVectorIndexJob(sessionId)
    if (!currentJob) return

    if (code !== 0 && !currentJob.cancelRequested) {
      void sendSessionVectorIndexFailure(currentJob.sender, sessionId, `向量化 Worker 异常退出，代码：${code}`)
    }
  })

  return getSessionVectorIndexStateForUi(sessionId)
}

export async function cancelSessionVectorIndexJob(sessionId: string) {
  const job = sessionVectorIndexJobs.get(sessionId)
  if (job) {
    job.cancelRequested = true
    job.worker.postMessage({ type: 'cancel' })
    return {
      success: true,
      result: await getSessionVectorIndexStateForUi(sessionId)
    }
  }

  const { chatSearchIndexService } = await import('../../services/search/chatSearchIndexService')
  return {
    success: true,
    result: chatSearchIndexService.cancelSessionVectorIndex(sessionId)
  }
}

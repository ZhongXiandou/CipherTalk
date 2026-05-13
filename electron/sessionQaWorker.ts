import { parentPort, workerData } from 'worker_threads'
import type {
  AIStreamEvent,
  SessionQAProgressEvent,
  SessionQAResult
} from '../src/types/ai'
import type { SessionQAOptions } from './services/ai/aiService'
import { aiService } from './services/ai/aiService'

type SessionQAWorkerData = {
  requestId: string
  options: SessionQAOptions
}

type WorkerEvent =
  | { kind: 'progress'; progress: SessionQAProgressEvent }
  | { kind: 'stream'; streamEvent: AIStreamEvent }
  | { kind: 'final'; result: SessionQAResult }
  | { kind: 'error'; error: string }

const data = workerData as SessionQAWorkerData
let seq = 0
const startedAt = Date.now()

function post(event: WorkerEvent) {
  parentPort?.postMessage({
    requestId: data.requestId,
    seq: ++seq,
    createdAt: Date.now(),
    ...event
  })
}

async function run() {
  try {
    aiService.init()

    const result = await aiService.answerSessionQuestion(
      data.options,
      (streamEvent) => {
        post({ kind: 'stream', streamEvent })
      },
      (progress) => {
        post({
          kind: 'progress',
          progress: {
            ...progress,
            requestId: data.requestId,
            elapsedMs: Date.now() - startedAt
          }
        })
      }
    )

    post({ kind: 'final', result })
  } catch (error) {
    post({ kind: 'error', error: String(error) })
  }
}

void run()

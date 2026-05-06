import { LRUCache } from '../../../../utils/lruCache'

export const globalVoiceManager = {
  currentAudio: null as HTMLAudioElement | null,
  currentStopCallback: null as (() => void) | null,
  play(audio: HTMLAudioElement, onStop: () => void) {
    if (this.currentAudio && this.currentAudio !== audio) {
      this.currentAudio.pause()
      this.currentAudio.currentTime = 0
      this.currentStopCallback?.()
    }
    this.currentAudio = audio
    this.currentStopCallback = onStop
  },
  stop(audio: HTMLAudioElement) {
    if (this.currentAudio === audio) {
      this.currentAudio = null
      this.currentStopCallback = null
    }
  },
}

export const emojiDataUrlCache = new LRUCache<string, string>(200)
export const imageDataUrlCache = new LRUCache<string, string>(50)

const imageDecryptQueue: Array<() => Promise<void>> = []
let isProcessingQueue = false
const MAX_CONCURRENT_DECRYPTS = 3

async function processDecryptQueue() {
  if (isProcessingQueue) return
  isProcessingQueue = true

  try {
    while (imageDecryptQueue.length > 0) {
      const batch = imageDecryptQueue.splice(0, MAX_CONCURRENT_DECRYPTS)
      await Promise.all(batch.map(fn => fn().catch(() => { })))
    }
  } finally {
    isProcessingQueue = false
  }
}

export function enqueueDecrypt(fn: () => Promise<void>) {
  imageDecryptQueue.push(fn)
  void processDecryptQueue()
}

export type VideoLookupDiagnostics = {
  requestedMd5?: string
  candidateMd5s?: string[]
  searchedFileKeys?: string[]
  matchedMd5?: string
  hardlinkMatchedMd5?: string
  hardlinkDbPath?: string
  accountDir?: string
  videoBaseDir?: string
  reason?: 'missing_input' | 'missing_config' | 'account_dir_not_found' | 'video_dir_missing' | 'local_file_missing'
  summary?: string
}

export type CachedVideoInfo = {
  videoUrl?: string
  coverUrl?: string
  thumbUrl?: string
  exists: boolean
  cachedAt: number
  diagnostics?: VideoLookupDiagnostics
}

export const videoInfoCache = new Map<string, CachedVideoInfo>()

export let lastIncrementalUpdateTime = 0

export function setLastIncrementalUpdateTime(value: number) {
  lastIncrementalUpdateTime = value
}

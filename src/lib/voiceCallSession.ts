/**
 * 语音通话会话：常开麦克风 + 基于 RMS 能量的客户端 VAD（自动断句）。
 * 用户说一句、静音一小段就自动断句，回调整段音频给上层去转写+对话。
 * 半双工：上层在拿到 onUtterance 后应 pause()（分身说话时别听），播完再 resume()。
 *
 * ponytail: VAD 走能量阈值 + 静音计时的朴素状态机，没上 WebRTC VAD/ML 模型——
 * 够「打电话轮流说」用；嘈杂环境/远场要更准再换。下方常量是现实世界校准旋钮，
 * 不同麦克风/环境需要微调（噪声底自动校准已兜底一部分）。
 */
import { pcmToWav16Base64 } from './voiceRecorder'

export interface VoiceCallHandlers {
  /** 检测到用户开口 */
  onSpeechStart?: () => void
  /** 一句话说完（静音断句/超长强断）：整段 16k WAV(base64) + 时长秒 */
  onUtterance: (wavBase64: string, durationSec: number) => void
  onError?: (err: Error) => void
}

export interface VoiceCallSession {
  /** 暂停监听（分身说话时用，避免把外放的回复当成输入） */
  pause: () => void
  resume: () => void
  /** 挂断，释放麦克风 */
  stop: () => void
}

// —— VAD 校准旋钮 ——
const SILENCE_MS = 700         // 连续静音多久算说完
const MIN_SPEECH_MS = 300      // 短于此忽略（误触/杂音）
const MAX_UTTERANCE_MS = 15000 // 单句上限，超了强制断句
const PREROLL_MS = 300         // 开口前保留一点，避免吞首字
const CALIBRATE_MS = 400       // 开头静音段用来估噪声底
const ENERGY_MULT = 3.0        // 语音阈值 = 噪声底 × 此倍数
const MIN_THRESHOLD = 0.008    // 阈值下限，防止安静环境噪声底过低误触

function rms(buf: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}

export async function startVoiceCall(handlers: VoiceCallHandlers): Promise<VoiceCallSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const AudioCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioCtor) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('当前环境不支持 AudioContext，无法通话')
  }

  const ctx: AudioContext = new AudioCtor()
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(2048, 1, 1)
  const inputRate = ctx.sampleRate
  const frameMs = (2048 / inputRate) * 1000

  let stopped = false
  let paused = false

  // 噪声底自动校准
  let calibrating = true
  let calibSum = 0
  let calibElapsed = 0
  let noiseFloor = MIN_THRESHOLD

  // 说话前的滚动缓冲（避免吞首字）
  const preroll: Float32Array[] = []
  const prerollMax = Math.max(1, Math.ceil(PREROLL_MS / frameMs))

  // 说话中状态
  let inSpeech = false
  const speechFrames: Float32Array[] = []
  let speechMs = 0
  let silenceMs = 0

  const resetSpeech = () => {
    inSpeech = false
    speechFrames.length = 0
    speechMs = 0
    silenceMs = 0
  }

  const emitUtterance = () => {
    const totalLen = speechFrames.reduce((n, f) => n + f.length, 0)
    const spoken = speechMs
    if (totalLen === 0) { resetSpeech(); return }
    const merged = new Float32Array(totalLen)
    let off = 0
    for (const f of speechFrames) { merged.set(f, off); off += f.length }
    const durationSec = totalLen / inputRate
    resetSpeech()
    if (spoken >= MIN_SPEECH_MS) {
      try {
        handlers.onUtterance(pcmToWav16Base64(merged, inputRate), durationSec)
      } catch (e) {
        handlers.onError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }
  }

  processor.onaudioprocess = (e) => {
    if (stopped || paused) return
    const frame = new Float32Array(e.inputBuffer.getChannelData(0))
    const energy = rms(frame)

    if (calibrating) {
      calibSum += energy
      calibElapsed += frameMs
      preroll.push(frame)
      if (preroll.length > prerollMax) preroll.shift()
      if (calibElapsed >= CALIBRATE_MS) {
        const avg = calibElapsed > 0 ? calibSum / (calibElapsed / frameMs) : 0
        noiseFloor = Math.max(MIN_THRESHOLD, avg * ENERGY_MULT)
        calibrating = false
      }
      return
    }

    const isVoice = energy > noiseFloor

    if (!inSpeech) {
      preroll.push(frame)
      if (preroll.length > prerollMax) preroll.shift()
      if (isVoice) {
        inSpeech = true
        speechMs = 0
        silenceMs = 0
        for (const f of preroll) speechFrames.push(f) // 带上 preroll，别吞首字
        preroll.length = 0
        handlers.onSpeechStart?.()
      }
      return
    }

    speechFrames.push(frame)
    speechMs += frameMs
    if (isVoice) silenceMs = 0
    else silenceMs += frameMs

    if (silenceMs >= SILENCE_MS || speechMs >= MAX_UTTERANCE_MS) {
      emitUtterance()
    }
  }

  source.connect(processor)
  processor.connect(ctx.destination) // ScriptProcessor 需要连到图上才会跑；未写输出=静音，不会外放回声

  const teardown = () => {
    if (stopped) return
    stopped = true
    processor.onaudioprocess = null
    try { processor.disconnect() } catch { /* ignore */ }
    try { source.disconnect() } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close().catch(() => { /* ignore */ })
  }

  return {
    pause() {
      paused = true
      resetSpeech() // 丢掉半句，resume 后从头听
      preroll.length = 0
    },
    resume() {
      if (stopped) return
      paused = false
    },
    stop() {
      teardown()
    },
  }
}

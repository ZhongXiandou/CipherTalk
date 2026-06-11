/**
 * 文字转语音服务 —— 独立的 TTS 配置（朗读 AI 回复/微信消息/角色语音回复用），与聊天模型分开。
 * 配置存 ConfigService.ttsConfig，支持两种主流接口形态（protocol）：
 * - openai-speech：标准 /audio/speech 专用端点（硅基流动 CosyVoice、OpenAI tts 等），走 AI SDK generateSpeech
 * - openai-chat：聊天接口出音频（gpt-4o-audio 风格 /chat/completions + modalities，小米等平台），直连 fetch
 * 可在主进程与 AI 子进程复用（ConfigService 在两边都能解析路径）。
 */
import { experimental_generateSpeech as generateSpeech } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../config'
import { createProxyFetch, getResolvedProxyUrl } from './proxyFetch'

export type TtsProtocol = 'openai-speech' | 'openai-chat'

export interface TtsConfig {
  enabled: boolean
  /** 接口形态；旧配置无此字段，按 openai-speech 处理 */
  protocol: TtsProtocol
  apiKey: string
  baseURL: string
  model: string
  /** 音色。硅基流动格式如 FunAudioLLM/CosyVoice2-0.5B:alex；OpenAI 如 alloy。 */
  voice: string
  /** 语速，1 = 正常。 */
  speed: number
}

export interface TtsSynthesisResult {
  success: boolean
  /** base64 音频数据（成功时） */
  audioBase64?: string
  mimeType?: string
  cached?: boolean
  error?: string
  /** NOT_CONFIGURED 时渲染端回退系统 speechSynthesis */
  errorCode?: 'NOT_CONFIGURED' | 'SYNTHESIS_FAILED'
}

/** 单次合成的文本上限，超长截断（OpenAI /audio/speech 上限 4096 字符）。 */
const MAX_TTS_INPUT_CHARS = 4000
const TTS_CHAT_TIMEOUT_MS = 90000
const TTS_CACHE_DB_NAME = 'tts-cache.db'
const TTS_CACHE_AUDIO_DIR = 'tts-audio'
const TTS_CACHE_VERSION = 1

let cacheDb: Database.Database | null = null
let cacheDbPath: string | null = null
const pendingSyntheses = new Map<string, Promise<TtsSynthesisResult>>()

/** 读取持久化的 TTS 配置。 */
export function getTtsConfig(): TtsConfig {
  const cs = new ConfigService()
  try {
    const cfg = cs.get('ttsConfig')
    // 旧版本持久化的配置没有 protocol 字段，补默认
    return { ...cfg, protocol: cfg.protocol || 'openai-speech' }
  } finally {
    cs.close()
  }
}

/** 写入 TTS 配置（部分字段合并）。 */
export function saveTtsConfig(patch: Partial<TtsConfig>): TtsConfig {
  const cs = new ConfigService()
  try {
    const stored = cs.get('ttsConfig')
    const next: TtsConfig = { ...stored, ...patch, protocol: patch.protocol || stored.protocol || 'openai-speech' }
    cs.set('ttsConfig', next)
    return next
  } finally {
    cs.close()
  }
}

/** TTS 是否可用：启用且配了 key/模型。渲染端据此决定走在线合成还是系统朗读。 */
export function isTtsAvailable(cfg: TtsConfig = getTtsConfig()): boolean {
  return cfg.enabled && Boolean(cfg.apiKey) && Boolean(cfg.model)
}

function validateTtsConfig(cfg: TtsConfig): string | null {
  if (!cfg.apiKey) return '未配置 TTS API Key'
  if (!cfg.model) return '未配置 TTS 模型'
  if (cfg.baseURL) {
    try {
      new URL(cfg.baseURL)
    } catch {
      return 'TTS 接口地址格式无效'
    }
  }
  return null
}

/** 把各种异常拼成带 HTTP 状态/响应体的可诊断信息（AI SDK 的 APICallError 自带这些字段）。 */
function describeTtsError(e: unknown): string {
  const err = e as { statusCode?: number; responseBody?: string; message?: string }
  const parts: string[] = []
  if (err?.statusCode) parts.push(`HTTP ${err.statusCode}`)
  if (err?.responseBody) parts.push(String(err.responseBody).slice(0, 300))
  if (parts.length === 0) parts.push(e instanceof Error ? e.message : String(e))
  return parts.join(' · ')
}

function getTtsCacheBasePath(): string {
  const cs = new ConfigService()
  try {
    return cs.getCacheBasePath()
  } finally {
    cs.close()
  }
}

function ensureTtsCacheDb(): Database.Database {
  const basePath = getTtsCacheBasePath()
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true })
  }
  const dbPath = join(basePath, TTS_CACHE_DB_NAME)
  if (cacheDb && cacheDbPath === dbPath) return cacheDb

  if (cacheDb) {
    cacheDb.close()
    cacheDb = null
  }

  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tts_audio_cache (
      cache_key TEXT PRIMARY KEY,
      text_hash TEXT NOT NULL,
      protocol TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      voice TEXT NOT NULL,
      speed REAL NOT NULL,
      mime_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tts_audio_cache_last_used
      ON tts_audio_cache(last_used_at);
  `)
  cacheDb = db
  cacheDbPath = dbPath
  return db
}

function normalizeTtsBaseURL(baseURL: string): string {
  return String(baseURL || '').trim().replace(/\/+$/, '')
}

function normalizeTtsSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? Number(speed.toFixed(3)) : 1
}

function createTtsCacheKey(text: string, cfg: TtsConfig): string {
  return createHash('sha256').update(JSON.stringify({
    version: TTS_CACHE_VERSION,
    text,
    protocol: cfg.protocol || 'openai-speech',
    baseURL: normalizeTtsBaseURL(cfg.baseURL),
    model: cfg.model,
    voice: cfg.voice || '',
    speed: normalizeTtsSpeed(cfg.speed),
    format: 'mp3',
  })).digest('hex')
}

function getAudioExtension(mimeType: string): string {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase()
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return '.mp3'
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return '.wav'
  if (normalized === 'audio/ogg') return '.ogg'
  if (normalized === 'audio/aac') return '.aac'
  if (normalized === 'audio/flac') return '.flac'
  return '.mp3'
}

function readTtsCache(cacheKey: string): TtsSynthesisResult | null {
  try {
    const db = ensureTtsCacheDb()
    const row = db.prepare(`
      SELECT mime_type AS mimeType, file_path AS filePath
      FROM tts_audio_cache
      WHERE cache_key = ?
    `).get(cacheKey) as { mimeType: string; filePath: string } | undefined

    if (!row) return null
    if (!existsSync(row.filePath)) {
      db.prepare('DELETE FROM tts_audio_cache WHERE cache_key = ?').run(cacheKey)
      return null
    }

    db.prepare('UPDATE tts_audio_cache SET last_used_at = ? WHERE cache_key = ?').run(Date.now(), cacheKey)
    return {
      success: true,
      audioBase64: readFileSync(row.filePath).toString('base64'),
      mimeType: row.mimeType || 'audio/mpeg',
      cached: true,
    }
  } catch (e) {
    console.warn('[TTS] 读取缓存失败:', e)
    return null
  }
}

function writeTtsCache(cacheKey: string, text: string, cfg: TtsConfig, result: TtsSynthesisResult): void {
  if (!result.success || !result.audioBase64) return

  try {
    const basePath = getTtsCacheBasePath()
    const audioDir = join(basePath, TTS_CACHE_AUDIO_DIR)
    if (!existsSync(audioDir)) {
      mkdirSync(audioDir, { recursive: true })
    }

    const mimeType = result.mimeType || 'audio/mpeg'
    const buffer = Buffer.from(result.audioBase64, 'base64')
    const filePath = join(audioDir, `${cacheKey}${getAudioExtension(mimeType)}`)
    writeFileSync(filePath, buffer)

    const db = ensureTtsCacheDb()
    const now = Date.now()
    db.prepare(`
      INSERT OR REPLACE INTO tts_audio_cache (
        cache_key, text_hash, protocol, base_url, model, voice, speed,
        mime_type, file_path, size_bytes, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cacheKey,
      createHash('sha256').update(text).digest('hex'),
      cfg.protocol || 'openai-speech',
      normalizeTtsBaseURL(cfg.baseURL),
      cfg.model,
      cfg.voice || '',
      normalizeTtsSpeed(cfg.speed),
      mimeType,
      filePath,
      buffer.length,
      now,
      now,
    )
  } catch (e) {
    console.warn('[TTS] 写入缓存失败:', e)
  }
}

export function closeTtsCache(): void {
  if (cacheDb) {
    cacheDb.close()
    cacheDb = null
    cacheDbPath = null
  }
  pendingSyntheses.clear()
}

export function getTtsCachePaths(): { dbPath: string; audioDir: string } {
  const basePath = getTtsCacheBasePath()
  return {
    dbPath: join(basePath, TTS_CACHE_DB_NAME),
    audioDir: join(basePath, TTS_CACHE_AUDIO_DIR),
  }
}

export function clearTtsCache(): { success: boolean; error?: string } {
  try {
    closeTtsCache()
    const { dbPath, audioDir } = getTtsCachePaths()
    for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      if (existsSync(filePath)) rmSync(filePath, { force: true })
    }
    if (existsSync(audioDir)) rmSync(audioDir, { recursive: true, force: true })
    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/** openai-speech：标准 /audio/speech 端点（AI SDK generateSpeech）。 */
async function synthesizeViaSpeechApi(text: string, cfg: TtsConfig, signal?: AbortSignal): Promise<TtsSynthesisResult> {
  const fetch = createProxyFetch(getResolvedProxyUrl())
  const model = createOpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL || undefined,
    name: 'tts',
    fetch,
  }).speech(cfg.model)

  const { audio } = await generateSpeech({
    model,
    text,
    voice: cfg.voice || undefined,
    speed: cfg.speed && cfg.speed !== 1 ? cfg.speed : undefined,
    outputFormat: 'mp3',
    maxRetries: 1,
    abortSignal: signal,
  })

  return {
    success: true,
    audioBase64: audio.base64,
    mimeType: audio.mediaType || 'audio/mpeg',
  }
}

/**
 * openai-chat：聊天接口出音频（gpt-4o-audio 风格）。
 * 请求 /chat/completions + modalities:["text","audio"]，响应取 choices[0].message.audio.data（base64）；
 * 个别平台返回 audio.url，也兼容下载。
 * 角色语义两派自适应：TTS 派（小米等）要求文本放 assistant 角色（照读），对话派（gpt-4o-audio）要求 user 角色；
 * 先按 assistant 发，参数类 4xx 再换 user 重试。
 */
async function synthesizeViaChatApi(text: string, cfg: TtsConfig, signal?: AbortSignal): Promise<TtsSynthesisResult> {
  if (!cfg.baseURL) return { success: false, error: '聊天接口形态必须填写接口地址', errorCode: 'NOT_CONFIGURED' }
  const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
  const endpoint = `${cfg.baseURL.trim().replace(/\/+$/, '')}/chat/completions`

  const attempts: Array<Array<{ role: string; content: string }>> = [
    [{ role: 'assistant', content: text }],
    [{ role: 'user', content: text }],
  ]
  let response: Response | null = null
  let lastError = ''
  for (const messages of attempts) {
    const attempt = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        modalities: ['text', 'audio'],
        audio: {
          voice: cfg.voice || undefined,
          format: 'mp3',
        },
        messages,
        stream: false,
      }),
      signal,
    }) as Response
    if (attempt.ok) {
      response = attempt
      break
    }
    const body = await attempt.text().catch(() => '')
    lastError = `HTTP ${attempt.status} · ${body.slice(0, 300) || attempt.statusText}`
    // 只有参数类错误才值得换角色重试；鉴权/限流/服务端错误直接报出去
    if (attempt.status !== 400 && attempt.status !== 422) break
  }
  if (!response) {
    return { success: false, error: lastError || '请求失败', errorCode: 'SYNTHESIS_FAILED' }
  }

  const payload: any = await response.json().catch(() => null)
  const audio = payload?.choices?.[0]?.message?.audio
  const data = String(audio?.data || '').trim()
  if (data) {
    return { success: true, audioBase64: data, mimeType: 'audio/mpeg' }
  }
  const url = String(audio?.url || '').trim()
  if (url) {
    const audioResponse = await fetchImpl(url, { signal })
    if (!audioResponse.ok) {
      return { success: false, error: `下载音频失败: HTTP ${audioResponse.status}`, errorCode: 'SYNTHESIS_FAILED' }
    }
    const mimeType = audioResponse.headers.get('content-type')?.split(';')[0] || 'audio/mpeg'
    const buffer = Buffer.from(await audioResponse.arrayBuffer())
    return { success: true, audioBase64: buffer.toString('base64'), mimeType }
  }
  const preview = JSON.stringify(payload)?.slice(0, 300) || '空响应'
  return { success: false, error: `接口返回成功但没有音频数据（message.audio.data/url 均为空）：${preview}`, errorCode: 'SYNTHESIS_FAILED' }
}

/** 合成语音。cfg 缺省读持久化配置（试听时传 overrides）。 */
export async function synthesizeSpeech(
  text: string,
  options: { config?: Partial<TtsConfig>; signal?: AbortSignal; useCache?: boolean } = {},
): Promise<TtsSynthesisResult> {
  const cfg: TtsConfig = { ...getTtsConfig(), ...options.config }
  if (!options.config && !isTtsAvailable(cfg)) {
    return { success: false, error: '未启用或未配置文字转语音', errorCode: 'NOT_CONFIGURED' }
  }
  const invalid = validateTtsConfig(cfg)
  if (invalid) return { success: false, error: invalid, errorCode: 'NOT_CONFIGURED' }

  const input = String(text || '').trim().slice(0, MAX_TTS_INPUT_CHARS)
  if (!input) return { success: false, error: '朗读内容为空', errorCode: 'SYNTHESIS_FAILED' }

  const shouldUseCache = options.useCache ?? !options.config
  const cacheKey = shouldUseCache ? createTtsCacheKey(input, cfg) : ''
  if (cacheKey) {
    const cached = readTtsCache(cacheKey)
    if (cached) return cached
    const pending = pendingSyntheses.get(cacheKey)
    if (pending) return pending
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TTS_CHAT_TIMEOUT_MS)
  options.signal?.addEventListener('abort', () => controller.abort())

  const runSynthesis = async (): Promise<TtsSynthesisResult> => {
    if (cfg.protocol === 'openai-chat') {
      return synthesizeViaChatApi(input, cfg, controller.signal)
    }
    return synthesizeViaSpeechApi(input, cfg, controller.signal)
  }

  const task = (async (): Promise<TtsSynthesisResult> => {
    try {
      const result = await runSynthesis()
      if (cacheKey && result.success && result.audioBase64) {
        writeTtsCache(cacheKey, input, cfg, result)
      }
      return result
    } catch (e) {
      const detail = controller.signal.aborted && !options.signal?.aborted
        ? '请求超时'
        : describeTtsError(e)
      console.error('[TTS] 合成失败:', detail)
      return { success: false, error: detail, errorCode: 'SYNTHESIS_FAILED' }
    } finally {
      clearTimeout(timeout)
      if (cacheKey) pendingSyntheses.delete(cacheKey)
    }
  })()

  if (cacheKey) pendingSyntheses.set(cacheKey, task)
  return task
}

/** 只清理缺失音频文件的陈旧记录；供测试/维护调用。 */
export function pruneTtsCache(): { success: boolean; removed: number; error?: string } {
  try {
    const db = ensureTtsCacheDb()
    const rows = db.prepare('SELECT cache_key AS cacheKey, file_path AS filePath FROM tts_audio_cache')
      .all() as Array<{ cacheKey: string; filePath: string }>
    let removed = 0
    const deleteStmt = db.prepare('DELETE FROM tts_audio_cache WHERE cache_key = ?')
    for (const row of rows) {
      if (existsSync(row.filePath)) continue
      deleteStmt.run(row.cacheKey)
      removed += 1
    }
    return { success: true, removed }
  } catch (e) {
    return { success: false, removed: 0, error: String(e) }
  }
}

/** 测试配置：合成一小段试听音频，成功即配置可用（音频回给 UI 播放）。 */
export async function testTtsConfig(cfg: Partial<TtsConfig>): Promise<TtsSynthesisResult> {
  return synthesizeSpeech('你好，这是密语的语音试听。', { config: cfg, useCache: false })
}

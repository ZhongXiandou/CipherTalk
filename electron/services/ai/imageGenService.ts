/**
 * AI 作图服务 —— 独立的图像生成配置（AI 助手 generate_image 工具用），与聊天模型分开。
 * 配置存 ConfigService.imageGenConfig；openai/google 协议走 AI SDK generateImage，
 * openai-compatible 走直连 /images/generations + 宽容解析（国内厂商多返回 url 而非 b64_json）。
 * 可在主进程与 AI 子进程复用（ConfigService 在两边都能解析路径）。
 */
import fs from 'fs'
import path from 'path'
import { generateImage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { ConfigService } from '../config'
import { getUserDataPath } from '../runtimePaths'
import { createProxyFetch, getResolvedProxyUrl } from './proxyFetch'

export interface ImageGenConfig {
  enabled: boolean
  protocol: 'openai-compatible' | 'openai' | 'google'
  apiKey: string
  baseURL: string
  model: string
  /** 图片尺寸，如 1024x1024；空 = 服务商默认。 */
  size: string
}

export interface ImageGenResult {
  success: boolean
  /** 生成图片的本地绝对路径（成功时），渲染端用 local-image:// 协议展示 */
  filePath?: string
  mimeType?: string
  error?: string
}

const IMAGE_GEN_TIMEOUT_MS = 120000

/** 读取持久化的作图配置。 */
export function getImageGenConfig(): ImageGenConfig {
  const cs = new ConfigService()
  try {
    return cs.get('imageGenConfig')
  } finally {
    cs.close()
  }
}

/** 写入作图配置（部分字段合并）。 */
export function saveImageGenConfig(patch: Partial<ImageGenConfig>): ImageGenConfig {
  const cs = new ConfigService()
  try {
    const next = { ...cs.get('imageGenConfig'), ...patch }
    cs.set('imageGenConfig', next)
    return next
  } finally {
    cs.close()
  }
}

/** 作图是否可用：启用且配了 key/模型。engine 据此决定是否挂 generate_image 工具。 */
export function isImageGenAvailable(cfg: ImageGenConfig = getImageGenConfig()): boolean {
  return cfg.enabled && Boolean(cfg.apiKey) && Boolean(cfg.model)
}

function imageOutputDir(): string {
  const dir = path.join(getUserDataPath(), 'ai-images')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function extensionOf(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  return 'png'
}

function saveImageBuffer(data: Uint8Array, mimeType: string): string {
  const filePath = path.join(
    imageOutputDir(),
    `img-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${extensionOf(mimeType)}`,
  )
  fs.writeFileSync(filePath, data)
  return filePath
}

function normalizeSize(size?: string): `${number}x${number}` | undefined {
  const value = String(size || '').trim()
  return /^\d+x\d+$/.test(value) ? (value as `${number}x${number}`) : undefined
}

/** openai / google 协议：AI SDK generateImage。 */
async function generateViaAiSdk(prompt: string, cfg: ImageGenConfig, size?: string, signal?: AbortSignal): Promise<ImageGenResult> {
  const fetch = createProxyFetch(getResolvedProxyUrl())
  const model = cfg.protocol === 'google'
    ? createGoogleGenerativeAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined, name: 'image-gen', fetch }).imageModel(cfg.model)
    : createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined, name: 'image-gen', fetch }).imageModel(cfg.model)

  const { image } = await generateImage({
    model,
    prompt,
    n: 1,
    size: normalizeSize(size || cfg.size),
    maxRetries: 1,
    abortSignal: signal,
  })

  const mimeType = image.mediaType || 'image/png'
  return { success: true, filePath: saveImageBuffer(image.uint8Array, mimeType), mimeType }
}

/**
 * openai-compatible 协议：直连 /images/generations。
 * 不带 response_format（部分厂商会拒绝），响应同时兼容 data[].b64_json / data[].url / images[].url。
 */
async function generateViaCompatible(prompt: string, cfg: ImageGenConfig, size?: string, signal?: AbortSignal): Promise<ImageGenResult> {
  if (!cfg.baseURL) return { success: false, error: '未配置作图接口地址' }
  const fetchImpl = createProxyFetch(getResolvedProxyUrl()) || fetch
  const endpoint = `${cfg.baseURL.trim().replace(/\/+$/, '')}/images/generations`
  const sizeValue = normalizeSize(size || cfg.size)

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      prompt,
      n: 1,
      ...(sizeValue ? { size: sizeValue, image_size: sizeValue } : {}),
    }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = `HTTP ${response.status}`
    try {
      const payload = JSON.parse(text)
      message = payload?.error?.message || payload?.message || message
    } catch { /* 用原始状态码 */ }
    return { success: false, error: `作图请求失败: ${message}` }
  }

  const payload: any = await response.json().catch(() => null)
  const item = payload?.data?.[0] || payload?.images?.[0]
  if (item?.b64_json) {
    return { success: true, filePath: saveImageBuffer(Buffer.from(String(item.b64_json), 'base64'), 'image/png'), mimeType: 'image/png' }
  }
  const url = String(item?.url || '').trim()
  if (url) {
    const imageResponse = await fetchImpl(url, { signal })
    if (!imageResponse.ok) return { success: false, error: `下载生成图片失败: HTTP ${imageResponse.status}` }
    const mimeType = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/png'
    const data = new Uint8Array(await imageResponse.arrayBuffer())
    return { success: true, filePath: saveImageBuffer(data, mimeType), mimeType }
  }
  return { success: false, error: '作图接口返回成功，但未找到图片数据（b64_json/url 均为空）' }
}

/** 生成图片并落盘。cfg 缺省读持久化配置（测试时传 overrides）。 */
export async function generateImageToFile(
  prompt: string,
  options: { size?: string; config?: Partial<ImageGenConfig>; signal?: AbortSignal } = {},
): Promise<ImageGenResult> {
  const cfg: ImageGenConfig = { ...getImageGenConfig(), ...options.config }
  if (!cfg.apiKey) return { success: false, error: '未配置作图 API Key' }
  if (!cfg.model) return { success: false, error: '未配置作图模型' }
  const input = String(prompt || '').trim()
  if (!input) return { success: false, error: '作图提示词为空' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), IMAGE_GEN_TIMEOUT_MS)
  options.signal?.addEventListener('abort', () => controller.abort())

  try {
    if (cfg.protocol === 'openai-compatible') {
      return await generateViaCompatible(input, cfg, options.size, controller.signal)
    }
    return await generateViaAiSdk(input, cfg, options.size, controller.signal)
  } catch (e) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      return { success: false, error: '作图请求超时，请稍后重试' }
    }
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timeout)
  }
}

/** 测试配置：真实生成一张小图验证全链路（会消耗少量额度）。 */
export async function testImageGenConfig(cfg: Partial<ImageGenConfig>): Promise<ImageGenResult> {
  return generateImageToFile('一只可爱的橘猫，扁平插画风格', { size: '512x512', config: cfg })
}

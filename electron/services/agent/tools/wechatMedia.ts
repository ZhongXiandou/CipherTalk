/**
 * send_wechat_media —— 微信出站媒体统一工具。
 *
 * 工具只做下载/校验/归类并返回本地文件路径；真正发送由微信 bot 主进程完成。
 * 本地路径允许电脑上可访问的任意文件，远程 URL 只允许 http/https 并下载到缓存目录。
 */
import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import crypto from 'crypto'
import { ConfigService } from '../../config'

export type WechatMediaKind = 'image' | 'video' | 'file'

export interface PreparedWechatMedia {
  kind: WechatMediaKind
  filePath: string
  fileName: string
  sizeBytes: number
  mimeType: string
  caption: string
  sourceType: 'remote_url' | 'local_file'
}

const MAX_WECHAT_FILE_BYTES = 100 * 1024 * 1024
const MAX_WECHAT_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REMOTE_MEDIA_BYTES = 100 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
  'application/zip': '.zip',
}

export function mimeTypeFromPath(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

export function mediaKindFromMime(mimeType: string): WechatMediaKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  return 'file'
}

function normalizeRealPath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return null
  }
}

function getCacheMediaDir(kind: WechatMediaKind): string {
  const cs = new ConfigService()
  try {
    const dir = path.join(cs.getCacheBasePath(), kind === 'image' ? 'ai-images' : kind === 'video' ? 'ai-videos' : 'ai-files')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } finally {
    cs.close()
  }
}

function safeExtFromUrl(url: URL, contentType: string): string {
  const contentMime = contentType.split(';')[0].trim().toLowerCase()
  const byMime = EXT_BY_MIME[contentMime]
  if (byMime) return byMime
  const ext = path.extname(url.pathname).toLowerCase()
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext
  return '.bin'
}

function assertSize(kind: WechatMediaKind, size: number): string | null {
  if (size <= 0) return '文件为空'
  if (kind === 'image' && size > MAX_WECHAT_IMAGE_BYTES) return '图片超过 20MB，不能发送到微信'
  if (size > MAX_WECHAT_FILE_BYTES) return '文件超过 100MB，不能发送到微信'
  return null
}

async function downloadRemoteMedia(urlText: string): Promise<{ filePath: string; mimeType: string; sizeBytes: number; kind: WechatMediaKind }> {
  const url = new URL(urlText)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只支持 http/https 媒体 URL')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`远程媒体下载失败：HTTP ${res.status}`)
  const contentLength = Number(res.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_MEDIA_BYTES) throw new Error('远程媒体超过 100MB，不能发送到微信')

  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body?.getReader()
  if (!reader) throw new Error('无法读取远程媒体响应')
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > MAX_REMOTE_MEDIA_BYTES) throw new Error('远程媒体超过 100MB，不能发送到微信')
    chunks.push(chunk)
  }

  const contentType = res.headers.get('content-type') || ''
  const ext = safeExtFromUrl(url, contentType)
  const mimeType = contentType.split(';')[0].trim().toLowerCase() || mimeTypeFromPath(`file${ext}`)
  const kind = mediaKindFromMime(mimeType || mimeTypeFromPath(`file${ext}`))
  const sizeError = assertSize(kind, total)
  if (sizeError) throw new Error(sizeError)
  const dir = getCacheMediaDir(kind)
  const filePath = path.join(dir, `wechat-remote-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`)
  fs.writeFileSync(filePath, Buffer.concat(chunks))
  return { filePath, mimeType: mimeTypeFromPath(filePath), sizeBytes: total, kind }
}

function validateLocalMedia(filePath: string): { filePath: string; mimeType: string; sizeBytes: number; kind: WechatMediaKind } | { error: string } {
  const realFilePath = normalizeRealPath(filePath)
  if (!realFilePath) return { error: '文件不存在' }
  const stat = fs.statSync(realFilePath)
  if (!stat.isFile()) return { error: '路径不是文件' }

  const mimeType = mimeTypeFromPath(realFilePath)
  const kind = mediaKindFromMime(mimeType)
  const sizeError = assertSize(kind, stat.size)
  if (sizeError) return { error: sizeError }

  return { filePath: realFilePath, mimeType, sizeBytes: stat.size, kind }
}

export const sendWechatMedia = tool({
  description:
    '在微信连接场景下发送媒体到当前微信用户。支持电脑上可访问的任意本地文件绝对路径，或 http/https 远程媒体 URL。' +
    '会自动按 MIME 分流为图片、视频或文件。仅当用户明确要求发送媒体/文件/图片/视频到微信时使用。' +
    'caption 可作为媒体前的简短说明文字发送。',
  inputSchema: z.object({
    media: z.string().min(1).describe('本地文件绝对路径或 http/https 远程媒体 URL'),
    caption: z.string().optional().describe('媒体前要发送的简短说明文字'),
  }),
  execute: async ({ media, caption }) => {
    try {
      const prepared = await prepareWechatMedia(media, caption)
      return {
        success: true,
        ...prepared,
        note: '媒体已准备发送到微信，回答里不要输出本地路径',
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

export async function prepareWechatMedia(media: string, caption = ''): Promise<PreparedWechatMedia> {
  const source = media.trim()
  const info = /^https?:\/\//i.test(source)
    ? await downloadRemoteMedia(source)
    : validateLocalMedia(source)
  if ('error' in info) throw new Error(info.error)
  return {
    kind: info.kind,
    filePath: info.filePath,
    fileName: path.basename(info.filePath),
    sizeBytes: info.sizeBytes,
    mimeType: info.mimeType,
    caption: String(caption || '').trim(),
    sourceType: /^https?:\/\//i.test(source) ? 'remote_url' : 'local_file',
  }
}

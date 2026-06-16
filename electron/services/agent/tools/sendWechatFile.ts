/**
 * send_wechat_file —— 给微信连接场景准备一个受控文件发送结果。
 * 工具只校验并返回电脑上可访问的本地文件；真正发送由主进程微信 bot 完成。
 */
import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs'
import * as path from 'path'

const MAX_WECHAT_FILE_BYTES = 100 * 1024 * 1024

function mimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
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
  }
  return map[ext] || 'application/octet-stream'
}

function normalizeRealPath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return null
  }
}

export const sendWechatFile = tool({
  description:
    '在微信连接场景下发送一个本地文件。仅当用户明确要求把已生成/已导出的文件发到微信时使用。' +
    'filePath 可以是电脑上可访问的任意本地文件绝对路径。',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('要发送的本地文件绝对路径'),
  }),
  execute: async ({ filePath }) => {
    try {
      const realFilePath = normalizeRealPath(filePath)
      if (!realFilePath) return { error: '文件不存在' }
      const stat = fs.statSync(realFilePath)
      if (!stat.isFile()) return { error: '路径不是文件' }
      if (stat.size <= 0) return { error: '文件为空' }
      if (stat.size > MAX_WECHAT_FILE_BYTES) return { error: '文件超过 100MB，不能发送到微信' }

      return {
        success: true,
        filePath: realFilePath,
        fileName: path.basename(realFilePath),
        sizeBytes: stat.size,
        mimeType: mimeTypeFromPath(realFilePath),
        note: '文件已准备发送到微信，回答里不要输出本地路径',
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})

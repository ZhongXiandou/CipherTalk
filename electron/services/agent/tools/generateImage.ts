/**
 * generate_image —— AI 作图工具（见 services/ai/imageGenService）。
 * 仅在用户配置并启用「AI 作图」时才挂进工具集（见 tools/index.ts buildTools / engine.ts）。
 * 生成的图片落盘到 userData/ai-images，前端按 filePath 用 local-image:// 协议直接展示。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { generateImageToFile } from '../../ai/imageGenService'

export const generateImage = tool({
  description:
    '根据文字描述生成一张图片（AI 作图）。用户要求画图/作图/生成图片/配图时使用。' +
    'prompt 用具体、生动的描述（主体、风格、构图、色调），中英文皆可。' +
    '生成的图片会自动展示给用户，回答时简要说明画了什么即可，不要输出图片路径或链接。',
  inputSchema: z.object({
    prompt: z.string().min(1).describe('图片描述（提示词），尽量具体：主体、风格、构图、色调等'),
    size: z.string().optional().describe('图片尺寸，格式 宽x高（如 1024x1024），默认用全局配置'),
  }),
  execute: async ({ prompt, size }, { abortSignal }) => {
    const res = await generateImageToFile(prompt, { size, signal: abortSignal })
    if (!res.success) {
      return { error: res.error || '图片生成失败' }
    }
    return {
      success: true,
      filePath: res.filePath,
      mimeType: res.mimeType,
      note: '图片已生成并自动展示给用户，无需在回答中粘贴路径或链接',
    }
  },
})

import { net, protocol } from 'electron'

/**
 * 本地媒体协议处理。
 * privileged scheme 仍在 main.ts 的 app ready 前注册；这里仅负责 ready 后绑定 handler。
 */
export function registerLocalProtocols(): void {
  protocol.handle('local-video', (request) => {
    // Windows 路径会包含反斜杠，转为 file URL 可识别的正斜杠格式。
    let filePath = decodeURIComponent(request.url.replace('local-video://', ''))
    filePath = filePath.replace(/\\/g, '/')
    console.log('[Protocol] 加载视频:', filePath)
    return net.fetch(`file:///${filePath}`)
  })
}

import { ipcMain, webContents } from 'electron'
import { dbPathService } from '../../services/dbPathService'
import { wcdbService } from '../../services/wcdbService'
import { monitorBridge } from '../../services/monitorBridge'
import type { MainProcessContext } from '../context'

let monitorBroadcastWired = false

function setupMonitorBroadcast(ctx: MainProcessContext): void {
  if (monitorBroadcastWired) return
  monitorBroadcastWired = true
  monitorBridge.on('change', (payload) => {
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send('wcdb:change', payload)
      }
    } catch (e) {
      ctx.getLogService()?.warn('WCDB', 'wcdb:change broadcast failed', { error: String(e) })
    }
  })
}

/**
 * WCDB 连接与解密 IPC。
 * 自动连接失败使用 warn，手动测试失败使用 error，便于日志侧区分场景。
 */
export function registerWcdbHandlers(ctx: MainProcessContext): void {
  setupMonitorBroadcast(ctx)

  ipcMain.handle('wcdb:testConnection', async (_, dbPath: string, hexKey: string, wxid: string, isAutoConnect = false) => {
    const logPrefix = isAutoConnect ? '自动连接' : '手动测试'
    ctx.getLogService()?.info('WCDB', `${logPrefix}数据库连接`, { dbPath, wxid, isAutoConnect })
    const result = await wcdbService.testConnection(dbPath, hexKey, wxid)
    if (result.success) {
      ctx.getLogService()?.info('WCDB', `${logPrefix}数据库连接成功`, { sessionCount: result.sessionCount })
    } else {
      // 自动连接失败使用WARN级别，手动测试失败使用ERROR级别
      const logLevel = isAutoConnect ? 'warn' : 'error'
      const errorInfo = {
        error: result.error || '未知错误',
        dbPath,
        wxid,
        keyLength: hexKey ? hexKey.length : 0,
        isAutoConnect
      }

      if (logLevel === 'warn') {
        ctx.getLogService()?.warn('WCDB', `${logPrefix}数据库连接失败`, errorInfo)
      } else {
        ctx.getLogService()?.error('WCDB', `${logPrefix}数据库连接失败`, errorInfo)
      }
    }
    return result
  })

  ipcMain.handle('wcdb:resolveValidWxid', async (_, dbPath: string, hexKey: string) => {
    try {
      const wxids = dbPathService.scanWxids(dbPath)
      if (wxids.length === 0) {
        return { success: false, error: '未检测到账号目录' }
      }

      for (const wxid of wxids) {
        const result = await wcdbService.testConnection(dbPath, hexKey, wxid)
        if (result.success) {
          return { success: true, wxid }
        }
      }

      return { success: false, error: '未找到可通过当前密钥验证的账号目录' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('wcdb:open', async (_, dbPath: string, hexKey: string, wxid: string) => {
    return wcdbService.open(dbPath, hexKey, wxid)
  })

  ipcMain.handle('wcdb:close', async () => {
    wcdbService.close()
    return true
  })

  // 数据库解密（已废弃）
  // Direct DB 迁移后，解密落地链路已下线。保留 channel 以兼容前端旧调用，
  // 直接返回"已废弃"语义的空结果。
  ipcMain.handle('wcdb:decryptDatabase', async (_event, _dbPath: string, _hexKey: string, _wxid: string) => {
    console.warn('[ipc] wcdb:decryptDatabase is deprecated after direct-db migration')
    ctx.getLogService()?.warn('Decrypt', 'wcdb:decryptDatabase 已废弃，Direct DB 模式下无需解密落地')
    return {
      success: true,
      totalFiles: 0,
      successCount: 0,
      failCount: 0,
      skipped: true
    }
  })
}

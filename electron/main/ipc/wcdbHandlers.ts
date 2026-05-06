import { ipcMain } from 'electron'
import { dataManagementService } from '../../services/dataManagementService'
import { dbPathService } from '../../services/dbPathService'
import { wcdbService } from '../../services/wcdbService'
import type { MainProcessContext } from '../context'

/**
 * WCDB 连接与解密 IPC。
 * 自动连接失败使用 warn，手动测试失败使用 error，便于日志侧区分场景。
 */
export function registerWcdbHandlers(ctx: MainProcessContext): void {
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

  // 数据库解密
  ipcMain.handle('wcdb:decryptDatabase', async (event, dbPath: string, hexKey: string, wxid: string) => {
    ctx.getLogService()?.info('Decrypt', '开始解密数据库', { dbPath, wxid })

    try {
      // 使用已有的 dataManagementService 来解密
      const result = await dataManagementService.decryptAll()

      if (result.success) {
        ctx.getLogService()?.info('Decrypt', '解密完成', {
          successCount: result.successCount,
          failCount: result.failCount
        })

        return {
          success: true,
          totalFiles: (result.successCount || 0) + (result.failCount || 0),
          successCount: result.successCount,
          failCount: result.failCount
        }
      } else {
        ctx.getLogService()?.error('Decrypt', '解密失败', { error: result.error })
        return { success: false, error: result.error }
      }
    } catch (e) {
      ctx.getLogService()?.error('Decrypt', '解密异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  // 数据管理相关

}

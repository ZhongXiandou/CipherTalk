import { ipcMain } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { appUpdateService } from '../../services/appUpdateService'
import type { MainProcessContext } from '../context'

/**
 * 应用更新下载与安装 IPC。
 * 这里维护“是否正在安装”的共享状态，并把下载进度继续广播给所有窗口。
  */
export function registerAppUpdateHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('app:downloadAndInstall', async () => {
    if (ctx.getIsInstallingUpdate()) {
      ctx.getLogService()?.warn('AppUpdate', '下载更新请求被忽略，当前已有下载任务进行中', {
        targetVersion: appUpdateService.getCachedUpdateInfo()?.version
      })
      return
    }

    ctx.setIsInstallingUpdate(true)
    const cachedUpdateInfo = appUpdateService.getCachedUpdateInfo()
    const targetVersion = cachedUpdateInfo?.version

    appUpdateService.updateDiagnostics({
      phase: 'downloading',
      targetVersion,
      lastError: undefined,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: undefined,
      lastEvent: targetVersion ? `开始下载更新 ${targetVersion}` : '开始下载更新'
    })
    ctx.getLogService()?.info('AppUpdate', '开始下载更新', { targetVersion, differentialEnabled: !autoUpdater.disableDifferentialDownload })

    const onDownloadProgress = (progress: ProgressInfo) => {
      const payload = {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
      ctx.broadcastToWindows('app:downloadProgress', payload)
      appUpdateService.updateDiagnostics({
        phase: 'downloading',
        progressPercent: progress.percent,
        downloadedBytes: progress.transferred,
        totalBytes: progress.total,
        lastEvent: `下载中 ${progress.percent.toFixed(1)}%`
      })
    }

    const onUpdateDownloaded = () => {
      appUpdateService.updateDiagnostics({
        phase: 'downloaded',
        progressPercent: 100,
        lastEvent: '更新包下载完成，准备安装'
      })
      ctx.getLogService()?.info('AppUpdate', '更新包下载完成，准备安装', {
        targetVersion,
        fallbackToFull: appUpdateService.getCachedUpdateInfo()?.diagnostics?.fallbackToFull || false
      })
      ctx.appWithQuitFlag.isQuitting = true
      appUpdateService.updateDiagnostics({
        phase: 'installing',
        lastEvent: '开始调用安装器'
      })
      autoUpdater.quitAndInstall(false, true)
    }

    const onUpdaterError = (error: Error) => {
      ctx.setIsInstallingUpdate(false)
      appUpdateService.updateDiagnostics({
        phase: 'failed',
        lastError: String(error),
        lastEvent: '下载或安装更新失败'
      })
      ctx.getLogService()?.error('AppUpdate', '下载或安装更新失败', {
        targetVersion,
        error: String(error),
        fallbackToFull: appUpdateService.getCachedUpdateInfo()?.diagnostics?.fallbackToFull || false
      })
    }

    autoUpdater.on('download-progress', onDownloadProgress)
    autoUpdater.once('update-downloaded', onUpdateDownloaded)
    autoUpdater.once('error', onUpdaterError)

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      ctx.setIsInstallingUpdate(false)
      onUpdaterError(error as Error)
      throw error
    } finally {
      autoUpdater.removeListener('download-progress', onDownloadProgress)
      autoUpdater.removeListener('update-downloaded', onUpdateDownloaded)
      autoUpdater.removeListener('error', onUpdaterError)
    }
  })

}

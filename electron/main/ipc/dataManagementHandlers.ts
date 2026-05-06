import { ipcMain } from 'electron'
import { dataManagementService } from '../../services/dataManagementService'
import type { MainProcessContext } from '../context'

/**
 * 数据管理 IPC。
 * 保留手动解密和增量更新；自动同步事件由 startup.ts 统一广播，避免重复监听。
 */
export function registerDataManagementHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('dataManagement:scanDatabases', async () => {
    return dataManagementService.scanDatabases()
  })

  ipcMain.handle('dataManagement:decryptAll', async () => {
    return dataManagementService.decryptAll()
  })

  ipcMain.handle('dataManagement:decryptSingleDatabase', async (_, filePath: string) => {
    return dataManagementService.decryptSingleDatabase(filePath)
  })

  ipcMain.handle('dataManagement:incrementalUpdate', async () => {
    return dataManagementService.incrementalUpdate()
  })

  ipcMain.handle('dataManagement:getCurrentCachePath', async () => {
    return dataManagementService.getCurrentCachePath()
  })

  ipcMain.handle('dataManagement:getDefaultCachePath', async () => {
    return dataManagementService.getDefaultCachePath()
  })

  ipcMain.handle('dataManagement:migrateCache', async (_, newCachePath: string) => {
    return dataManagementService.migrateCache(newCachePath)
  })

  ipcMain.handle('dataManagement:scanImages', async (_, dirPath: string) => {
    return dataManagementService.scanImages(dirPath)
  })

  ipcMain.handle('dataManagement:decryptImages', async (_, dirPath: string) => {
    return dataManagementService.decryptImages(dirPath)
  })

  ipcMain.handle('dataManagement:getImageDirectories', async () => {
    return dataManagementService.getImageDirectories()
  })

  ipcMain.handle('dataManagement:decryptSingleImage', async (_, filePath: string) => {
    return dataManagementService.decryptSingleImage(filePath)
  })

  ipcMain.handle('dataManagement:checkForUpdates', async () => {
    return dataManagementService.checkForUpdates()
  })

  ipcMain.handle('dataManagement:enableAutoUpdate', async (_, intervalSeconds?: number) => {
    dataManagementService.enableAutoUpdate(intervalSeconds)
    return { success: true }
  })

  ipcMain.handle('dataManagement:disableAutoUpdate', async () => {
    dataManagementService.disableAutoUpdate()
    return { success: true }
  })

  ipcMain.handle('dataManagement:autoIncrementalUpdate', async (_, silent?: boolean) => {
    return dataManagementService.autoIncrementalUpdate(silent)
  })
}

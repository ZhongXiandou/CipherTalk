import { ipcMain, shell } from 'electron'
import type { MainProcessContext } from '../context'
import { codexSubscriptionService } from '../../services/ai/codexSubscriptionService'

export function registerCodexSubscriptionHandlers(ctx: MainProcessContext): void {
  let loginPending = false

  codexSubscriptionService.onStatusChanged((status) => {
    ctx.broadcastToWindows('codexSubscription:statusChanged', status)
    if (!loginPending || !status.authenticated) return
    loginPending = false
    const mainWindow = ctx.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  ipcMain.handle('codexSubscription:getStatus', async () => codexSubscriptionService.getStatus())

  ipcMain.handle('codexSubscription:login', async () => {
    try {
      const result = await codexSubscriptionService.startLogin()
      loginPending = true
      await shell.openExternal(result.authUrl)
      return { success: true, loginId: result.loginId }
    } catch (error) {
      loginPending = false
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('codexSubscription:logout', async () => {
    try {
      loginPending = false
      await codexSubscriptionService.logout()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('codexSubscription:listModels', async () => {
    try {
      const models = await codexSubscriptionService.listModels()
      return { success: true, models }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

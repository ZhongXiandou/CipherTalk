import { ipcMain } from 'electron'
import { analyticsService } from '../../services/analyticsService'
import type { MainProcessContext } from '../context'

/**
 * 全局数据分析 IPC。
 * 仅转发统计服务，避免入口文件承载业务查询细节。
 */
export function registerAnalyticsHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('analytics:getOverallStatistics', async () => {
    return analyticsService.getOverallStatistics()
  })

  ipcMain.handle('analytics:getContactRankings', async (_, limit?: number) => {
    return analyticsService.getContactRankings(limit)
  })

  ipcMain.handle('analytics:getTimeDistribution', async () => {
    return analyticsService.getTimeDistribution()
  })

  // 群聊分析相关

}

import { ipcMain } from 'electron'
import { annualReportService } from '../../services/annualReportService'
import type { MainProcessContext } from '../context'

/**
 * 年度报告 IPC。
 * 报告生成仍保持原 service 返回结构，后续可单独拆成任务队列。
 */
export function registerAnnualReportHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('annualReport:getAvailableYears', async () => {
    return annualReportService.getAvailableYears()
  })

  ipcMain.handle('annualReport:generateReport', async (_, year: number) => {
    return annualReportService.generateReport(year)
  })

  // 激活相关

}

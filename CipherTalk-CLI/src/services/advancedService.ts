import { searchMessages } from './searchService.js'
import { exportChat as runExportChat } from './export/exportService.js'
import { analyticsService } from './analytics/analyticsService.js'
import { runMcpServe } from './mcp/runtime.js'
import { getMomentsTimeline } from './sns/snsService.js'
import { generateReport } from './report/reportService.js'
import type {
  AdvancedService,
  SearchResult,
  StatsOptions,
  ExportOptions,
  MomentsOptions,
  MomentsResult,
  ReportOptions,
  ReportResult
} from './types.js'
import type { RuntimeConfig } from '../types.js'

export class RealAdvancedService implements AdvancedService {
  async search(
    config: RuntimeConfig,
    keyword: string,
    options?: { session?: string; limit?: number; from?: string; to?: string }
  ): Promise<SearchResult> {
    return searchMessages(config, keyword, options || {})
  }

  async stats(config: RuntimeConfig, opts: StatsOptions): Promise<any> {
    return analyticsService.run(config, opts)
  }

  async exportChat(config: RuntimeConfig, opts: ExportOptions): Promise<{ path: string; count: number }> {
    return runExportChat(config, opts)
  }

  async moments(config: RuntimeConfig, options: MomentsOptions = {}): Promise<MomentsResult> {
    return getMomentsTimeline(config, options)
  }

  async report(config: RuntimeConfig, options: ReportOptions = {}): Promise<ReportResult> {
    return generateReport(config, options)
  }

  async mcpServe(): Promise<never> {
    return runMcpServe()
  }
}

export const advancedService = new RealAdvancedService()

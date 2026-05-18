import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerReportCommand(program: Command, context: CommandContext): void {
  const report = program
    .command('report')
    .description('年度报告数据')
    .option('--year <year>', '年份（默认当前年）')
    .option('--all-time', '全时间范围')
    .option('--session <id>', '只统计指定会话')
    .option('--top-contacts <n>', '联系人榜数量')
    .option('--top-keywords <n>', '关键词榜数量')
    .action(async () => {
      await runCommand(report, context, async (config, options) => {
        const year = typeof options.year === 'string' ? Number(options.year) : undefined
        const topContacts = typeof options.topContacts === 'string' ? Number(options.topContacts) : undefined
        const topKeywords = typeof options.topKeywords === 'string' ? Number(options.topKeywords) : undefined
        const result = await context.services.advanced.report(config, {
          year: Number.isFinite(year) ? year : undefined,
          allTime: options.allTime === true,
          session: typeof options.session === 'string' ? options.session : undefined,
          topContacts: Number.isFinite(topContacts) ? topContacts : undefined,
          topKeywords: Number.isFinite(topKeywords) ? topKeywords : undefined
        })
        return {
          data: result,
          meta: {
            scope: result.scope,
            year: result.year,
            sessionId: result.sessionId,
            ...(result.meta || {})
          }
        }
      })
    })
}

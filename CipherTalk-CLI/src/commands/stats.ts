import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'
import type { StatsOptions } from '../services/types.js'

export function registerStatsCommand(program: Command, context: CommandContext): void {
  const stats = program.command('stats').description('统计分析')

  stats
    .command('global')
    .description('全局统计')
    .option('--from <datetime>', '开始时间')
    .option('--to <datetime>', '结束时间')
    .action(async () => {
      await runCommand(stats, context, async (config) => {
        const result = await context.services.advanced.stats(config, { type: 'global' })
        return { data: result }
      })
    })

  stats
    .command('contacts')
    .description('联系人消息量排名')
    .option('--top <n>', '显示前 n 个', '20')
    .action(async () => {
      await runCommand(stats, context, async (config, options) => {
        const result = await context.services.advanced.stats(config, {
          type: 'contacts',
          top: typeof options.top === 'string' ? Number(options.top) : 20
        })
        return { data: result }
      })
    })

  stats
    .command('time')
    .description('时间分布')
    .option('--by <unit>', 'hour | weekday | month', 'month')
    .action(async () => {
      await runCommand(stats, context, async (config) => {
        const result = await context.services.advanced.stats(config, { type: 'time' })
        return { data: result }
      })
    })

  stats
    .command('session')
    .argument('<session>', '会话 ID')
    .description('单个会话统计')
    .action(async (session: string) => {
      await runCommand(stats, context, async (config) => {
        const result = await context.services.advanced.stats(config, { type: 'session', session })
        return { data: result }
      })
    })

  stats
    .command('keywords')
    .argument('<session>', '会话 ID')
    .description('关键词频率分析')
    .option('--top <n>', '显示前 n 个', '30')
    .action(async (session: string) => {
      await runCommand(stats, context, async (config, options) => {
        const result = await context.services.advanced.stats(config, {
          type: 'keywords',
          session,
          top: typeof options.top === 'string' ? Number(options.top) : 30
        })
        return { data: result }
      })
    })

  stats
    .command('group')
    .argument('<group>', '群聊会话 ID')
    .description('群聊统计')
    .action(async (group: string) => {
      await runCommand(stats, context, async (config) => {
        const result = await context.services.advanced.stats(config, { type: 'group', session: group })
        return { data: result }
      })
    })
}

import type { MainProcessContext } from '../../main/context'

const CHECK_INTERVAL_MS = 60 * 60 * 1000
const STARTUP_DELAY_MS = 90_000

class NightlyMemoryService {
  private ctx: MainProcessContext | null = null
  private timer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private running = false

  init(ctx: MainProcessContext): void {
    if (this.timer) return
    this.ctx = ctx
    this.timer = setInterval(() => {
      void this.check()
    }, CHECK_INTERVAL_MS)
    this.startupTimer = setTimeout(() => {
      void this.check()
    }, STARTUP_DELAY_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.ctx = null
  }

  private async check(): Promise<void> {
    if (this.running) return
    const config = this.ctx?.getConfigService()
    if (!config) return
    if (!String(config.get('myWxid') || '').trim()) return
    const provider = config.getAICurrentProvider()
    if (!String(config.getAIProviderConfig(provider)?.apiKey || '').trim()) return
    this.running = true
    try {
      const [{ resolveProviderConfig }, { maybeRunDailyConsolidation }] = await Promise.all([
        import('../agent/resolveProviderConfig'),
        import('../agent/tools/memory')
      ])
      await maybeRunDailyConsolidation(resolveProviderConfig())
      this.ctx?.getLogService()?.info('NightlyMemory', '夜间记忆整理检查完成')
    } catch (error) {
      this.ctx?.getLogService()?.warn('NightlyMemory', '夜间记忆整理跳过', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.running = false
    }
  }
}

export const nightlyMemoryService = new NightlyMemoryService()

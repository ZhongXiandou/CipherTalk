import { net } from 'electron'
import { ConfigService } from '../services/config'
import { appUpdateService } from '../services/appUpdateService'
import { chatService } from '../services/chatService'
import { httpApiService } from '../services/httpApiService'
import { getMcpProxyConfig } from '../services/mcp/runtime'
import { mcpProxyService } from '../services/mcp/proxyService'
import { mcpClientService } from '../services/mcpClientService'
import { wcdbService } from '../services/wcdbService'
import { monitorBridge } from '../services/monitorBridge'
import type { MainProcessContext } from './context'

async function waitForDevServer(url: string, maxWait = 15000, interval = 300): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const response = await net.fetch(url)
      if (response.ok) return true
    } catch {
      // 开发服务器还没就绪，继续轮询。
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  return false
}

function ensureConfigService(ctx: MainProcessContext): ConfigService {
  const current = ctx.getConfigService()
  if (current) return current

  const configService = new ConfigService()
  ctx.setConfigService(configService)
  return configService
}

/**
 * 启动阶段数据库连接编排。
 * 配置不完整时打开引导窗口；配置完整时用启动屏承接连接过程，并把结果写回 context。
 */
export async function checkAndConnectOnStartup(ctx: MainProcessContext): Promise<boolean> {
  const configService = ensureConfigService(ctx)

  const wxid = configService.get('myWxid')
  const dbPath = configService.get('dbPath')
  const decryptKey = configService.get('decryptKey')

  if (!wxid || !dbPath || !decryptKey) {
    ctx.getWindowManager().openWelcomeWindow()
    return false
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    const serverReady = await waitForDevServer(process.env.VITE_DEV_SERVER_URL)
    if (!serverReady) {
      try {
        const result = await chatService.connect()
        ctx.setStartupDbConnected(result.success)
        return result.success
      } catch {
        return false
      }
    }
  }

  ctx.getWindowManager().createSplashWindow()
  ctx.setSplashReady(false)

  return new Promise<boolean>((resolve) => {
    const checkReady = setInterval(() => {
      if (ctx.getSplashReady()) {
        clearInterval(checkReady)
        chatService.connect().then(async (result) => {
          await ctx.getWindowManager().closeSplashWindow()
          ctx.setStartupDbConnected(result.success)
          resolve(result.success)
        }).catch(async (e) => {
          console.error('启动时连接数据库失败:', e)
          await ctx.getWindowManager().closeSplashWindow()
          resolve(false)
        })
      }
    }, 100)

    // 超时保护：避免启动屏 IPC 没回来时应用卡在启动页。
    setTimeout(async () => {
      clearInterval(checkReady)
      const currentSplashWindow = ctx.getSplashWindow()
      if (currentSplashWindow && !currentSplashWindow.isDestroyed()) {
        await ctx.getWindowManager().closeSplashWindow()
      }
      if (!ctx.getSplashReady()) {
        resolve(false)
      }
    }, 30000)
  })
}

/**
 * 启动时自动检测应用更新。
 * 只在生产环境触发，结果沿用 app:updateAvailable 推送给主窗口。
 */
export function checkForUpdatesOnStartup(ctx: MainProcessContext): void {
  if (process.env.VITE_DEV_SERVER_URL) return

  setTimeout(async () => {
    try {
      const result = await appUpdateService.checkForUpdates()
      ctx.getLogService()?.info('AppUpdate', '启动时检查更新完成', {
        hasUpdate: result.hasUpdate,
        currentVersion: result.currentVersion,
        version: result.version,
        diagnostics: result.diagnostics
      })

      const mainWindow = ctx.getMainWindow()
      if (result.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:updateAvailable', result)
      }
    } catch (error) {
      ctx.getLogService()?.error('AppUpdate', '启动时检查更新失败', { error: String(error) })
      console.error('启动时检查更新失败:', error)
    }
  }, 3000)
}

/**
 * 聊天自动同步和数据库变更监听。
 * 通过 wcdbService（WCDB Worker 代理）+ monitorBridge（native pipe 优先，fs.watch 兜底）
 * 订阅 db_storage 层的变更，再经 chatService.attachMonitor 转发给业务侧。
 */
export function startBackgroundSync(ctx: MainProcessContext): void {
  chatService.on('sessions-update-available', (sessions) => {
    ctx.broadcastToWindows('chat:sessions-updated', sessions)
  })

  // 初始化 WCDB Worker + 订阅变更。无配置时静默跳过，等待用户在 Welcome 页完成配置。
  void (async () => {
    try {
      await wcdbService.initWorker()
    } catch (e) {
      console.warn('[startup] wcdbService.initWorker 失败，monitor 将跳过:', (e as Error)?.message || e)
      return
    }

    const configService = ensureConfigService(ctx)
    const dbPath = String(configService.get('dbPath') || '').trim()
    const decryptKey = String(configService.get('decryptKey') || '').trim()
    const wxid = String(configService.get('myWxid') || '').trim()

    if (!dbPath || !decryptKey || !wxid) {
      // 首启未配置：不启动 monitor，由 Welcome 引导完成后再触发。
      return
    }

    let opened = false
    try {
      opened = await wcdbService.open(dbPath, decryptKey, wxid)
    } catch (e) {
      console.warn('[startup] wcdbService.open 失败:', (e as Error)?.message || e)
      return
    }
    if (!opened) return

    let nativeOk = false
    try {
      nativeOk = await wcdbService.setMonitor()
    } catch (e) {
      console.warn('[startup] wcdbService.setMonitor 异常，走 fs.watch 兜底:', (e as Error)?.message || e)
    }

    if (nativeOk) {
      monitorBridge.switchToNativePipe(wcdbService)
    } else {
      await monitorBridge.start()
    }

    // 把 monitorBridge 的 change 事件桥接给 chatService，供业务层订阅 'dbChange'。
    if (typeof (chatService as any).attachMonitor === 'function') {
      (chatService as any).attachMonitor(monitorBridge)
    }
  })()
}

/**
 * 启动本地 HTTP API、MCP 代理和 MCP 客户端连接恢复。
 * 这些服务依赖配置，但不依赖窗口实例，因此放在启动编排层统一管理。
 */
export async function startLocalIntegrationServices(ctx: MainProcessContext): Promise<void> {
  const configService = ctx.getConfigService()

  const httpApiEnabled = configService?.get('httpApiEnabled') ?? false
  const httpApiPort = configService?.get('httpApiPort') || 5031
  const httpApiToken = (configService?.get('httpApiToken') || '').toString()
  const configuredHttpApiListenMode = configService?.get('httpApiListenMode') === 'lan' ? 'lan' : 'localhost'
  const httpApiListenMode = configuredHttpApiListenMode === 'lan' && !httpApiToken ? 'localhost' : configuredHttpApiListenMode
  httpApiService.applySettings({
    enabled: Boolean(httpApiEnabled),
    port: Number(httpApiPort) || 5031,
    token: httpApiToken,
    listenMode: httpApiListenMode
  })
  const httpApiStartResult = await httpApiService.start()
  if (!httpApiStartResult.success) {
    console.error('[HttpApi] 启动失败:', httpApiStartResult.error)
  }

  const mcpProxyConfig = getMcpProxyConfig(configService ?? undefined)
  mcpProxyService.applySettings({
    host: mcpProxyConfig.host,
    port: mcpProxyConfig.port,
    token: mcpProxyConfig.token
  })
  const mcpProxyStartResult = await mcpProxyService.start()
  if (!mcpProxyStartResult.success) {
    console.error('[McpProxy] 启动失败:', mcpProxyStartResult.error)
    ctx.getLogService()?.error('McpProxy', '内部 MCP 代理启动失败', { error: mcpProxyStartResult.error })
  }
  mcpClientService.restoreSavedConnections().catch((e) => {
    console.error('[McpClient] 自动恢复连接失败:', e)
  })
}

export function stopLocalIntegrationServices(): void {
  httpApiService.stop().catch((e) => {
    console.error('[HttpApi] 停止失败:', e)
  })
  mcpProxyService.stop().catch((e) => {
    console.error('[McpProxy] 停止失败:', e)
  })
  mcpClientService.disconnectAll(false).catch((e) => {
    console.error('[McpClient] 停止失败:', e)
  })
}

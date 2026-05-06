import { net } from 'electron'
import { ConfigService } from '../services/config'
import { appUpdateService } from '../services/appUpdateService'
import { chatService } from '../services/chatService'
import { dataManagementService } from '../services/dataManagementService'
import { httpApiService } from '../services/httpApiService'
import { getMcpProxyConfig } from '../services/mcp/runtime'
import { mcpProxyService } from '../services/mcp/proxyService'
import { mcpClientService } from '../services/mcpClientService'
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
 * 聊天自动同步和数据自动增量解密。
 * dataManagement 发现源文件更新后先静默增量解密，再重新连接聊天库并触发会话刷新。
 */
export function startBackgroundSync(ctx: MainProcessContext): void {
  chatService.on('sessions-update-available', (sessions) => {
    ctx.broadcastToWindows('chat:sessions-updated', sessions)
  })

  chatService.startAutoSync(5000)

  dataManagementService.onUpdateAvailable((hasUpdate) => {
    ctx.broadcastToWindows('dataManagement:updateAvailable', hasUpdate)

    if (hasUpdate) {
      dataManagementService.autoIncrementalUpdate(true).then(result => {
        if (result.success && result.updated) {
          chatService.connect().then(connectResult => {
            if (connectResult.success) {
              chatService.startAutoSync(5000)
              chatService.checkUpdates(true)
            }
          })
        }
      }).catch(() => {
        // 静默自动更新失败不打断主流程，手动更新入口会返回具体错误。
      })
    }
  })

  // 首次全量扫描可能触发较多同步 IO，延后到窗口启动后再跑，避免抢占首屏。
  setTimeout(() => {
    dataManagementService.checkForUpdates().then(result => {
      if (result.hasUpdate) {
        dataManagementService.autoIncrementalUpdate(true).then(res => {
          if (res.success && res.updated) {
            chatService.connect().then(connectResult => {
              if (connectResult.success) {
                chatService.startAutoSync(5000)
                chatService.checkUpdates(true)
              }
            })
          }
        }).catch(console.error)
      }
    })

    dataManagementService.enableAutoUpdate(60)
  }, 3000)
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

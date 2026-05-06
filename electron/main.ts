import { app, BrowserWindow, protocol, type Tray } from 'electron'
import { randomBytes } from 'crypto'
import { autoUpdater } from 'electron-updater'
import { DatabaseService } from './services/database'
import { ConfigService } from './services/config'
import { LogService } from './services/logService'
import type { MainProcessContext, WindowManager } from './main/context'
import { createWindowManager } from './main/windows/windowManager'
import { registerModularIpcHandlers } from './main/ipc/register'
import { registerLocalProtocols } from './main/protocols'
import {
  checkAndConnectOnStartup,
  checkForUpdatesOnStartup,
  startBackgroundSync,
  startLocalIntegrationServices,
  stopLocalIntegrationServices
} from './main/startup'

type AppWithQuitFlag = typeof app & {
  isQuitting?: boolean
}

const appWithQuitFlag = app as AppWithQuitFlag

// 注册自定义协议为特权协议（必须在 app ready 之前）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-video',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'local-image',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  }
])

// 配置自动更新
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableDifferentialDownload = true  // 禁用差分更新，统一使用全量安装包

// 单例服务
let dbService: DatabaseService | null = null

let configService: ConfigService | null = null
let logService: LogService | null = null

// 系统托盘实例
let tray: Tray | null = null
let isInstallingUpdate = false

// 主窗口引用
let mainWindow: BrowserWindow | null = null
// 启动屏窗口引用
let splashWindow: BrowserWindow | null = null
// 启动屏就绪状态
let splashReady = false
// 启动时是否已成功连接数据库（用于通知主窗口跳过重复连接）
let startupDbConnected = false

const allowDevTools = !!process.env.VITE_DEV_SERVER_URL
let windowManager: WindowManager | null = null

const ctx: MainProcessContext = {
  appWithQuitFlag,
  allowDevTools,
  getDbService: () => dbService,
  setDbService: (service) => {
    dbService = service
  },
  getConfigService: () => configService,
  setConfigService: (service) => {
    configService = service
  },
  getLogService: () => logService,
  setLogService: (service) => {
    logService = service
  },
  getMainWindow: () => mainWindow,
  setMainWindow: (window) => {
    mainWindow = window
  },
  getSplashWindow: () => splashWindow,
  setSplashWindow: (window) => {
    splashWindow = window
  },
  getTray: () => tray,
  setTray: (nextTray) => {
    tray = nextTray
  },
  getSplashReady: () => splashReady,
  setSplashReady: (ready) => {
    splashReady = ready
  },
  getStartupDbConnected: () => startupDbConnected,
  setStartupDbConnected: (connected) => {
    startupDbConnected = connected
  },
  getIsInstallingUpdate: () => isInstallingUpdate,
  setIsInstallingUpdate: (installing) => {
    isInstallingUpdate = installing
  },
  broadcastToWindows: (channel, ...args) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    })
  },
  getWindowManager: () => {
    if (!windowManager) {
      throw new Error('WindowManager 未初始化')
    }
    return windowManager
  },
  setWindowManager: (manager) => {
    windowManager = manager
  }
}

ctx.setWindowManager(createWindowManager(ctx))

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // 只对微信域名忽略证书错误
  if (url.includes('weixin.qq.com') || url.includes('wechat.com')) {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})

app.whenReady().then(async () => {
  if (!configService) {
    configService = new ConfigService()
  }

  ctx.getWindowManager().setDockIcon()

  if (!configService.get('mcpProxyToken')) {
    configService.set('mcpProxyToken', randomBytes(24).toString('hex'))
  }

  // 注册自定义协议用于加载本地视频
  registerLocalProtocols()

  registerModularIpcHandlers(ctx)

  // 监听增量更新事件
  startBackgroundSync(ctx)

  const shouldShowSplash = await checkAndConnectOnStartup(ctx)

  // 启动本地 HTTP API（默认 127.0.0.1:5031）
  await startLocalIntegrationServices(ctx)

  if (shouldShowSplash !== false || configService?.get('myWxid')) {
    // 创建主窗口（但不立即显示）
    ctx.getWindowManager().createMainWindow()

    // 创建系统托盘
    ctx.getWindowManager().createTray()
  }

  // 如果显示了启动屏，主窗口会在启动屏关闭后自动显示（通过 ready-to-show 事件）
  // 如果没有显示启动屏，主窗口会正常显示（通过 ready-to-show 事件）

  // 启动时检测更新
  checkForUpdatesOnStartup(ctx)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      ctx.getWindowManager().createMainWindow()
      ctx.getWindowManager().createTray()
    }
  })
})

app.on('window-all-closed', () => {
  // macOS 上保持应用运行
  if (process.platform !== 'darwin') {
    // 如果托盘存在，不退出应用
    if (!tray) {
      app.quit()
    }
  }
})

app.on('before-quit', () => {
  // 设置退出标志
  appWithQuitFlag.isQuitting = true

  stopLocalIntegrationServices()

  configService?.close()

  // 销毁托盘
  ctx.getWindowManager().destroyTray()
})

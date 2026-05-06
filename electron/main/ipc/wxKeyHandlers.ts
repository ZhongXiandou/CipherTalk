import { ipcMain } from 'electron'
import { dbPathService } from '../../services/dbPathService'
import { wcdbService } from '../../services/wcdbService'
import { wxKeyService } from '../../services/wxKeyService'
import { wxKeyServiceMac } from '../../services/wxKeyServiceMac'
import type { MainProcessContext } from '../context'

/**
 * 微信密钥获取 IPC。
 * macOS 和 Windows 流程不同，wxkey:status 是前端步骤提示依赖的进度事件。
 */
export function registerWxKeyHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('wxkey:isWeChatRunning', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.isWeChatRunning()
    }
    return wxKeyService.isWeChatRunning()
  })

  ipcMain.handle('wxkey:getWeChatPid', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.getWeChatPid()
    }
    return wxKeyService.getWeChatPid()
  })

  ipcMain.handle('wxkey:killWeChat', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.killWeChat()
    }
    return wxKeyService.killWeChat()
  })

  ipcMain.handle('wxkey:launchWeChat', async (_, customWechatPath?: string) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.launchWeChat(customWechatPath)
    }
    return wxKeyService.launchWeChat(customWechatPath)
  })

  ipcMain.handle('wxkey:waitForWindow', async (_, maxWaitSeconds?: number) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.waitForWeChatWindow(maxWaitSeconds)
    }
    return wxKeyService.waitForWeChatWindow(maxWaitSeconds)
  })

  ipcMain.handle('wxkey:startGetKey', async (event, customWechatPath?: string, dbPath?: string) => {
    ctx.getLogService()?.info('WxKey', '开始获取微信密钥', { customWechatPath })
    if (process.platform === 'darwin') {
      try {
        const isRunning = wxKeyServiceMac.isWeChatRunning()
        if (isRunning) {
          event.sender.send('wxkey:status', { status: '检测到微信正在运行，正在关闭微信...', level: 0 })
          wxKeyServiceMac.killWeChat()

          const exited = await wxKeyServiceMac.waitForWeChatExit(20)
          if (!exited) {
            return { success: false, error: '未能自动关闭微信，请先手动退出微信后重试' }
          }

          event.sender.send('wxkey:status', { status: '微信已关闭，正在重新启动微信...', level: 0 })
          const relaunched = await wxKeyServiceMac.launchWeChat(customWechatPath)
          if (!relaunched) {
            return { success: false, error: '微信关闭后自动重启失败' }
          }

          event.sender.send('wxkey:status', { status: '微信已重新启动，等待主进程就绪...', level: 0 })
          const ready = await wxKeyServiceMac.waitForWeChatWindow(20)
          if (!ready) {
            return { success: false, error: '微信已重新启动，但未检测到可用主进程，请确认微信已完成启动并显示主窗口' }
          }
        } else {
          event.sender.send('wxkey:status', { status: '未检测到微信主进程，正在尝试启动微信...', level: 0 })

          const launched = await wxKeyServiceMac.launchWeChat(customWechatPath)
          if (!launched) {
            return { success: false, error: '未找到微信主进程，且自动启动微信失败' }
          }

          event.sender.send('wxkey:status', { status: '微信已启动，等待主进程就绪...', level: 0 })
          const ready = await wxKeyServiceMac.waitForWeChatWindow(20)
          if (!ready) {
            return { success: false, error: '微信已启动，但未检测到可用主进程，请确认微信已完成启动并显示主窗口' }
          }
        }

        const result = await wxKeyServiceMac.autoGetDbKey(180_000, (status, level) => {
          event.sender.send('wxkey:status', { status, level })
        })

        if (!result.success) {
          ctx.getLogService()?.warn('WxKey', 'macOS 数据库密钥获取失败', { error: result.error })
          return result
        }

        if (result.key && dbPath) {
          event.sender.send('wxkey:status', { status: '已获取候选密钥，正在验证数据库...', level: 0 })

          const wxidCandidates: string[] = []
          const pushWxid = (value?: string | null) => {
            const wxid = String(value || '').trim()
            if (!wxid || wxidCandidates.includes(wxid)) return
            wxidCandidates.push(wxid)
          }

          let currentAccount = wxKeyServiceMac.detectCurrentAccount(dbPath, 10)
          if (!currentAccount) {
            currentAccount = wxKeyServiceMac.detectCurrentAccount(dbPath, 60)
          }
          pushWxid(currentAccount?.wxid)

          try {
            const scannedWxids = dbPathService.scanWxids(dbPath)
            for (const wxid of scannedWxids) {
              pushWxid(wxid)
            }
          } catch {
            // ignore
          }

          let validatedWxid = ''
          let lastError = ''
          for (const wxid of wxidCandidates) {
            event.sender.send('wxkey:status', { status: `正在验证账号目录: ${wxid}`, level: 0 })
            const testResult = await wcdbService.testConnection(dbPath, result.key, wxid)
            if (testResult.success) {
              validatedWxid = wxid
              break
            }
            lastError = testResult.error || ''
          }

          if (!validatedWxid) {
            ctx.getLogService()?.warn('WxKey', 'macOS 候选密钥未通过数据库验证', {
              dbPath,
              candidateCount: wxidCandidates.length
            })
            return {
              success: false,
              error: lastError || '已捕获到候选密钥，但未通过数据库验证。请在微信完成登录后进入任意聊天，让数据库访问真正触发，再重试。'
            }
          }

          ctx.getLogService()?.info('WxKey', 'macOS 候选密钥已通过数据库验证', { dbPath, wxid: validatedWxid })
          return {
            ...result,
            validatedWxid
          }
        }

        ctx.getLogService()?.info('WxKey', 'macOS 数据库密钥获取成功', { keyLength: result.key?.length || 0 })
        return result
      } catch (e) {
        wxKeyServiceMac.dispose()
        ctx.getLogService()?.error('WxKey', 'macOS 获取密钥异常', { error: String(e) })
        return { success: false, error: String(e) }
      }
    }

    try {
      // 初始化 DLL
      const initSuccess = await wxKeyService.initialize()
      if (!initSuccess) {
        ctx.getLogService()?.error('WxKey', 'DLL 初始化失败')
        return { success: false, error: 'DLL 初始化失败' }
      }

      // 检查微信是否已运行，如果运行则先关闭
      if (wxKeyService.isWeChatRunning()) {
        ctx.getLogService()?.info('WxKey', '检测到微信正在运行，准备关闭')
        event.sender.send('wxkey:status', { status: '检测到微信正在运行，准备关闭...', level: 1 })
        wxKeyService.killWeChat()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      // 发送状态：准备启动微信
      event.sender.send('wxkey:status', { status: '正在安装 Hook...', level: 1 })

      // 获取微信路径
      const wechatPath = customWechatPath || wxKeyService.getWeChatPath()
      if (!wechatPath) {
        ctx.getLogService()?.error('WxKey', '未找到微信安装路径')
        return { success: false, error: '未找到微信安装路径', needManualPath: true }
      }

      ctx.getLogService()?.info('WxKey', '找到微信路径', { wechatPath })
      event.sender.send('wxkey:status', { status: 'Hook 安装成功，正在启动微信...', level: 1 })

      // 启动微信
      const launchSuccess = await wxKeyService.launchWeChat(customWechatPath)
      if (!launchSuccess) {
        ctx.getLogService()?.error('WxKey', '启动微信失败')
        return { success: false, error: '启动微信失败' }
      }

      // 等待微信进程出现
      event.sender.send('wxkey:status', { status: '等待微信进程启动...', level: 1 })
      const windowAppeared = await wxKeyService.waitForWeChatWindow(15)
      if (!windowAppeared) {
        ctx.getLogService()?.error('WxKey', '微信进程启动超时')
        return { success: false, error: '微信进程启动超时' }
      }

      // 获取微信 PID
      const pid = wxKeyService.getWeChatPid()
      if (!pid) {
        ctx.getLogService()?.error('WxKey', '未找到微信进程')
        return { success: false, error: '未找到微信进程' }
      }

      ctx.getLogService()?.info('WxKey', '找到微信进程', { pid })
      event.sender.send('wxkey:status', { status: '正在注入 Hook...', level: 1 })

      // 创建 Promise 等待密钥
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          wxKeyService.dispose()
          ctx.getLogService()?.error('WxKey', '获取密钥超时')
          resolve({ success: false, error: '获取密钥超时' })
        }, 60000)

        const success = wxKeyService.installHook(
          pid,
          (key) => {
            clearTimeout(timeout)
            wxKeyService.dispose()
            ctx.getLogService()?.info('WxKey', '密钥获取成功', { keyLength: key.length })
            resolve({ success: true, key })
          },
          (status, level) => {
            // 发送状态到渲染进程
            event.sender.send('wxkey:status', { status, level })
          }
        )

        if (!success) {
          clearTimeout(timeout)
          const error = wxKeyService.getLastError()
          wxKeyService.dispose()
          ctx.getLogService()?.error('WxKey', 'Hook 安装失败', { error })
          resolve({ success: false, error: `Hook 安装失败: ${error}` })
        }
      })
    } catch (e) {
      wxKeyService.dispose()
      ctx.getLogService()?.error('WxKey', '获取密钥异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('wxkey:cancel', async () => {
    if (process.platform === 'darwin') {
      wxKeyServiceMac.dispose()
      return true
    }
    wxKeyService.dispose()
    return true
  })

  ipcMain.handle('wxkey:detectCurrentAccount', async (_, dbPath?: string, maxTimeDiffMinutes?: number) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.detectCurrentAccount(dbPath, maxTimeDiffMinutes)
    }
    return wxKeyService.detectCurrentAccount(dbPath, maxTimeDiffMinutes)
  })

  // 数据库路径相关

}

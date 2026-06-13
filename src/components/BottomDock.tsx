import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Home, MessageSquare, Database, Settings,
  Download, Aperture, Network, FileAudio, Boxes, Smartphone,
  type LucideIcon
} from 'lucide-react'
import MacOSDock, { type DockApp } from '@/components/ui/mac-os-dock'
import { useThemeStore } from '@/stores/themeStore'
import { useDeviceConnectStatus } from '@/hooks/useDeviceConnectStatus'
import { DeviceConnectStatusDot } from '@/components/DeviceConnectStatusDot'

const HIDE_DELAY = 2500
const EDGE_TRIGGER_PX = 8

interface AppIconProps {
  Icon: LucideIcon
  gradient: string
}

function AppIcon({ Icon, gradient }: AppIconProps) {
  return (
    <div
      className="w-full h-full flex items-center justify-center"
      style={{
        background: gradient,
        borderRadius: '28%',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.25), inset 0 -1px 0 rgba(0,0,0,0.15)'
      }}
    >
      <Icon className="w-[58%] h-[58%] text-white" strokeWidth={2} />
    </div>
  )
}

const makeIcon = (Icon: LucideIcon, gradient: string): ReactNode => (
  <AppIcon Icon={Icon} gradient={gradient} />
)

function BottomDock() {
  const navigate = useNavigate()
  const location = useLocation()
  const autoHideSetting = useThemeStore(s => s.dockAutoHide)
  const deviceStatus = useDeviceConnectStatus()
  // 首页强制显示 Dock：避免用户进入软件后找不到导航
  const autoHide = autoHideSetting && location.pathname !== '/home'
  const [visible, setVisible] = useState(true)
  const hideTimerRef = useRef<number | undefined>(undefined)

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== undefined) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = undefined
    }
  }, [])

  const scheduleHide = useCallback(() => {
    if (!autoHide) return
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => setVisible(false), HIDE_DELAY)
  }, [autoHide, clearHideTimer])

  // 自动收起开关变化时重置状态
  useEffect(() => {
    clearHideTimer()
    if (autoHide) {
      setVisible(true)
      scheduleHide()
    } else {
      setVisible(true)
    }
    return clearHideTimer
  }, [autoHide, clearHideTimer, scheduleHide])

  // 鼠标接近屏幕底部时浮出
  useEffect(() => {
    if (!autoHide) return
    const handler = (e: MouseEvent) => {
      if (e.clientY >= window.innerHeight - EDGE_TRIGGER_PX) {
        clearHideTimer()
        setVisible(true)
        scheduleHide()
      }
    }
    window.addEventListener('mousemove', handler)
    return () => window.removeEventListener('mousemove', handler)
  }, [autoHide, clearHideTimer, scheduleHide])

  const handleMouseEnter = () => {
    clearHideTimer()
    setVisible(true)
  }

  const handleMouseLeave = () => {
    scheduleHide()
  }

  const openChatWindow = async () => {
    try { await window.electronAPI.window.openChatWindow() }
    catch (e) { console.error('打开聊天窗口失败:', e) }
  }

  const openMomentsWindow = async () => {
    try { await window.electronAPI.window.openMomentsWindow() }
    catch (e) { console.error('打开朋友圈窗口失败:', e) }
  }

  const apps: DockApp[] = [
    { id: 'home', name: '首页', icon: makeIcon(Home, 'linear-gradient(135deg, #4A90E2 0%, #2E6BC9 100%)') },
    { id: 'chat', name: '聊天查看', icon: makeIcon(MessageSquare, 'linear-gradient(135deg, #2ECC71 0%, #27AE60 100%)') },
    { id: 'moments', name: '朋友圈', icon: makeIcon(Aperture, 'linear-gradient(135deg, #FF7AA2 0%, #E84B7E 100%)') },
    { id: 'transcription', name: '转文字助手', icon: makeIcon(FileAudio, 'linear-gradient(135deg, #5B6CFF 0%, #3F50E0 100%)') },
    { id: 'device-connect', name: '设备连接', icon: (
      <div className="relative w-full h-full">
        <AppIcon Icon={Smartphone} gradient="linear-gradient(135deg, #1AAD5A 0%, #07C160 100%)" />
        <DeviceConnectStatusDot status={deviceStatus} className="absolute right-[4%] top-[4%] size-[26%] ring-2 ring-white" />
      </div>
    ) },
    { id: 'export', name: '导出数据', icon: makeIcon(Download, 'linear-gradient(135deg, #1ABC9C 0%, #16A085 100%)') },
    { id: 'data-management', name: '数据管理', icon: makeIcon(Database, 'linear-gradient(135deg, #607D8B 0%, #455A64 100%)') },
    { id: 'open-api', name: '开放接口', icon: makeIcon(Network, 'linear-gradient(135deg, #00BCD4 0%, #0097A7 100%)') },
    { id: 'mcp', name: 'MCP & Skills', icon: makeIcon(Boxes, 'linear-gradient(135deg, #EC407A 0%, #C2185B 100%)') },
    { id: 'settings', name: '设置', icon: makeIcon(Settings, 'linear-gradient(135deg, #6E7B85 0%, #424A52 100%)') },
  ]

  const handleAppClick = (appId: string) => {
    switch (appId) {
      case 'home': navigate('/home'); break
      case 'chat': void openChatWindow(); break
      case 'moments': void openMomentsWindow(); break
      case 'transcription': navigate('/transcription-assistant'); break
      case 'device-connect': navigate('/device-connect'); break
      case 'export': navigate('/export'); break
      case 'data-management': navigate('/data-management'); break
      case 'open-api': navigate('/open-api'); break
      case 'mcp': navigate('/mcp'); break
      case 'settings': navigate('/settings'); break
    }
  }

  return (
    <motion.div
      className="fixed inset-x-0 bottom-0 z-40 pointer-events-none flex justify-center"
      style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
      animate={{
        y: visible ? 0 : 140,
        opacity: visible ? 1 : 0
      }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      <div
        className={visible ? 'pointer-events-auto' : 'pointer-events-none'}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <MacOSDock apps={apps} onAppClick={handleAppClick} />
      </div>
    </motion.div>
  )
}

export default BottomDock

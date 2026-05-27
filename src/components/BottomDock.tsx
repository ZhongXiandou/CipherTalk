import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Home, MessageSquare, BarChart3, Users, FileText, Database, Settings,
  Download, Aperture, Network, Bot, FileAudio, Boxes,
  type LucideIcon
} from 'lucide-react'
import MacOSDock, { type DockApp } from '@/components/ui/mac-os-dock'
import { useThemeStore } from '@/stores/themeStore'

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

  const openGroupAnalyticsWindow = async () => {
    try { await window.electronAPI.window.openGroupAnalyticsWindow() }
    catch (e) { console.error('打开群聊分析窗口失败:', e) }
  }

  const openMomentsWindow = async () => {
    try { await window.electronAPI.window.openMomentsWindow() }
    catch (e) { console.error('打开朋友圈窗口失败:', e) }
  }

  const apps: DockApp[] = [
    { id: 'home', name: '首页', icon: makeIcon(Home, 'linear-gradient(135deg, #4A90E2 0%, #2E6BC9 100%)') },
    { id: 'chat', name: '聊天查看', icon: makeIcon(MessageSquare, 'linear-gradient(135deg, #2ECC71 0%, #27AE60 100%)') },
    { id: 'moments', name: '朋友圈', icon: makeIcon(Aperture, 'linear-gradient(135deg, #FF7AA2 0%, #E84B7E 100%)') },
    { id: 'analytics', name: '私聊分析', icon: makeIcon(BarChart3, 'linear-gradient(135deg, #9B59B6 0%, #7A3FA0 100%)') },
    { id: 'group-analytics', name: '群聊分析', icon: makeIcon(Users, 'linear-gradient(135deg, #F39C12 0%, #D67E0E 100%)') },
    { id: 'annual-report', name: '年度报告', icon: makeIcon(FileText, 'linear-gradient(135deg, #E74C3C 0%, #C0392B 100%)') },
    { id: 'transcription', name: '转文字助手', icon: makeIcon(FileAudio, 'linear-gradient(135deg, #5B6CFF 0%, #3F50E0 100%)') },
    { id: 'export', name: '导出数据', icon: makeIcon(Download, 'linear-gradient(135deg, #1ABC9C 0%, #16A085 100%)') },
    { id: 'data-management', name: '数据管理', icon: makeIcon(Database, 'linear-gradient(135deg, #607D8B 0%, #455A64 100%)') },
    { id: 'open-api', name: '开放接口', icon: makeIcon(Network, 'linear-gradient(135deg, #00BCD4 0%, #0097A7 100%)') },
    { id: 'mcp', name: 'MCP & Skills', icon: makeIcon(Boxes, 'linear-gradient(135deg, #EC407A 0%, #C2185B 100%)') },
    { id: 'agent', name: 'Agent', icon: makeIcon(Bot, 'linear-gradient(135deg, #7E57C2 0%, #5E35B1 100%)') },
    { id: 'settings', name: '设置', icon: makeIcon(Settings, 'linear-gradient(135deg, #6E7B85 0%, #424A52 100%)') },
  ]

  const handleAppClick = (appId: string) => {
    switch (appId) {
      case 'home': navigate('/home'); break
      case 'chat': void openChatWindow(); break
      case 'moments': void openMomentsWindow(); break
      case 'analytics': navigate('/analytics'); break
      case 'group-analytics': void openGroupAnalyticsWindow(); break
      case 'annual-report': navigate('/annual-report'); break
      case 'transcription': navigate('/transcription-assistant'); break
      case 'export': navigate('/export'); break
      case 'data-management': navigate('/data-management'); break
      case 'open-api': navigate('/open-api'); break
      case 'mcp': navigate('/mcp'); break
      case 'agent': navigate('/agent'); break
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

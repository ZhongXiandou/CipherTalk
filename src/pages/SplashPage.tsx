import { useEffect, useState } from 'react'
import './SplashPage.scss'

const MESSAGES = [
  '正在校验本地环境',
  '正在连接数据库',
  '正在整理聊天索引',
]

function SplashPage() {
  const [fadeOut, setFadeOut] = useState(false)
  const [msgIdx, setMsgIdx] = useState(0)

  useEffect(() => {
    const readyTimer = setTimeout(() => {
      try {
        // @ts-ignore - splashReady 方法在运行时可用
        window.electronAPI?.window?.splashReady?.()
      } catch (e) {
        console.error('通知启动屏就绪失败:', e)
      }
    }, 1000)

    const msgTimer = setInterval(() => {
      setMsgIdx(prev => (prev + 1) % MESSAGES.length)
    }, 1600)

    const cleanup = window.electronAPI?.window?.onSplashFadeOut?.(() => setFadeOut(true))

    return () => {
      clearTimeout(readyTimer)
      clearInterval(msgTimer)
      cleanup?.()
    }
  }, [])

  return (
    <div className={`splash-page${fadeOut ? ' fade-out' : ''}`}>
      <div className="splash-brand">
        <div className="splash-logo-wrap">
          <img
            className="splash-logo-img"
            src="./logo.png"
            alt="密语"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
              const fb = e.currentTarget.nextElementSibling as HTMLElement | null
              if (fb) fb.style.display = 'grid'
            }}
          />
          <div className="splash-logo-fallback">密语</div>
        </div>

        <div className="splash-app-name">密语</div>
        <div className="splash-app-sub">CipherTalk · 本地聊天记录分析工作台</div>
      </div>

      <div className="splash-status">
        <div className="splash-status-row">
          <span className="splash-dot" />
          <span key={msgIdx} className="splash-status-text">{MESSAGES[msgIdx]}</span>
        </div>
        <div className="splash-progress-track">
          <div className="splash-progress-bar" />
        </div>
      </div>
    </div>
  )
}

export default SplashPage

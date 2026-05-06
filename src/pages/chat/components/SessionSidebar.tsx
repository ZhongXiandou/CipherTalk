import { useEffect, useRef, useState } from 'react'
import { AlertCircle, MessageSquare, RefreshCw, Search, X } from 'lucide-react'
import { List } from 'react-window'
import type { RowComponentProps } from 'react-window'
import MessageContent from '../../../components/MessageContent'
import type { ChatSession } from '../../../types/models'

export interface SessionRowData {
  sessions: ChatSession[]
  currentSessionId: string | null
  onSelect: (s: ChatSession) => void
  formatTime: (t: number) => string
}

export function SessionAvatar({ session, size = 48 }: { session: ChatSession; size?: number }) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isGroup = session.username.includes('@chatroom')

  // 懒加载：使用 IntersectionObserver 检测头像是否进入可视区域
  useEffect(() => {
    if (!containerRef.current) return

    const element = containerRef.current

    // 如果没有 avatarUrl，不需要懒加载
    if (!session.avatarUrl) {
      setIsVisible(false)
      return
    }

    // 使用 IntersectionObserver 监听，不立即加载
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '50px', // 提前 50px 开始加载
        threshold: 0
      }
    )

    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [session.avatarUrl])

  // 当 avatarUrl 变化时重置加载状态（但保持 isVisible，避免闪烁）
  useEffect(() => {
    if (session.avatarUrl) {
      setImageLoaded(false)
      setImageError(false)
      // 不重置 isVisible，避免已经可见的头像重新隐藏
    }
  }, [session.avatarUrl])

  // 检查图片是否已经从缓存加载完成
  useEffect(() => {
    if (isVisible && session.avatarUrl && imgRef.current) {
      // 如果图片已经加载完成（可能是从缓存加载的）
      if (imgRef.current.complete && imgRef.current.naturalWidth > 0) {
        setImageLoaded(true)
        setImageError(false)
      }
    }
  }, [isVisible, session.avatarUrl])

  // 添加超时处理，避免一直显示骨架屏
  useEffect(() => {
    if (!isVisible || !session.avatarUrl || imageLoaded || imageError) return

    const timeoutId = setTimeout(() => {
      // 如果 5 秒后还没加载完成，检查图片状态
      if (imgRef.current) {
        if (imgRef.current.complete) {
          if (imgRef.current.naturalWidth > 0) {
            setImageLoaded(true)
          } else {
            setImageError(true)
          }
        }
      }
    }, 5000)

    return () => clearTimeout(timeoutId)
  }, [isVisible, session.avatarUrl, imageLoaded, imageError])

  const hasValidUrl = session.avatarUrl && !imageError
  const shouldLoadImage = hasValidUrl && isVisible

  return (
    <div
      ref={containerRef}
      className={`session-avatar ${isGroup ? 'group' : ''} ${shouldLoadImage && !imageLoaded && !imageError ? 'loading' : ''}`}
      style={{ width: size, height: size }}
    >
      {shouldLoadImage && !imageError ? (
        <>
          {!imageLoaded && (
            <div className="avatar-skeleton" />
          )}
          <img
            ref={imgRef}
            src={session.avatarUrl}
            alt=""
            className={imageLoaded ? 'loaded' : ''}
            style={{
              opacity: imageLoaded ? 1 : 0,
              transition: 'opacity 0.2s ease-in-out',
              position: imageLoaded ? 'relative' : 'absolute',
              zIndex: imageLoaded ? 1 : 0
            }}
            onLoad={() => {
              setImageLoaded(true)
              setImageError(false)
            }}
            onError={() => {
              setImageError(true)
              setImageLoaded(false)
            }}
            loading="lazy"
          />
        </>
      ) : (
        <div className="avatar-skeleton" />
      )}
    </div>
  )
}

// 会话列表行组件（使用 memo 优化性能）
export const SessionRow = (props: RowComponentProps<SessionRowData>) => {
  const { index, style, sessions, currentSessionId, onSelect, formatTime } = props
  const session = sessions[index]

  return (
    <div
      style={style}
      className={`session-item ${currentSessionId === session.username ? 'active' : ''}`}
      onClick={() => onSelect(session)}
    >
      <SessionAvatar session={session} size={48} />
      <div className="session-info">
        <div className="session-top">
          <span className="session-name">{session.displayName || session.username}</span>
          <span className="session-time">{formatTime(session.lastTimestamp || session.sortTimestamp)}</span>
        </div>
        <div className="session-bottom">
          <span className="session-summary">
            {(() => {
              const summary = session.summary || '暂无消息'
              const firstLine = summary.split('\n')[0]
              const hasMoreLines = summary.includes('\n')
              return (
                <>
                  <MessageContent content={firstLine} disableLinks={true} />
                  {hasMoreLines && <span>...</span>}
                </>
              )
            })()}
          </span>
          {session.unreadCount > 0 && (
            <span className="unread-badge">
              {session.unreadCount > 99 ? '99+' : session.unreadCount}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

interface SessionSidebarProps {
  sidebarRef: React.RefObject<HTMLDivElement | null>
  searchInputRef: React.RefObject<HTMLInputElement | null>
  sidebarWidth: number
  searchKeyword: string
  onSearch: (keyword: string) => void
  onCloseSearch: () => void
  onRefresh: () => void | Promise<void>
  isLoadingSessions: boolean
  isUpdating: boolean
  connectionError: string | null
  onRetryConnect: () => void | Promise<void>
  filteredSessions: ChatSession[]
  currentSessionId: string | null
  onSelectSession: (session: ChatSession) => void
  formatTime: (timestamp: number) => string
}

export function SessionSidebar({
  sidebarRef,
  searchInputRef,
  sidebarWidth,
  searchKeyword,
  onSearch,
  onCloseSearch,
  onRefresh,
  isLoadingSessions,
  isUpdating,
  connectionError,
  onRetryConnect,
  filteredSessions,
  currentSessionId,
  onSelectSession,
  formatTime
}: SessionSidebarProps) {
  return (
    <div
      className="session-sidebar"
      ref={sidebarRef}
      style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}
    >
      <div className="session-header">
        <div className="search-row">
          <div className="search-box expanded">
            <Search size={14} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索"
              value={searchKeyword}
              onChange={(e) => onSearch(e.target.value)}
            />
            {searchKeyword && (
              <button className="close-search" onClick={onCloseSearch}>
                <X size={12} />
              </button>
            )}
          </div>
          <button
            className="icon-btn refresh-btn"
            onClick={onRefresh}
            disabled={isLoadingSessions}
            data-tooltip="刷新会话列表"
          >
            <RefreshCw size={16} className={isLoadingSessions || isUpdating ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {connectionError && (
        <div className="connection-error">
          <AlertCircle size={16} />
          <span>{connectionError}</span>
          <button onClick={onRetryConnect}>重试</button>
        </div>
      )}

      {isLoadingSessions ? (
        <div className="loading-sessions">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton-item">
              <div className="skeleton-avatar" />
              <div className="skeleton-content">
                <div className="skeleton-line" />
                <div className="skeleton-line" />
              </div>
            </div>
          ))}
        </div>
      ) : filteredSessions.length > 0 ? (
        <div className="session-list" style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          {/* @ts-ignore - 类型定义不匹配但不影响运行 */}
          <List
            style={{ height: '100%', width: '100%' }}
            rowCount={filteredSessions.length}
            rowHeight={72}
            rowProps={{
              sessions: filteredSessions,
              currentSessionId,
              onSelect: onSelectSession,
              formatTime
            }}
            rowComponent={SessionRow}
          />
        </div>
      ) : (
        <div className="empty-sessions">
          <MessageSquare />
          <p>暂无会话</p>
          <p className="hint">请先在数据管理页面解密数据库</p>
        </div>
      )}
    </div>
  )
}


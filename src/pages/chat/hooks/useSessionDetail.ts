import { useCallback, useState } from 'react'
import type { SessionDetail } from '../types'

export function useSessionDetail(currentSessionId: string | null) {
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [isDetailClosing, setIsDetailClosing] = useState(false)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)

  const loadSessionDetail = useCallback(async (sessionId: string) => {
    setIsLoadingDetail(true)
    try {
      const result = await window.electronAPI.chat.getSessionDetail(sessionId)
      if (result.success && result.detail) {
        setSessionDetail(result.detail)
      }
    } catch (e) {
      console.error('加载会话详情失败:', e)
    } finally {
      setIsLoadingDetail(false)
    }
  }, [])

  const closeDetailPanel = useCallback(() => {
    setIsDetailClosing(true)
    setTimeout(() => {
      setShowDetailPanel(false)
      setIsDetailClosing(false)
    }, 220)
  }, [])

  const toggleDetailPanel = useCallback(() => {
    if (showDetailPanel) {
      closeDetailPanel()
    } else {
      if (currentSessionId) void loadSessionDetail(currentSessionId)
      setShowDetailPanel(true)
    }
  }, [showDetailPanel, currentSessionId, loadSessionDetail, closeDetailPanel])

  return {
    showDetailPanel,
    isDetailClosing,
    sessionDetail,
    isLoadingDetail,
    setSessionDetail,
    loadSessionDetail,
    closeDetailPanel,
    toggleDetailPanel
  }
}

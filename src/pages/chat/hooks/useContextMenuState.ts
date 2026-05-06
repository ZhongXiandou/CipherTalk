import { useCallback, useState } from 'react'
import type { ContextMenuState } from '../types'

export function useContextMenuState() {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [isMenuClosing, setIsMenuClosing] = useState(false)

  const closeContextMenu = useCallback(() => {
    setIsMenuClosing(true)
  }, [])

  return {
    contextMenu,
    setContextMenu,
    isMenuClosing,
    setIsMenuClosing,
    closeContextMenu
  }
}

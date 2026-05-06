import { useCallback, useState } from 'react'
import type { TopToastState } from '../types'

export function useTopToast() {
  const [topToast, setTopToast] = useState<TopToastState | null>(null)

  const showTopToast = useCallback((text: string, success = true) => {
    setTopToast({ text, success })
    setTimeout(() => setTopToast(null), 2000)
  }, [])

  return {
    topToast,
    showTopToast
  }
}

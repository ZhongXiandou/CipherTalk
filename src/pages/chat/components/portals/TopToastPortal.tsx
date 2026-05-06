import { createPortal } from 'react-dom'
import { AlertCircle, Check } from 'lucide-react'
import type { TopToastState } from '../../types'

interface TopToastPortalProps {
  toast: TopToastState | null
}

export function TopToastPortal({ toast }: TopToastPortalProps) {
  if (!toast) return null

  return createPortal(
    <div className={`copy-toast top-toast ${toast.success ? 'success' : 'error'}`}>
      {toast.success ? <Check size={16} /> : <AlertCircle size={16} />}
      <span>{toast.text}</span>
    </div>,
    document.body
  )
}

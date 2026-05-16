import { useNavigate } from 'react-router-dom'
import { Download, ExternalLink } from 'lucide-react'

interface Props {
  sessionId?: string
  sessionName?: string
}

export function ExportCard({ sessionId, sessionName }: Props) {
  const navigate = useNavigate()

  const goToExport = () => {
    navigate('/export', {
      state: { preSelectedSessions: sessionId ? [sessionId] : undefined }
    })
  }

  return (
    <div className="agent-export-card">
      <div className="agent-export-card__title">
        <Download size={14} />
        <span>导出聊天记录</span>
      </div>
      {sessionName && (
        <div className="agent-export-card__session-hint">
          已定位会话：<strong>{sessionName}</strong>
        </div>
      )}
      <button
        type="button"
        className="agent-export-card__submit is-ready"
        onClick={goToExport}
      >
        <ExternalLink size={13} />
        {sessionId ? '在导出页面中打开' : '打开导出页面'}
      </button>
    </div>
  )
}

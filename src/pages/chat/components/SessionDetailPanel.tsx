import { Calendar, Copy, Database, Hash, Loader2, MessageSquare, X } from 'lucide-react'
import type { SessionDetail } from '../types'

interface SessionDetailPanelProps {
  isClosing: boolean
  isLoading: boolean
  detail: SessionDetail | null
  onClose: () => void
  onCopyText: (text: string) => void | Promise<void>
}

export function SessionDetailPanel({
  isClosing,
  isLoading,
  detail,
  onClose,
  onCopyText
}: SessionDetailPanelProps) {
  return (
    <div className={`detail-panel${isClosing ? ' closing' : ''}`}>
      <div className="detail-header">
        <h4>会话详情</h4>
        <button className="close-btn" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {isLoading ? (
        <div className="detail-loading">
          <Loader2 size={20} className="spin" />
          <span>加载中...</span>
        </div>
      ) : detail ? (
        <div className="detail-content">
          <div className="detail-section">
            <div className="detail-item">
              <Hash size={14} />
              <span className="label">微信ID</span>
              <span className="value value-with-action">
                <span>{detail.wxid}</span>
                <button
                  type="button"
                  className="inline-copy-btn"
                  title="复制微信ID"
                  onClick={() => onCopyText(detail.wxid)}
                >
                  <Copy size={12} />
                </button>
              </span>
            </div>
            {detail.remark && (
              <div className="detail-item">
                <span className="label">备注</span>
                <span className="value">{detail.remark}</span>
              </div>
            )}
            {detail.nickName && (
              <div className="detail-item">
                <span className="label">昵称</span>
                <span className="value">{detail.nickName}</span>
              </div>
            )}
            {detail.alias && (
              <div className="detail-item">
                <span className="label">微信号</span>
                <span className="value">{detail.alias}</span>
              </div>
            )}
          </div>

          <div className="detail-section">
            <div className="section-title">
              <MessageSquare size={14} />
              <span>消息统计</span>
            </div>
            <div className="detail-item">
              <span className="label">消息总数</span>
              <span className="value highlight">{detail.messageCount.toLocaleString()}</span>
            </div>
            {detail.firstMessageTime && (
              <div className="detail-item">
                <Calendar size={14} />
                <span className="label">首条消息</span>
                <span className="value">{new Date(detail.firstMessageTime * 1000).toLocaleDateString('zh-CN')}</span>
              </div>
            )}
            {detail.latestMessageTime && (
              <div className="detail-item">
                <Calendar size={14} />
                <span className="label">最新消息</span>
                <span className="value">{new Date(detail.latestMessageTime * 1000).toLocaleDateString('zh-CN')}</span>
              </div>
            )}
          </div>

          {detail.messageTables.length > 0 && (
            <div className="detail-section">
              <div className="section-title">
                <Database size={14} />
                <span>数据库分布</span>
              </div>
              <div className="table-list">
                {detail.messageTables.map((t, i) => (
                  <div key={i} className="table-item">
                    <span className="db-name">{t.dbName}</span>
                    <span className="table-count">{t.count.toLocaleString()} 条</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="detail-empty">暂无详情</div>
      )}
    </div>
  )
}

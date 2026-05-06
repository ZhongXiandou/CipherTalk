import { createPortal } from 'react-dom'
import { AlertCircle, Image as ImageIcon, Loader2 } from 'lucide-react'
import type { BatchImageMessage } from '../types'
import { formatBatchDateLabel } from '../utils/time'

type Progress = { current: number; total: number }

interface BatchDecryptModalProps {
  showConfirm: boolean
  onCloseConfirm: () => void
  imageDates: string[]
  countByDate: Map<string, number>
  selectedDates: Set<string>
  selectedCount: number
  onToggleDate: (date: string) => void
  onSelectAllDates: () => void
  onClearAllDates: () => void
  onConfirm: () => void | Promise<void>
  showProgress: boolean
  progress: Progress
  imageMessages: BatchImageMessage[] | null
}

export function BatchDecryptModal({
  showConfirm,
  onCloseConfirm,
  imageDates,
  countByDate,
  selectedDates,
  selectedCount,
  onToggleDate,
  onSelectAllDates,
  onClearAllDates,
  onConfirm,
  showProgress,
  progress
}: BatchDecryptModalProps) {
  return (
    <>
      {showConfirm && createPortal(
        <div className="modal-overlay" onClick={onCloseConfirm}>
          <div className="modal-content batch-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <ImageIcon size={20} />
              <h3>批量解密图片</h3>
            </div>
            <div className="modal-body">
              <p>选择要解密的日期（仅显示有图片的日期），然后开始解密。</p>
              {imageDates.length > 0 && (
                <div className="batch-dates-list-wrap">
                  <div className="batch-dates-actions">
                    <button type="button" className="batch-dates-btn" onClick={onSelectAllDates}>全选</button>
                    <button type="button" className="batch-dates-btn" onClick={onClearAllDates}>取消全选</button>
                  </div>
                  <ul className="batch-dates-list">
                    {imageDates.map(dateStr => {
                      const count = countByDate.get(dateStr) ?? 0
                      const checked = selectedDates.has(dateStr)
                      return (
                        <li key={dateStr}>
                          <label className="batch-date-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => onToggleDate(dateStr)}
                            />
                            <span className="batch-date-label">{formatBatchDateLabel(dateStr)}</span>
                            <span className="batch-date-count">{count} 张图片</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              <div className="batch-info">
                <div className="info-item">
                  <span className="label">已选:</span>
                  <span className="value">{selectedDates.size} 天有图片，共 {selectedCount} 张图片</span>
                </div>
              </div>
              <div className="batch-warning">
                <AlertCircle size={16} />
                <span>批量解密可能需要较长时间，解密过程中可以继续使用其他功能。已解密过的图片会自动跳过。</span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={onCloseConfirm}>
                取消
              </button>
              <button className="btn-primary" onClick={onConfirm}>
                <ImageIcon size={16} />
                开始解密
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showProgress && createPortal(
        <div className="modal-overlay">
          <div className="modal-content batch-progress-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Loader2 size={20} className="spin" />
              <h3>正在解密图片...</h3>
            </div>
            <div className="modal-body">
              <div className="progress-info">
                <div className="progress-text">
                  <span>已完成 {progress.current} / {progress.total} 张</span>
                  <span className="progress-percent">
                    {progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%
                  </span>
                </div>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

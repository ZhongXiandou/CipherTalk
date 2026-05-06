import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle, Loader2, Mic, XCircle } from 'lucide-react'
import type { Message } from '../../../types/models'
import { formatBatchDateLabel } from '../utils/time'

type Progress = { current: number; total: number }
type Result = { success: number; fail: number }

interface BatchTranscribeModalProps {
  showConfirm: boolean
  onCloseConfirm: () => void
  voiceDates: string[]
  countByDate: Map<string, number>
  selectedDates: Set<string>
  selectedMessageCount: number
  onToggleDate: (date: string) => void
  onSelectAllDates: () => void
  onClearAllDates: () => void
  onConfirm: () => void | Promise<void>
  showProgress: boolean
  progress: Progress
  showResult: boolean
  result: Result
  onCloseResult: () => void
  voiceMessages: Message[] | null
}

export function BatchTranscribeModal({
  showConfirm,
  onCloseConfirm,
  voiceDates,
  countByDate,
  selectedDates,
  selectedMessageCount,
  onToggleDate,
  onSelectAllDates,
  onClearAllDates,
  onConfirm,
  showProgress,
  progress,
  showResult,
  result,
  onCloseResult
}: BatchTranscribeModalProps) {
  return (
    <>
      {showConfirm && createPortal(
        <div className="modal-overlay" onClick={onCloseConfirm}>
          <div className="modal-content batch-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Mic size={20} />
              <h3>批量语音转文字</h3>
            </div>
            <div className="modal-body">
              <p>选择要转写的日期（仅显示有语音的日期），然后开始转写。</p>
              {voiceDates.length > 0 && (
                <div className="batch-dates-list-wrap">
                  <div className="batch-dates-actions">
                    <button type="button" className="batch-dates-btn" onClick={onSelectAllDates}>全选</button>
                    <button type="button" className="batch-dates-btn" onClick={onClearAllDates}>取消全选</button>
                  </div>
                  <ul className="batch-dates-list">
                    {voiceDates.map(dateStr => {
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
                            <span className="batch-date-count">{count} 条语音</span>
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
                  <span className="value">{selectedDates.size} 天有语音，共 {selectedMessageCount} 条语音</span>
                </div>
                <div className="info-item">
                  <span className="label">预计耗时:</span>
                  <span className="value">约 {Math.ceil(selectedMessageCount * 2 / 60)} 分钟</span>
                </div>
              </div>
              <div className="batch-warning">
                <AlertCircle size={16} />
                <span>批量转写可能需要较长时间，转写过程中可以继续使用其他功能。已转写过的语音会自动跳过。</span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={onCloseConfirm}>
                取消
              </button>
              <button className="btn-primary batch-transcribe-btn" onClick={onConfirm}>
                <Mic size={16} />
                开始转写
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
              <h3>正在转写...</h3>
            </div>
            <div className="modal-body">
              <div className="progress-info">
                <div className="progress-text">
                  <span>已完成 {progress.current} / {progress.total} 条</span>
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
              <div className="batch-tip">
                <span>转写过程中可以继续使用其他功能</span>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showResult && createPortal(
        <div className="modal-overlay" onClick={onCloseResult}>
          <div className="modal-content batch-result-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <CheckCircle size={20} />
              <h3>转写完成</h3>
            </div>
            <div className="modal-body">
              <div className="result-summary">
                <div className="result-item success">
                  <CheckCircle size={18} />
                  <span className="label">成功:</span>
                  <span className="value">{result.success} 条</span>
                </div>
                {result.fail > 0 && (
                  <div className="result-item fail">
                    <XCircle size={18} />
                    <span className="label">失败:</span>
                    <span className="value">{result.fail} 条</span>
                  </div>
                )}
              </div>
              {result.fail > 0 && (
                <div className="result-tip">
                  <AlertCircle size={16} />
                  <span>部分语音转写失败，可能是语音文件损坏或网络问题</span>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-primary" onClick={onCloseResult}>
                确定
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

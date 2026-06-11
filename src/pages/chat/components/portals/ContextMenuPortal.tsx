import { createPortal } from 'react-dom'
import { CheckSquare, Copy, Download, Edit, Info, RefreshCw, Volume2, VolumeX, ZoomIn } from 'lucide-react'
import { useTtsSpeaker } from '@/lib/ttsPlayer'
import type { ChatSession, Message } from '../../../../types/models'
import type { ContextMenuState } from '../../types'

interface ContextMenuPortalProps {
  contextMenu: ContextMenuState | null
  isMenuClosing: boolean
  closeContextMenu: () => void
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>
  setIsMenuClosing: React.Dispatch<React.SetStateAction<boolean>>
  showTopToast: (text: string, success?: boolean) => void
  setShowEnlargeView: React.Dispatch<React.SetStateAction<{ message: Message; content: string } | null>>
  onEnterSelectMode: (localId: number) => void
  exportVoiceMessage: (message: Message, session: ChatSession) => void | Promise<void>
  setShowMessageInfo: React.Dispatch<React.SetStateAction<Message | null>>
}

export function ContextMenuPortal({
  contextMenu,
  isMenuClosing,
  closeContextMenu,
  setContextMenu,
  setIsMenuClosing,
  showTopToast,
  setShowEnlargeView,
  onEnterSelectMode,
  exportVoiceMessage,
  setShowMessageInfo
}: ContextMenuPortalProps) {
  const { speakingKey, speak } = useTtsSpeaker()
  if (!contextMenu) return null
  const speakKey = `wxmsg-${contextMenu.message.localId}`
  const isSpeakingThis = speakingKey === speakKey

  return createPortal(
    <div
      className="context-menu-overlay"
      onClick={() => closeContextMenu()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        closeContextMenu()
      }}
    >
      <div
        className={`context-menu ${isMenuClosing ? 'closing' : ''}`}
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onAnimationEnd={() => {
          if (isMenuClosing) {
            setContextMenu(null)
            setIsMenuClosing(false)
          }
        }}
      >
        {contextMenu.message.localType !== 34 && contextMenu.message.localType !== 3 && contextMenu.message.localType !== 43 && (
          <>
            <div
              className="context-menu-item"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(contextMenu.message.parsedContent || '')
                  closeContextMenu()
                  showTopToast('已复制', true)
                } catch (e) {
                  console.error('复制失败:', e)
                  closeContextMenu()
                }
              }}
            >
              <Copy size={16} />
              <span>复制</span>
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                setShowEnlargeView({
                  message: contextMenu.message,
                  content: contextMenu.message.parsedContent || ''
                })
                closeContextMenu()
              }}
            >
              <ZoomIn size={16} />
              <span>放大阅读</span>
            </div>
            <div
              className="context-menu-item"
              onClick={() => {
                closeContextMenu()
                void speak(speakKey, contextMenu.message.parsedContent || '').then((res) => {
                  if (!res.ok && res.error) showTopToast(res.error, false)
                })
              }}
            >
              {isSpeakingThis ? <VolumeX size={16} /> : <Volume2 size={16} />}
              <span>{isSpeakingThis ? '停止朗读' : '朗读'}</span>
            </div>
          </>
        )}
        {contextMenu.message.localType !== 3 && contextMenu.message.localType !== 43 && (
          <div
            className="context-menu-item"
            onClick={() => {
              onEnterSelectMode(contextMenu.message.localId)
              closeContextMenu()
            }}
          >
            <CheckSquare size={16} />
            <span>多选</span>
          </div>
        )}

        {contextMenu.message.localType === 34 && (
          <div
            className="context-menu-item"
            onClick={() => {
              closeContextMenu()
              void exportVoiceMessage(contextMenu.message, contextMenu.session)
            }}
          >
            <Download size={16} />
            <span>导出语音文件</span>
          </div>
        )}

        {contextMenu.handlers?.reTranscribe && (
          <div
            className="context-menu-item"
            onClick={() => {
              contextMenu.handlers!.reTranscribe!()
              closeContextMenu()
            }}
          >
            <RefreshCw size={16} />
            <span>重新转文字</span>
          </div>
        )}

        {contextMenu.handlers?.editStt && (
          <div
            className="context-menu-item"
            onClick={() => {
              contextMenu.handlers!.editStt!()
              closeContextMenu()
            }}
          >
            <Edit size={16} />
            <span>修改识别文字</span>
          </div>
        )}

        <div
          className="context-menu-item"
          onClick={() => {
            setShowMessageInfo(contextMenu.message)
            closeContextMenu()
          }}
        >
          <Info size={16} />
          <span>查看消息信息</span>
        </div>
      </div>
    </div>,
    document.body
  )
}

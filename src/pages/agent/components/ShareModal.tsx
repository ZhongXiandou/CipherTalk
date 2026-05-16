import { useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Bot, Download, User, X } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import AIProviderLogo from '../../../components/ai/AIProviderLogo'
import type { AssistantBlock, Message, TextBlock } from '../types'

interface Props {
  message: Message
  userMessage?: Message
  aiProvider?: string
  onClose: () => void
}

function extractMarkdown(blocks: AssistantBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n\n')
}

function renderMarkdown(text: string) {
  const html = marked.parse(text || '') as string
  return { __html: DOMPurify.sanitize(html) }
}

export function ShareModal({ message, userMessage, aiProvider, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  const userInfo = useAppStore(s => s.userInfo)

  const md = extractMarkdown(message.blocks || [])
  const dateStr = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  const handleSave = async () => {
    const node = cardRef.current
    if (!node || saving) return
    setSaving(true)
    try {
      const domtoimage = (await import('dom-to-image-more')).default
      const dataUrl = await (domtoimage as any).toPng(node, { scale: 2 })
      const link = document.createElement('a')
      link.download = `密语分享-${Date.now()}.png`
      link.href = dataUrl
      link.click()
    } catch (e) {
      console.error('[Share] 截图失败', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="share-overlay" onMouseDown={onClose}>
      <div className="share-dialog" onMouseDown={e => e.stopPropagation()}>

        <div className="share-dialog__toolbar">
          <span className="share-dialog__hint">预览</span>
          <button
            type="button"
            className="share-dialog__save"
            onClick={handleSave}
            disabled={saving}
          >
            <Download size={14} />
            {saving ? '生成中…' : '保存图片'}
          </button>
          <button type="button" className="share-dialog__close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="share-dialog__scroll">
          <div className="share-card" ref={cardRef}>

            {/* 用户消息 — 右侧 */}
            {userMessage?.content && (
              <div className="share-row share-row--user">
                <div className="share-bubble share-bubble--user">
                  {userMessage.content}
                </div>
                <div className="share-avatar share-avatar--user">
                  {userInfo?.avatarUrl
                    ? <img src={userInfo.avatarUrl} alt="" />
                    : <User size={16} />
                  }
                </div>
              </div>
            )}

            {/* AI 消息 — 左侧 */}
            <div className="share-row share-row--ai">
              <div className="share-avatar share-avatar--ai">
                {aiProvider
                  ? <AIProviderLogo providerId={aiProvider} alt={aiProvider} size={20} />
                  : <Bot size={16} />
                }
              </div>
              <div className="share-bubble share-bubble--ai">
                <div
                  className="share-md"
                  dangerouslySetInnerHTML={renderMarkdown(md)}
                />
              </div>
            </div>

            {/* 底部品牌栏 */}
            <div className="share-card__footer">
              <span className="share-card__brand">CipherTalk · miyu.aiqji.com</span>
            </div>

          </div>
        </div>

      </div>
    </div>
  )
}

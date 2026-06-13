import { Loader2 } from 'lucide-react'
import { Modal, ProgressBar, Label, Chip, Typography } from '@heroui/react'
import type { ExportOptions, ExportProgress } from '../types'

interface ExportProgressModalProps {
  progress: ExportProgress
  /** 聊天导出才有的格式/媒体选项；其它导出（如数据库）不传 */
  options?: ExportOptions
  /** 进度单位，例如「个会话」「个数据库」 */
  unitLabel?: string
  /** 当前项的前缀标签，例如「当前会话」「当前数据库」 */
  currentLabel?: string
}

export default function ExportProgressModal({
  progress,
  options,
  unitLabel = '个会话',
  currentLabel = '当前会话'
}: ExportProgressModalProps) {
  const optionChips = options
    ? ([
        options.exportImages && '含图片',
        options.exportVideos && '含视频',
        options.exportEmojis && '含表情',
        options.exportVoices && '含语音',
        options.exportAvatars && '含头像'
      ].filter(Boolean) as string[])
    : []

  return (
    <Modal.Backdrop isOpen isDismissable={false}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Icon className="bg-default text-foreground">
              <Loader2 className="size-5 animate-spin" />
            </Modal.Icon>
            <Modal.Heading>正在导出</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-2">
              {progress.phase && <Typography type="body-sm" weight="medium">{progress.phase}</Typography>}
              {progress.currentName && (
                <Typography type="body-sm" className="text-muted">{currentLabel}: {progress.currentName}</Typography>
              )}
              {progress.detail && <Typography type="body-xs" className="text-muted">{progress.detail}</Typography>}
              {!progress.currentName && !progress.detail && (
                <Typography type="body-sm" className="text-muted">准备中...</Typography>
              )}

              {(options || optionChips.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {options && <Chip variant="secondary" size="sm">格式: {options.format.toUpperCase()}</Chip>}
                  {optionChips.map(label => (
                    <Chip key={label} variant="secondary" size="sm">{label}</Chip>
                  ))}
                </div>
              )}

              {progress.total > 0 && (
                <ProgressBar
                  aria-label="导出进度"
                  value={progress.current}
                  maxValue={Math.max(1, progress.total)}
                  className="mt-1"
                >
                  <Label>{progress.current} / {progress.total} {unitLabel}</Label>
                  <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
                </ProgressBar>
              )}
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

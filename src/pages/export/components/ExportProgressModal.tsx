import { Loader2 } from 'lucide-react'
import { Modal, ProgressBar, Label, Chip, Typography } from '@heroui/react'
import type { ExportOptions, ExportProgress } from '../types'

interface ExportProgressModalProps {
  progress: ExportProgress
  options: ExportOptions
}

export default function ExportProgressModal({ progress, options }: ExportProgressModalProps) {
  const optionChips = [
    options.exportImages && '含图片',
    options.exportVideos && '含视频',
    options.exportEmojis && '含表情',
    options.exportVoices && '含语音',
    options.exportAvatars && '含头像'
  ].filter(Boolean) as string[]

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
                <Typography type="body-sm" className="text-muted">当前会话: {progress.currentName}</Typography>
              )}
              {progress.detail && <Typography type="body-xs" className="text-muted">{progress.detail}</Typography>}
              {!progress.currentName && !progress.detail && (
                <Typography type="body-sm" className="text-muted">准备中...</Typography>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <Chip variant="secondary" size="sm">格式: {options.format.toUpperCase()}</Chip>
                {optionChips.map(label => (
                  <Chip key={label} variant="secondary" size="sm">{label}</Chip>
                ))}
              </div>

              {progress.total > 0 && (
                <ProgressBar
                  aria-label="导出进度"
                  value={progress.current}
                  maxValue={Math.max(1, progress.total)}
                  className="mt-1"
                >
                  <Label>{progress.current} / {progress.total} 个会话</Label>
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

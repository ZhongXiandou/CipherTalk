import { Image, Heart, MessageSquare } from 'lucide-react'
import { Spinner, ListBox, Avatar, Label, Typography, Description } from '@heroui/react'
import type { MomentPost } from '../types'
import { getAvatarLetter } from '../utils'

interface MomentsListProps {
  isLoading: boolean
  moments: MomentPost[]
}

export default function MomentsList({ isLoading, moments }: MomentsListProps) {
  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <Spinner size="md" />
        <Typography type="body-sm">加载中...</Typography>
      </div>
    )
  }

  if (moments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Typography type="body-sm">暂无朋友圈数据</Typography>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Description>预览最近 {moments.length} 条 · 导出按时间范围筛选</Description>
      <ListBox aria-label="朋友圈预览" selectionMode="none" className="w-full">
        {moments.map(m => (
          <ListBox.Item
            key={m.id || `${m.username}_${m.createTime}`}
            id={m.id || `${m.username}_${m.createTime}`}
            textValue={m.nickname || m.username}
            className="items-start"
          >
            <Avatar size="sm">
              {m.avatarUrl && <Avatar.Image alt="" loading="lazy" src={m.avatarUrl} />}
              <Avatar.Fallback>{getAvatarLetter(m.nickname || m.username)}</Avatar.Fallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-baseline gap-2">
                <Label className="truncate">{m.nickname || m.username}</Label>
                <Typography type="body-xs" className="shrink-0 text-muted">
                  {m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''}
                </Typography>
              </div>
              <Description>
                {m.contentDesc || (m.media && m.media.length > 0 ? '[图片/视频]' : '[无文字内容]')}
              </Description>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted">
                {m.media && m.media.length > 0 && <span className="flex items-center gap-1"><Image size={11} /> {m.media.length}</span>}
                {m.likes && m.likes.length > 0 && <span className="flex items-center gap-1"><Heart size={11} /> {m.likes.length}</span>}
                {m.comments && m.comments.length > 0 && <span className="flex items-center gap-1"><MessageSquare size={11} /> {m.comments.length}</span>}
              </div>
            </div>
          </ListBox.Item>
        ))}
      </ListBox>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, ScrollShadow, Spinner } from '@heroui/react'
import { BookOpen, CalendarDays, PenLine, RefreshCw } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { MemoryDiaryEntryInfo } from '../types/electron'

function formatDiaryDate(date: string): string {
  const [year, month, day] = date.split('-')
  return year && month && day ? `${year}/${month}/${day}` : date
}

function stripMemoryIndex(markdown: string): string {
  return markdown.replace(/\n## 记忆线索[\s\S]*$/u, '').trim()
}

function cardPreview(diary: MemoryDiaryEntryInfo): string {
  return diary.excerpt || stripMemoryIndex(diary.content || '').replace(/^# .+$/gm, '').replace(/\s+/g, ' ').trim() || '这一天还没有留下太多文字。'
}

const DIARY_SUMMARIZING_LINES = [
  '把今天摊开，挑几段舍不得散的',
  '有些句子已经在时间里褪色了，趁还看得见，记下来',
  '今天的你说了很多。我在听第二遍',
  '正在替以后的你，保管今天的自己',
  '让我把今天叠好，放进抽屉',
  '有一段话我想多读几遍——今天的',
  '别催，日记不是赶出来的',
]

const EXISTING_TODAY_DIARY_NOTICE = '今天的日记已经躺在那儿了。再写一篇，前一篇就会被盖掉。 我不想让它还没被好好看过，就消失了。'

export default function DiaryPage() {
  const [diaries, setDiaries] = useState<MemoryDiaryEntryInfo[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const selectedDateRef = useRef('')
  const [selectedDiary, setSelectedDiary] = useState<MemoryDiaryEntryInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [summarizingLineIndex, setSummarizingLineIndex] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [html, setHtml] = useState('')

  const selectedPreview = useMemo(() => selectedDiary ? stripMemoryIndex(selectedDiary.content || '') : '', [selectedDiary])

  const loadDiary = useCallback(async (date: string) => {
    if (!date) return
    setReading(true)
    setError('')
    try {
      const res = await window.electronAPI.memory.readDiary(date)
      if (!res.success || !res.diary) throw new Error(res.error || '读取日记失败')
      setSelectedDiary(res.diary)
      const rendered = await marked.parse(res.diary.content || '')
      setHtml(DOMPurify.sanitize(rendered))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取日记失败')
      setSelectedDiary(null)
      setHtml('')
    } finally {
      setReading(false)
    }
  }, [])

  const loadDiaries = useCallback(async (preferredDate?: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await window.electronAPI.memory.listDiaries(200)
      if (!res.success) throw new Error(res.error || '读取日记列表失败')
      const nextDiaries = res.diaries || []
      setDiaries(nextDiaries)
      const targetDate = preferredDate || selectedDateRef.current
      const nextSelected = nextDiaries.some((diary) => diary.date === targetDate)
        ? targetDate
        : nextDiaries[0]?.date || ''
      selectedDateRef.current = nextSelected
      setSelectedDate(nextSelected)
      if (nextSelected) await loadDiary(nextSelected)
      else {
        setSelectedDiary(null)
        setHtml('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取日记列表失败')
    } finally {
      setLoading(false)
    }
  }, [loadDiary])

  useEffect(() => {
    void loadDiaries()
  }, [loadDiaries])

  useEffect(() => {
    if (!summarizing) return
    const timer = window.setInterval(() => {
      setSummarizingLineIndex((index) => (index + 1) % DIARY_SUMMARIZING_LINES.length)
    }, 1800)
    return () => window.clearInterval(timer)
  }, [summarizing])

  const handleSelect = (date: string) => {
    selectedDateRef.current = date
    setSelectedDate(date)
    setNotice('')
    void loadDiary(date)
  }

  const showDiary = useCallback(async (diary: MemoryDiaryEntryInfo) => {
    selectedDateRef.current = diary.date
    setSelectedDate(diary.date)
    setSelectedDiary(diary)
    const rendered = await marked.parse(diary.content || '')
    setHtml(DOMPurify.sanitize(rendered))
  }, [])

  const summarizeToday = useCallback(async () => {
    if (summarizing) return
    setSummarizing(true)
    setNotice('')
    setError('')
    setSummarizingLineIndex(0)
    try {
      const res = await window.electronAPI.memory.summarizeTodayDiary()
      if (!res.success || !res.diary) throw new Error(res.error || '总结日记失败')
      if (res.alreadyExists) {
        setNotice(EXISTING_TODAY_DIARY_NOTICE)
        await showDiary(res.diary)
      } else {
        await showDiary(res.diary)
        await loadDiaries(res.diary.date)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '总结日记失败')
    } finally {
      setSummarizing(false)
    }
  }, [loadDiaries, showDiary, summarizing])

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--bg-primary)">
      <header className="flex shrink-0 items-center justify-between gap-4 px-7 py-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted">
            <BookOpen className="size-4" />
            <span>Memory Diary</span>
          </div>
          <h1 className="m-0 mt-1 text-2xl font-semibold text-foreground">日记</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button isDisabled={summarizing} variant="primary" onPress={() => void summarizeToday()}>
            <PenLine className="size-4" />
            总结日记
          </Button>
          <Button isIconOnly aria-label="刷新日记" variant="ghost" onPress={() => void loadDiaries()}>
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </header>

      {error && (
        <Card className="mx-7 mb-4 border-danger/20 bg-danger-soft text-danger-soft-foreground">
          <Card.Header>
            <Card.Description>{error}</Card.Description>
          </Card.Header>
        </Card>
      )}

      {notice && (
        <Card className="mx-7 mb-4">
          <Card.Header className="gap-2">
            <Card.Title className="text-base">今天的日记</Card.Title>
            <Card.Description className="text-sm leading-7">{notice}</Card.Description>
          </Card.Header>
        </Card>
      )}

      {summarizing && (
        <Card className="mx-7 mb-4 overflow-hidden">
          <Card.Header className="items-center gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-foreground">
              <PenLine className="size-5" />
            </div>
            <div className="min-w-0">
              <Card.Title className="text-base">正在总结日记</Card.Title>
              <Card.Description className="diary-summary-line mt-1 text-sm leading-7" key={summarizingLineIndex}>
                {DIARY_SUMMARIZING_LINES[summarizingLineIndex]}
              </Card.Description>
            </div>
          </Card.Header>
        </Card>
      )}

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : diaries.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-7">
          <Card className="w-full max-w-120 text-center">
            <Card.Header className="items-center gap-3">
              <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent-soft-foreground">
                <BookOpen className="size-5" />
              </div>
              <Card.Title>还没有日记</Card.Title>
              <Card.Description>等夜间整理完成后，这里会出现第一张日记卡片。</Card.Description>
            </Card.Header>
          </Card>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 px-7 pb-7 xl:grid-cols-[minmax(320px,420px)_1fr]">
          <ScrollShadow hideScrollBar className="min-h-0" size={40}>
            <div className="grid gap-3 pr-1">
              {diaries.map((diary) => {
                const active = diary.date === selectedDate
                return (
                  <Card
                    key={diary.date}
                    role="button"
                    tabIndex={0}
                    variant={active ? 'secondary' : 'default'}
                    className="relative cursor-pointer overflow-hidden transition-transform hover:-translate-y-0.5"
                    onClick={() => handleSelect(diary.date)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleSelect(diary.date)
                      }
                    }}
                  >
                    <Card.Header className="gap-3">
                      <div className="flex items-center justify-between gap-3">
                        <Card.Title className="truncate text-base">{diary.title}</Card.Title>
                        <span className="shrink-0 text-xs text-muted">{formatDiaryDate(diary.date)}</span>
                      </div>
                      <div className="relative max-h-27 overflow-hidden">
                        <Card.Description className="text-sm leading-7">
                          {cardPreview(diary)}
                        </Card.Description>
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-b from-transparent to-surface backdrop-blur-[1px]" />
                      </div>
                      <span className="text-xs font-medium text-primary">点击查看</span>
                    </Card.Header>
                  </Card>
                )
              })}
            </div>
          </ScrollShadow>

          <Card className="flex min-h-0 flex-col overflow-hidden">
            <Card.Header className="shrink-0 border-b border-border/70">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <Card.Title className="truncate text-xl">{selectedDiary?.title || '日记'}</Card.Title>
                  {selectedDiary?.date && (
                    <Card.Description className="mt-1 flex items-center gap-1.5">
                      <CalendarDays className="size-3.5" />
                      {formatDiaryDate(selectedDiary.date)}
                    </Card.Description>
                  )}
                </div>
                {reading && <Spinner size="sm" />}
              </div>
            </Card.Header>
            <ScrollShadow hideScrollBar className="min-h-0 flex-1" size={48}>
              <article
                className="diary-markdown mx-auto max-w-210 px-6 py-7 text-[15px] leading-8 text-foreground"
                dangerouslySetInnerHTML={{ __html: html || DOMPurify.sanitize(selectedPreview) }}
              />
            </ScrollShadow>
          </Card>
        </div>
      )}

      <style>
        {`
          .diary-markdown h1 {
            margin: 0 0 1.75rem;
            font-size: 1.85rem;
            line-height: 1.25;
            font-weight: 650;
          }
          .diary-markdown h2 {
            margin: 2rem 0 0.75rem;
            font-size: 1.05rem;
            line-height: 1.5;
            font-weight: 650;
          }
          .diary-markdown p {
            margin: 0 0 1.35rem;
          }
          .diary-markdown ul {
            margin: 0.5rem 0 1.5rem;
            padding-left: 1.25rem;
          }
          .diary-markdown li {
            margin: 0.35rem 0;
          }
          .diary-markdown blockquote {
            margin: 1.25rem 0;
            border-left: 3px solid hsl(var(--heroui-accent, 180 65% 42%));
            padding-left: 1rem;
            color: var(--muted);
          }
          .diary-summary-line {
            animation: diarySummaryLineIn 420ms ease-out both;
          }
          @keyframes diarySummaryLineIn {
            from {
              opacity: 0;
              transform: translate3d(0, 6px, 0);
              filter: blur(4px);
            }
            to {
              opacity: 1;
              transform: translate3d(0, 0, 0);
              filter: blur(0);
            }
          }
        `}
      </style>
    </div>
  )
}

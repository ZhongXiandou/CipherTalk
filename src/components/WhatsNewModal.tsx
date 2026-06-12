import { Button, Modal } from '@heroui/react'
import { Quote, Send, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

interface WhatsNewModalProps {
  onClose: () => void
  version: string
}

type VisionSection = {
  key: 'memory' | 'evidence' | 'ownership'
  text: string
}

const VISION_SECTIONS: VisionSection[] = [
  {
    key: 'memory',
    text: '有人离开后，一句语音就是遗物；一段闲聊，可能是最后一次拥抱。CipherTalk 要把这些碎片从设备里救出来。'
  },
  {
    key: 'evidence',
    text: '被恶意、羞辱、威胁消耗时，聊天记录不该躺在黑盒里。它要能被快速找到、串起来、拿得出手。'
  },
  {
    key: 'ownership',
    text: '更多时候，它只是把你的数字人生还给你。不是平台的，不是某台设备的，是你的。'
  }
]

const publicAsset = (fileName: string): string => `${import.meta.env.BASE_URL}${fileName}`

const VISION_AUDIO_SRC = publicAsset('音频.mp3')
const VISION_SUBTITLE_SRC = publicAsset('音频字幕.srt')
const VISION_MODAL_EXIT_MS = 240
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3)

type SubtitleCue = {
  end: number
  start: number
  text: string
}

type CharacterTiming = {
  end: number
  start: number
}

type TypewriterTextPart = string | {
  className?: string
  text: string
}

type TypewriterTextProps = {
  currentTime: number
  charTimings: CharacterTiming[]
  parts: TypewriterTextPart[]
  startIndex: number
}

function getTextFromPart(part: TypewriterTextPart) {
  return typeof part === 'string' ? part : part.text
}

function splitText(text: string) {
  return Array.from(text)
}

function parseSrtTimestamp(value: string) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!match) return 0

  const [, hours, minutes, seconds, milliseconds] = match
  return Number(hours) * 3600
    + Number(minutes) * 60
    + Number(seconds)
    + Number(milliseconds) / 1000
}

function parseSrt(value: string): SubtitleCue[] {
  return value
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
      const timeLine = lines.find((line) => line.includes('-->'))
      if (!timeLine) return null

      const [startValue, endValue] = timeLine.split('-->').map((item) => item.trim())
      const text = lines
        .slice(lines.indexOf(timeLine) + 1)
        .join('')
        .trim()
      if (!text) return null

      return {
        end: parseSrtTimestamp(endValue),
        start: parseSrtTimestamp(startValue),
        text
      }
    })
    .filter((cue): cue is SubtitleCue => Boolean(cue))
}

function isSkippableSubtitleChar(char: string) {
  return /\s/.test(char)
}

function flattenParts(parts: TypewriterTextPart[]) {
  return parts.map(getTextFromPart).join('')
}

function buildCharacterTimings(lines: TypewriterTextPart[][], cues: SubtitleCue[]) {
  const fullText = lines.map(flattenParts).join('')
  const displayChars = splitText(fullText)
  const displaySearchChars = displayChars
    .map((char, index) => ({ char, index }))
    .filter((item) => !isSkippableSubtitleChar(item.char))
  const displaySearchText = displaySearchChars.map((item) => item.char).join('')
  const timings: Array<CharacterTiming | undefined> = Array(displayChars.length)
  let searchFrom = 0

  cues.forEach((cue) => {
    const cueChars = splitText(cue.text).filter((char) => !isSkippableSubtitleChar(char))
    const cueText = cueChars.join('')
    if (!cueText) return

    const foundAt = displaySearchText.indexOf(cueText, searchFrom)
    if (foundAt < 0) return

    const step = (cue.end - cue.start) / Math.max(cueChars.length, 1)
    cueChars.forEach((_, cueIndex) => {
      const displayIndex = displaySearchChars[foundAt + cueIndex]?.index
      if (displayIndex == null) return

      timings[displayIndex] = {
        end: cue.start + step * (cueIndex + 1),
        start: cue.start + step * cueIndex
      }
    })
    searchFrom = foundAt + cueChars.length
  })

  timings.forEach((timing, index) => {
    if (timing || !isSkippableSubtitleChar(displayChars[index])) return

    const previousTiming = timings[index - 1]
    const nextTiming = timings.slice(index + 1).find(Boolean)
    timings[index] = previousTiming || nextTiming || { end: 0, start: 0 }
  })

  let lastKnownEnd = cues.length > 0 ? cues[cues.length - 1].end : 0
  timings.forEach((timing, index) => {
    if (timing) {
      lastKnownEnd = timing.end
      return
    }

    timings[index] = {
      end: lastKnownEnd + 0.12,
      start: lastKnownEnd
    }
    lastKnownEnd += 0.12
  })

  return timings as CharacterTiming[]
}

const FALLBACK_SUBTITLE_CUES = parseSrt(`1
00:00:00,000 --> 00:00:16,189
它不是聊天记录读取器。它更像一把开刃的钥匙，从旧手机里撬出体温、证据和人生主权。聊天记录不是冷数据。它可能是想念、证据、关系的暗线，也是一个人活过的痕迹。

2
00:00:16,344 --> 00:00:22,850
有人离开后，一句语音就是遗物；一段闲聊，可能是最后一次拥抱。

3
00:00:23,004 --> 00:00:39,797
CipherTalk 要把这些碎片从设备里救出来。被恶意、羞辱、威胁消耗时，聊天记录不该躺在黑盒里。它要能被快速找到、串起来、拿得出手。更多时候，它只是把你的数字人生还给你。

4
00:00:39,960 --> 00:00:46,942
不是平台的，不是某台设备的，是你的。死亡不是生命的终点，遗忘才是。
`)

function TypewriterText({ parts, currentTime, charTimings, startIndex }: TypewriterTextProps) {
  const lineStart = charTimings[startIndex]?.start ?? 0
  if (currentTime < lineStart) return null

  let cursor = 0

  return (
    <>
      {parts.map((part, partIndex) => {
        const text = getTextFromPart(part)
        const className = typeof part === 'string' ? undefined : part.className
        const chars = splitText(text)
        const content = chars.map((char, charIndex) => {
          const index = startIndex + cursor + charIndex
          const timing = charTimings[index]
          const charStart = timing?.start ?? Number.POSITIVE_INFINITY
          const charEnd = timing?.end ?? charStart + 0.12
          const raw = clamp((currentTime - charStart) / Math.max(charEnd - charStart, 0.001))
          const eased = easeOutCubic(raw)
          const style = {
            opacity: eased,
            transform: `translate3d(0, ${(1 - eased) * 0.38}em, 0)`,
            filter: `blur(${(1 - eased) * 1.2}px)`,
            transition: 'opacity 220ms cubic-bezier(0.16, 1, 0.3, 1), transform 220ms cubic-bezier(0.16, 1, 0.3, 1), filter 220ms cubic-bezier(0.16, 1, 0.3, 1)',
            willChange: eased < 1 ? 'opacity, transform, filter' : undefined
          } satisfies CSSProperties

          return (
            <span className={`inline-block whitespace-pre-wrap ${className || ''}`} key={`${index}-${char}`} style={style}>
              {char}
            </span>
          )
        })

        cursor += chars.length

        return <Fragment key={partIndex}>{content}</Fragment>
      })}
    </>
  )
}

const VISION_LINES: TypewriterTextPart[][] = [
  [
    '它不是聊天记录读取器。',
    {
      className: 'bg-linear-to-r from-white via-cyan-100 to-fuchsia-200 bg-clip-text text-transparent',
      text: '它更像一把开刃的钥匙'
    },
    '，从旧手机里撬出体温、证据和人生主权。'
  ],
  ['聊天记录不是冷数据。它可能是想念、证据、关系的暗线，也是一个人活过的痕迹。'],
  ...VISION_SECTIONS.map((section) => [section.text]),
  ['死亡不是生命的终点，遗忘才是。'],
  ['《寻梦环游记》']
]

const VISION_LINE_STARTS = VISION_LINES.reduce<number[]>((starts, parts, index) => {
  if (index === 0) {
    starts.push(0)
    return starts
  }

  const previousLineLength = VISION_LINES[index - 1].reduce(
    (sum, part) => sum + splitText(getTextFromPart(part)).length,
    0
  )
  starts.push(starts[index - 1] + previousLineLength)
  return starts
}, [])

function WhatsNewModal({ onClose }: WhatsNewModalProps) {
  const visionAudioRef = useRef<HTMLAudioElement | null>(null)
  const progressFillRef = useRef<HTMLDivElement | null>(null)
  const audioProgressFrameRef = useRef<number | null>(null)
  const closeHandledRef = useRef(false)
  const decodedDurationRef = useRef(0)
  const lastStateProgressRef = useRef(-1)
  const closeTimeoutRef = useRef<number | null>(null)
  const [isVisionOpen, setIsVisionOpen] = useState(true)
  const [audioProgress, setAudioProgress] = useState(0)
  const [audioCurrentTime, setAudioCurrentTime] = useState(0)
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>(FALLBACK_SUBTITLE_CUES)

  const charTimings = useMemo(
    () => buildCharacterTimings(VISION_LINES, subtitleCues),
    [subtitleCues]
  )

  const requestClose = useCallback(() => {
    if (closeHandledRef.current) return
    closeHandledRef.current = true
    setIsVisionOpen(false)
  }, [])

  useEffect(() => {
    if (isVisionOpen) return

    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null
      onClose()
    }, VISION_MODAL_EXIT_MS)

    return () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current)
        closeTimeoutRef.current = null
      }
    }
  }, [isVisionOpen, onClose])

  useEffect(() => {
    const getTitleBarSymbolColor = () => {
      const mode = document.documentElement.dataset.mode
      return mode === 'dark' ? '#ffffff' : '#1a1a1a'
    }

    window.electronAPI?.window?.setTitleBarOverlay?.({
      hidden: true,
      symbolColor: getTitleBarSymbolColor()
    })

    return () => {
      window.electronAPI?.window?.setTitleBarOverlay?.({
        hidden: false,
        symbolColor: getTitleBarSymbolColor()
      })
    }
  }, [])

  useEffect(() => {
    const audio = visionAudioRef.current
    if (!audio) return

    const syncAudioProgress = () => {
      const duration = decodedDurationRef.current || audio.duration
      if (Number.isFinite(duration) && duration > 0) {
        const nextProgress = Math.min(100, (audio.currentTime / duration) * 100)

        if (progressFillRef.current) {
          progressFillRef.current.style.transform = `translate3d(0, 0, 0) scaleX(${nextProgress / 100})`
        }

        if (
          Math.abs(nextProgress - lastStateProgressRef.current) >= 0.12
          || nextProgress === 100
        ) {
          lastStateProgressRef.current = nextProgress
          setAudioProgress(nextProgress)
          setAudioCurrentTime(audio.currentTime)
        }
      }
      audioProgressFrameRef.current = window.requestAnimationFrame(syncAudioProgress)
    }

    void fetch(VISION_SUBTITLE_SRC)
      .then((res) => res.text())
      .then((value) => {
        const nextCues = parseSrt(value)
        if (nextCues.length > 0) {
          setSubtitleCues(nextCues)
        }
      })
      .catch((error) => {
        console.warn('开发者愿景字幕加载失败:', error)
      })

    void fetch(VISION_AUDIO_SRC)
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        const context = new AudioContext()
        return context.decodeAudioData(buffer).then((decoded) => {
          decodedDurationRef.current = decoded.duration
          void context.close()
        }).catch((error) => {
          void context.close()
          console.warn('开发者愿景音频时长解析失败:', error)
        })
      })
      .catch((error) => {
        console.warn('开发者愿景音频加载解析失败:', error)
      })

    audio.currentTime = 0
    setAudioCurrentTime(0)
    if (progressFillRef.current) {
      progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
    }
    void audio.play().catch((error) => {
      console.warn('开发者愿景音频自动播放失败:', error)
    })
    audioProgressFrameRef.current = window.requestAnimationFrame(syncAudioProgress)

    return () => {
      if (audioProgressFrameRef.current !== null) {
        window.cancelAnimationFrame(audioProgressFrameRef.current)
      }
      audio.pause()
      audio.currentTime = 0
      setAudioCurrentTime(0)
      if (progressFillRef.current) {
        progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
      }
    }
  }, [])

  const handleTelegram = () => {
    window.electronAPI?.shell?.openExternal?.('https://t.me/+p7YzmRMBm-gzNzJl')
  }

  const showActions = audioProgress >= 78
  const actionsProgress = easeOutCubic(clamp((audioProgress - 78) / 12))
  const actionsStyle = {
    opacity: actionsProgress,
    transform: `translate3d(0, ${(1 - actionsProgress) * 10}px, 0)`,
    transition: 'opacity 260ms cubic-bezier(0.16, 1, 0.3, 1), transform 260ms cubic-bezier(0.16, 1, 0.3, 1)'
  } satisfies CSSProperties

  return (
    <Modal.Backdrop
      className="bg-black/55 backdrop-blur-xl"
      isDismissable={false}
      isKeyboardDismissDisabled
      isOpen={isVisionOpen}
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
      variant="blur"
    >
      <audio
        ref={visionAudioRef}
        src={VISION_AUDIO_SRC}
        preload="auto"
        aria-hidden="true"
        onLoadedMetadata={() => {
          lastStateProgressRef.current = -1
          setAudioCurrentTime(0)
          setAudioProgress(0)
          if (progressFillRef.current) {
            progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
          }
        }}
        onEnded={() => {
          lastStateProgressRef.current = 100
          setAudioProgress(100)
          setAudioCurrentTime(decodedDurationRef.current || visionAudioRef.current?.duration || 0)
          if (progressFillRef.current) {
            progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(1)'
          }
        }}
      />
      <Modal.Container className="px-5 py-0 sm:px-10" placement="center" scroll="inside" size="full">
        <Modal.Dialog
          aria-label="开发者手记"
          className="mx-auto flex min-h-dvh w-full max-w-225 items-center overflow-hidden border-0! bg-transparent! p-0! text-white shadow-none!"
        >
          <Modal.Body className="flex max-h-dvh w-full items-center overflow-y-auto p-0">
            <article className="relative mx-auto flex max-w-180 flex-col gap-5 pr-15 text-[15px] leading-8 text-white/88 drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] sm:pr-16">
              <button
                aria-label="关闭开发者愿景"
                className="absolute right-0 top-0 z-10 inline-flex size-10 items-center justify-center rounded-full border-0 bg-white/10 p-0 text-white outline-none transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60"
                onClick={(event) => {
                  event.stopPropagation()
                  requestClose()
                }}
                type="button"
              >
                <X className="size-4" />
              </button>

              <p
                className="m-0 text-xl font-semibold leading-9 text-white sm:text-2xl sm:leading-10"
              >
                <TypewriterText
                  charTimings={charTimings}
                  currentTime={audioCurrentTime}
                  parts={VISION_LINES[0]}
                  startIndex={VISION_LINE_STARTS[0]}
                />
              </p>

              <p
                className="m-0"
              >
                <TypewriterText
                  charTimings={charTimings}
                  currentTime={audioCurrentTime}
                  parts={VISION_LINES[1]}
                  startIndex={VISION_LINE_STARTS[1]}
                />
              </p>

              {VISION_SECTIONS.map((section, index) => (
                <p
                  className="m-0"
                  key={section.key}
                >
                  <TypewriterText
                    charTimings={charTimings}
                    currentTime={audioCurrentTime}
                    parts={VISION_LINES[2 + index]}
                    startIndex={VISION_LINE_STARTS[2 + index]}
                  />
                </p>
              ))}

              <blockquote
                className="m-0 flex gap-3 border-l border-white/35 py-1 pl-4 text-white"
              >
                <Quote className="mt-1 size-4 shrink-0 text-white/80" aria-hidden="true" />
                <div>
                  <p className="m-0 font-semibold">
                    <TypewriterText
                      charTimings={charTimings}
                      currentTime={audioCurrentTime}
                      parts={VISION_LINES[5]}
                      startIndex={VISION_LINE_STARTS[5]}
                    />
                  </p>
                  <cite className="mt-1 block text-sm not-italic text-white/65">
                    <TypewriterText
                      charTimings={charTimings}
                      currentTime={audioCurrentTime}
                      parts={VISION_LINES[6]}
                      startIndex={VISION_LINE_STARTS[6]}
                    />
                  </cite>
                </div>
              </blockquote>

              <div
                className="h-px w-full overflow-hidden bg-white/12"
                aria-hidden="true"
              >
                <div
                  ref={progressFillRef}
                  className="h-full origin-left bg-linear-to-r from-white/35 via-cyan-100/85 to-fuchsia-200/80 will-change-transform"
                  style={{ transform: 'translate3d(0, 0, 0) scaleX(0)' }}
                />
              </div>

              <div
                className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between"
                style={actionsStyle}
              >
                {showActions && (
                  <>
                    <p className="m-0 text-sm leading-6 text-white/72">想看项目动向和后续骚操作，进频道。</p>
                    <div className="flex shrink-0 gap-2">
                      <Button className="justify-center border-white/28 bg-white/12 text-white hover:bg-white/20" onPress={handleTelegram} variant="outline">
                        <Send className="size-4" />
                        Telegram 频道
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </article>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

export default WhatsNewModal

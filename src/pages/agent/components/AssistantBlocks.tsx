import { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  Atom,
  Check,
  ChevronDown,
  CircleStop,
  Database,
  FileText,
  Globe2,
  Loader2,
  ChevronRight,
  Search,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { AssistantBlock, TextBlock as AgentTextBlock, ToolBlock as AgentToolBlock, ToolResult } from '../types'

interface Props {
  blocks: AssistantBlock[]
  streaming?: boolean
  onStop?: () => void
}

const toolMeta: Record<string, { label: string; tone: string; Icon: LucideIcon }> = {
  session_context: { label: 'session_context', tone: 'purple', Icon: Database },
  agent_runtime: { label: 'agent_runtime', tone: 'green', Icon: Wrench },
  search_messages: { label: 'search_messages', tone: 'blue', Icon: Search },
  export_chat: { label: 'export_chat', tone: 'amber', Icon: FileText },
  web_fetch: { label: 'web_fetch', tone: 'blue', Icon: Globe2 },
}

function normalizeMarkdownTables(text: string) {
  return text
    .replace(/([：:])\n(\|[^\n]+\|\n\|[\s:|-]+\|)/g, '$1\n\n$2')
}

function renderMarkdown(text: string) {
  const html = marked.parse(normalizeMarkdownTables(text || '')) as string
  return { __html: DOMPurify.sanitize(html) }
}

export function AssistantBlocks({ blocks, streaming, onStop }: Props) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'thinking') return <ThinkingBlock block={block} key={`${block.type}-${index}`} />
        if (block.type === 'tool') return <ToolBlock block={block} key={`${block.type}-${index}`} />
        return <TextBlock block={block} key={`${block.type}-${index}`} streaming={streaming && index === blocks.length - 1} />
      })}
      {streaming ? <StreamingIndicator onStop={onStop} /> : null}
    </>
  )
}

function ThinkingBlock({ block }: { block: Extract<AssistantBlock, { type: 'thinking' }> }) {
  const [open, setOpen] = useState(Boolean(block.streaming))
  const prevStreamingRef = useRef(block.streaming)

  useEffect(() => {
    if (block.streaming) {
      setOpen(true)
    }
    if (prevStreamingRef.current && !block.streaming) {
      setOpen(false)
    }
    prevStreamingRef.current = block.streaming
  }, [block.streaming])

  return (
    <div className={`think-panel qa-think-panel agent-thinking${!open ? ' collapsed' : ''} ${block.streaming ? 'thinking is-thinking' : ''}`}>
      <button className="think-header agent-thinking__header" type="button" onClick={() => setOpen(value => !value)}>
        <span className="think-title">
          {block.streaming
            ? <Loader2 size={14} className="think-icon animate-spin agent-thinking__spin" />
            : <Atom size={14} className="think-icon" />}
          <span>{block.streaming ? '深度思考中...' : '深度思考'}</span>
        </span>
        <ChevronDown
          size={16}
          className={`toggle-icon ${open ? 'expanded' : ''}`}
        />
      </button>
      <div
        className="think-content agent-thinking__body markdown-body"
        dangerouslySetInnerHTML={renderMarkdown(block.text)}
      />
    </div>
  )
}

function ToolBlock({ block }: { block: AgentToolBlock }) {
  const [open, setOpen] = useState(block.status !== 'running')
  const meta = toolMeta[block.name] || { label: block.name, tone: 'amber', Icon: Wrench }
  const Icon = meta.Icon
  const running = block.status === 'running'

  return (
    <div className={`agent-tool agent-tool--${meta.tone}${running ? ' is-running' : ''}`}>
      <button className="agent-tool__header" type="button" onClick={() => setOpen(value => !value)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="agent-tool__icon">
          <Icon size={14} />
        </span>
        <span className="agent-tool__name">{meta.label}</span>
        <span className="agent-tool__args">{formatArgs(block.args)}</span>
        <span className="agent-tool__status">
          {running ? (
            <>
              <span className="agent-spinner" />
              运行中
            </>
          ) : block.status === 'ok' ? (
            <>
              <Check size={12} />
              {block.duration || '完成'}
            </>
          ) : (
            <>
              <X size={12} />
              失败
            </>
          )}
        </span>
      </button>
      {open && block.result ? (
        <div className="agent-tool__body">
          <ToolResultView result={block.result} />
        </div>
      ) : null}
    </div>
  )
}

function TextBlock({ block, streaming }: { block: AgentTextBlock; streaming?: boolean }) {
  return (
    <div className="qa-bubble agent-answer-bubble">
      <div
        className="qa-answer markdown-body agent-text-block"
        dangerouslySetInnerHTML={renderMarkdown(block.text)}
      />
      {streaming ? <span className="agent-cursor" /> : null}
    </div>
  )
}

function ToolResultView({ result }: { result: ToolResult }) {
  if (result.kind === 'list') {
    return (
      <div className="agent-result-list">
        {(result.items || []).map(item => (
          <div className="agent-result-list__row" key={item}>{item}</div>
        ))}
      </div>
    )
  }

  if (result.kind === 'diff') {
    return (
      <pre className="agent-code agent-code--diff">
        <code>
          {(result.text || '').split('\n').map((line, index) => {
            const className = line.startsWith('+') ? 'is-add' : line.startsWith('-') ? 'is-del' : undefined
            return <span className={className} key={`${line}-${index}`}>{line || ' '}</span>
          })}
        </code>
      </pre>
    )
  }

  return (
    <pre className={`agent-code${result.kind === 'terminal' ? ' agent-code--terminal' : ''}`}>
      <code>{result.text}</code>
    </pre>
  )
}

function StreamingIndicator({ onStop }: { onStop?: () => void }) {
  return (
    <div className="agent-streaming">
      <span className="agent-spinner" />
      <span>正在生成回复</span>
      <button type="button" onClick={onStop}>
        <CircleStop size={12} />
        停止
      </button>
    </div>
  )
}

function formatArgs(args?: Record<string, unknown>) {
  if (!args) return ''
  const entries = Object.entries(args)
  if (!entries.length) return ''
  const [key, value] = entries[0]
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `${key}: ${text}${entries.length > 1 ? ` +${entries.length - 1}` : ''}`
}

import * as readline from 'node:readline'
import { clearConfig, patchConfig, parseLimit, readConfig, resolveRuntimeConfig } from './config.js'
import { errorEnvelope, successEnvelope, writeEnvelope } from './output.js'
import type { CommandContext } from './commandRunner.js'
import type { GlobalCliOptions, OutputFormat, RuntimeConfig } from './types.js'
import type { StatusData } from './services/types.js'

export interface InteractiveCommand {
  name: string
  usage: string
  description: string
}

export interface InteractiveShellOptions {
  initialCommand?: string
}

const COMMANDS: InteractiveCommand[] = [
  { name: '/status', usage: '/status', description: '检查配置和数据库连接状态' },
  { name: '/config', usage: '/config show|set|clear', description: '查看或修改配置' },
  { name: '/sessions', usage: '/sessions [--limit 20] [--type private|group|mp]', description: '列出会话' },
  { name: '/messages', usage: '/messages <会话> [--limit 50] [--cursor n]', description: '查询会话消息' },
  { name: '/contacts', usage: '/contacts [--limit 50] [--type friend|group|mp]', description: '列出联系人' },
  { name: '/contact', usage: '/contact <wxid或名称>', description: '查看联系人详情' },
  { name: '/key', usage: '/key setup|get|test|set <hex>', description: '密钥管理' },
  { name: '/search', usage: '/search <关键词>', description: '全文搜索' },
  { name: '/stats', usage: '/stats global|contacts|time|session|keywords|group', description: '统计分析' },
  { name: '/export', usage: '/export <会话> [--output path]', description: '导出聊天数据' },
  { name: '/moments', usage: '/moments [--limit 20]', description: '朋友圈数据' },
  { name: '/report', usage: '/report [--year 2025|--all-time]', description: '年度报告数据' },
  { name: '/mcp', usage: '/mcp serve', description: '独立 MCP Server 模式' },
  { name: '/help', usage: '/help', description: '显示命令列表' },
  { name: '/exit', usage: '/exit', description: '退出交互模式' }
]

type ParsedInteractiveInput = { command: string; args: string[] }

type ParsedOptions = {
  options: Record<string, string | boolean>
  positional: string[]
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[38;5;51m',
  blue: '\x1b[38;5;39m',
  teal: '\x1b[38;5;43m',
  mint: '\x1b[38;5;121m',
  white: '\x1b[97m',
  gray: '\x1b[38;5;245m',
  amber: '\x1b[38;5;221m'
} as const

function paint(text: string, ...codes: string[]): string {
  if (process.env.NO_COLOR) return text
  return `${codes.join('')}${text}${ANSI.reset}`
}

export function getInteractiveCommands(): InteractiveCommand[] {
  return [...COMMANDS]
}

export function parseSlashInput(input: string): ParsedInteractiveInput {
  const tokens = splitArgs(input.trim())
  const command = tokens[0] || ''
  return { command, args: tokens.slice(1) }
}

export function filterInteractiveCommands(input: string): InteractiveCommand[] {
  const normalized = input.trim().toLowerCase()
  if (!normalized.startsWith('/')) return []
  const query = normalized.slice(1)
  return COMMANDS.filter((command) => command.name.slice(1).toLowerCase().startsWith(query))
}

function splitArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of input) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

function parseOptions(args: string[]): ParsedOptions {
  const options: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2)
    if (inlineValue !== undefined) {
      options[rawName] = inlineValue
      continue
    }

    const next = args[index + 1]
    if (next && !next.startsWith('--')) {
      options[rawName] = next
      index += 1
    } else {
      options[rawName] = true
    }
  }

  return { options, positional }
}

function showCommandList(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length))
  return [
    '可用命令：',
    ...COMMANDS.map((command) => `  ${command.usage.padEnd(width)}  ${command.description}`)
  ].join('\n')
}

export function renderWelcomeScreen(): string {
  return [
    paint('┌──────────────────────────────────────────────┐', ANSI.cyan),
    `${paint('│', ANSI.cyan)}  ${paint('Welcome to CipherTalk CLI', ANSI.bold, ANSI.white)}                   ${paint('│', ANSI.cyan)}`,
    `${paint('│', ANSI.cyan)}  ${paint('欢迎使用密语命令行工具', ANSI.mint)}                      ${paint('│', ANSI.cyan)}`,
    paint('└──────────────────────────────────────────────┘', ANSI.cyan),
    '',
    paint(' ██████╗ ██╗ ██████╗  ██╗  ██╗ ███████╗ ██████╗  ████████╗  █████╗  ██╗      ██╗  ██╗', ANSI.blue),
    paint('██╔════╝ ██║ ██╔══██╗ ██║  ██║ ██╔════╝ ██╔══██╗ ╚══██╔══╝ ██╔══██╗ ██║      ██║ ██╔╝', ANSI.blue),
    paint('██║      ██║ ██████╔╝ ███████║ █████╗   ██████╔╝    ██║    ███████║ ██║      █████╔╝', ANSI.teal),
    paint('██║      ██║ ██╔═══╝  ██╔══██║ ██╔══╝   ██╔══██╗    ██║    ██╔══██║ ██║      ██╔═██╗', ANSI.teal),
    paint('╚██████╗ ██║ ██║      ██║  ██║ ███████╗ ██║  ██║    ██║    ██║  ██║ ███████╗ ██║  ██╗', ANSI.cyan),
    paint(' ╚═════╝ ╚═╝ ╚═╝      ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝    ╚═╝    ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝', ANSI.cyan, ANSI.dim),
    '',
    paint('本地微信数据命令行工作台', ANSI.gray),
    '',
    paint('按 Enter 继续', ANSI.amber)
  ].join('\n')
}

function shellFormat(config: RuntimeConfig, globals: GlobalCliOptions, options: Record<string, string | boolean>): OutputFormat {
  const explicit = asString(options.format) || globals.format
  if (explicit === 'json' || explicit === 'jsonl' || explicit === 'csv' || explicit === 'markdown' || explicit === 'table') {
    return explicit
  }
  return config.defaultFormat === 'json' ? 'table' : config.defaultFormat
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function commandLimit(options: Record<string, string | boolean>, fallback: number): number {
  return parseLimit(asString(options.limit), fallback)
}

function formatShellValue(value: unknown): string {
  if (value === true) return '是'
  if (value === false) return '否'
  if (value === null || value === undefined || value === '') return '未配置'
  return String(value)
}

function statusRows(data: StatusData): Array<{ 项目: string; 内容: string }> {
  const rows = [
    { 项目: '配置状态', 内容: data.configured ? '已配置' : '未配置' },
    { 项目: '配置文件', 内容: formatShellValue(data.configPath) },
    { 项目: '数据库路径', 内容: formatShellValue(data.dbPath) },
    { 项目: '微信账号', 内容: formatShellValue(data.wxid) },
    { 项目: '原生模块目录', 内容: formatShellValue(data.nativeRoot) },
    { 项目: '数据库文件数', 内容: String(data.databaseFiles) }
  ]

  if (data.connection) {
    rows.push(
      { 项目: '连接状态', 内容: data.connection.ok ? '正常' : '失败' },
      { 项目: '会话数量', 内容: formatShellValue(data.connection.sessionCount) }
    )
    if (data.connection.error) rows.push({ 项目: '连接错误', 内容: data.connection.error })
  }

  return rows
}

function statusHint(data: StatusData): string | null {
  if (data.configured) return null
  return [
    '尚未配置数据库路径或密钥。',
    '可执行：/config set --db-path "<微信Msg目录>" --wxid "<wxid>"',
    '然后执行：/key setup 选择自动获取或手动填写密钥'
  ].join('\n')
}

async function askLine(promptText: string): Promise<string> {
  process.stdin.setRawMode?.(false)
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  const answer = await new Promise<string>((resolve) => {
    rl.question(promptText, resolve)
  })
  rl.close()
  process.stdin.setRawMode?.(true)
  return answer.trim()
}

async function runKeySetup(context: CommandContext, config: RuntimeConfig, format: OutputFormat): Promise<void> {
  context.output.stdout([
    '请选择密钥配置方式：',
    '  1. 自动获取：从正在运行的微信进程提取密钥',
    '  2. 手动填写：粘贴 64 位十六进制密钥',
    ''
  ].join('\n'))

  const choice = await askLine('请输入 1 或 2：')
  if (choice === '1') {
    const result = await context.services.key.getKey(config, { save: true })
    writeEnvelope(context.output, successEnvelope(result), format)
    return
  }
  if (choice === '2') {
    const hex = await askLine('请输入 64 位十六进制密钥：')
    const result = await context.services.key.setKey(hex)
    writeEnvelope(context.output, successEnvelope(result), format)
    return
  }
  throw new Error('已取消：请输入 1 选择自动获取，或输入 2 选择手动填写')
}

async function runShellCommand(line: string, context: CommandContext, globals: GlobalCliOptions): Promise<boolean> {
  const parsed = parseSlashInput(line)
  if (!parsed.command) return true
  if (!parsed.command.startsWith('/')) {
    context.output.stderr('交互模式命令需要以 / 开头，例如 /status。')
    return true
  }

  const { options, positional } = parseOptions(parsed.args)
  const config = resolveRuntimeConfig({ ...globals, limit: asString(options.limit) || globals.limit })
  const format = shellFormat(config, globals, options)

  try {
    switch (parsed.command) {
      case '/':
      case '/help':
        context.output.stdout(showCommandList())
        return true
      case '/exit':
      case '/quit':
        return false
      case '/status': {
        const data = await context.services.data.getStatus(config)
        const hint = statusHint(data)
        writeEnvelope(context.output, successEnvelope({ 状态: statusRows(data) }, { hint }), format)
        if (hint && format === 'table') context.output.stdout(`\n${hint}`)
        return true
      }
      case '/config': {
        const action = positional[0] || 'show'
        if (action === 'show') {
          writeEnvelope(context.output, successEnvelope({
            配置: readConfig(),
            配置文件: config.configPath
          }), format)
          return true
        }
        if (action === 'set') {
          const patch = {
            ...(typeof options['db-path'] === 'string' ? { dbPath: options['db-path'] } : {}),
            ...(typeof options.wxid === 'string' ? { wxid: options.wxid } : {}),
            ...(typeof options.key === 'string' ? { keyHex: options.key.toLowerCase() } : {}),
            ...(typeof options.format === 'string' ? { defaultFormat: options.format as any } : {}),
            ...(typeof options.limit === 'string' ? { defaultLimit: Number(options.limit) } : {}),
            ...(typeof options['cache-dir'] === 'string' ? { cacheDir: options['cache-dir'] } : {})
          }
          const saved = patchConfig(patch)
          writeEnvelope(context.output, successEnvelope({ 已保存: saved, 配置文件: config.configPath }), format)
          return true
        }
        if (action === 'clear') {
          const keys = positional.slice(1).map((key) => key === 'key' ? 'keyHex' : key) as any[]
          const saved = clearConfig(keys.length > 0 ? keys : undefined)
          writeEnvelope(context.output, successEnvelope({ 已保存: saved, 配置文件: config.configPath }), format)
          return true
        }
        throw new Error('用法: /config show|set|clear')
      }
      case '/sessions': {
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.listSessions(config, {
          limit,
          type: asString(options.type)
        })
        writeEnvelope(context.output, successEnvelope({ sessions: result.sessions }, { total: result.sessions.length, limit, hasMore: result.hasMore }), format)
        return true
      }
      case '/messages': {
        const session = positional[0]
        if (!session) throw new Error('用法: /messages <会话> [--limit 50]')
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.getMessages(config, session, {
          limit,
          cursor: asString(options.cursor),
          direction: asString(options.direction),
          type: asString(options.type),
          from: asString(options.from),
          to: asString(options.to)
        })
        writeEnvelope(context.output, successEnvelope({ messages: result.messages }, { total: result.messages.length, limit, cursor: result.cursor }), format)
        return true
      }
      case '/contacts': {
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.listContacts(config, {
          limit,
          type: asString(options.type)
        })
        writeEnvelope(context.output, successEnvelope({ contacts: result.contacts }, { total: result.contacts.length, limit }), format)
        return true
      }
      case '/contact': {
        const contact = positional[0]
        if (!contact) throw new Error('用法: /contact <wxid或名称>')
        const data = await context.services.data.getContactInfo(config, contact)
        writeEnvelope(context.output, successEnvelope({ contact: data }, { total: data ? 1 : 0 }), format)
        return true
      }
      case '/key': {
        const action = positional[0]
        if (!action || action === 'setup') {
          await runKeySetup(context, config, format)
          return true
        }
        if (action === 'set') {
          const hex = positional[1]
          if (!hex) throw new Error('用法: /key set <hex>')
          writeEnvelope(context.output, successEnvelope(await context.services.key.setKey(hex)), format)
          return true
        }
        if (action === 'test') {
          writeEnvelope(context.output, successEnvelope(await context.services.key.testKey(config)), format)
          return true
        }
        if (action === 'get') {
          writeEnvelope(context.output, successEnvelope(await context.services.key.getKey(config, { save: true })), format)
          return true
        }
        throw new Error('用法: /key setup|get|test|set <hex>')
      }
      case '/search': {
        const keyword = positional.join(' ')
        if (!keyword) throw new Error('用法: /search <关键词>')
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.advanced.search(config, keyword, {
          limit,
          session: asString(options.session)
        })
        writeEnvelope(context.output, successEnvelope({ messages: result.messages }, { total: result.total, keyword, limit }), format)
        return true
      }
      case '/stats': {
        const sub = positional[0] || 'global'
        const result = await context.services.advanced.stats(config, {
          type: sub as any,
          session: positional[1],
          top: typeof options.top === 'string' ? Number(options.top) : undefined
        })
        writeEnvelope(context.output, successEnvelope(result), format)
        return true
      }
      case '/export': {
        const result = await context.services.advanced.exportChat(config, {
          session: positional[0],
          all: options.all === true,
          output: asString(options.output),
          from: asString(options.from),
          to: asString(options.to),
          withMedia: options['with-media'] === true
        })
        writeEnvelope(context.output, successEnvelope(result), format)
        return true
      }
      case '/moments':
        context.output.stderr('朋友圈功能暂不支持。请使用桌面版密语查看朋友圈。')
        return true
      case '/report':
        context.output.stderr('年度报告功能暂不支持。请使用桌面版密语生成年度报告。')
        return true
      case '/mcp':
        if (positional[0] === 'serve') {
          await context.services.advanced.mcpServe()
          return true
        }
        throw new Error('用法: /mcp serve')
      default:
        context.output.stderr(`未知命令: ${parsed.command}\n输入 / 查看所有命令。`)
        return true
    }
  } catch (error) {
    writeEnvelope(context.output, errorEnvelope(error), format)
    return true
  }
}

export async function startInteractiveShell(
  context: CommandContext,
  globals: GlobalCliOptions,
  options: InteractiveShellOptions = {}
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    context.output.stderr('当前终端不支持交互界面。请在真实终端中运行，或使用 --format json 输出脚本结果。')
    return
  }

  const input = process.stdin
  const output = process.stdout
  const prompt = 'miyu> '
  let buffer = ''
  let closed = false
  let selectedSuggestion = 0
  let enteredMainScreen = false

  readline.emitKeypressEvents(input)
  input.setRawMode?.(true)
  input.resume()

  const enterScreen = () => {
    output.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l')
  }

  const leaveScreen = () => {
    output.write('\x1b[?25h\x1b[?1049l')
  }

  const clearScreen = () => {
    output.write('\x1b[2J\x1b[H')
  }

  const renderHeader = () => {
    output.write([
      'CipherTalk CLI 工作台',
      '输入 / 显示命令，输入 /help 查看帮助，输入 /exit 退出。',
      '────────────────────────────────────────────────────────',
      ''
    ].join('\n'))
  }

  const currentSuggestions = () => filterInteractiveCommands(buffer)

  const renderSuggestions = () => {
    const suggestions = currentSuggestions()
    if (!buffer.startsWith('/') || suggestions.length === 0) return

    const limit = Math.min(suggestions.length, 8)
    const width = Math.max(...suggestions.slice(0, limit).map((command) => command.usage.length))
    output.write('\n')
    for (let index = 0; index < limit; index += 1) {
      const command = suggestions[index]
      const prefix = index === selectedSuggestion ? '›' : ' '
      output.write(`${prefix} ${command.usage.padEnd(width)}  ${command.description}\n`)
    }
    if (suggestions.length > limit) {
      output.write(`  还有 ${suggestions.length - limit} 个命令，继续输入可缩小范围\n`)
    }
  }

  const render = () => {
    clearScreen()
    renderHeader()
    readline.clearLine(output, 0)
    readline.cursorTo(output, 0)
    output.write(`${prompt}${buffer}`)
    renderSuggestions()
  }

  const printList = () => {
    output.write(`\n${showCommandList()}\n`)
    render()
  }

  enterScreen()
  output.write(renderWelcomeScreen())

  await new Promise<void>((resolve) => {
    const close = () => {
      if (closed) return
      closed = true
      input.off('keypress', onKeypress)
      input.setRawMode?.(false)
      input.pause()
      leaveScreen()
      resolve()
    }

    const enterMainScreen = async () => {
      enteredMainScreen = true
      clearScreen()
      output.write('\x1b[?25h')
      renderHeader()
      if (options.initialCommand) {
        await runShellCommand(options.initialCommand, context, globals)
        output.write('\n')
      }
      render()
    }

    const execute = async () => {
      const line = buffer.trim()
      buffer = ''
      output.write('\n')
      input.setRawMode?.(false)
      const shouldContinue = await runShellCommand(line, context, globals)
      if (!shouldContinue) {
        close()
        return
      }
      input.setRawMode?.(true)
      render()
    }

    const onKeypress = (char: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        close()
        return
      }

      if (!enteredMainScreen) {
        if (key.name === 'return' || key.name === 'enter') {
          void enterMainScreen()
          return
        }
        return
      }

      if (key.name === 'return' || key.name === 'enter') {
        const suggestions = currentSuggestions()
        const isOnlySlashCommand = /^\/[^\s]*$/.test(buffer)
        if (isOnlySlashCommand && suggestions.length > 0) {
          const selected = suggestions[Math.min(selectedSuggestion, suggestions.length - 1)]
          if (selected.name === buffer || buffer === '/exit' || buffer === '/quit' || buffer === '/help') {
            void execute()
          } else {
            buffer = selected.name
            selectedSuggestion = 0
            render()
          }
          return
        }
        void execute()
        return
      }
      if (key.name === 'backspace') {
        buffer = buffer.slice(0, -1)
        selectedSuggestion = 0
        render()
        return
      }
      if (key.name === 'up') {
        const suggestions = currentSuggestions()
        if (suggestions.length > 0) {
          selectedSuggestion = (selectedSuggestion - 1 + suggestions.length) % suggestions.length
          render()
        }
        return
      }
      if (key.name === 'down') {
        const suggestions = currentSuggestions()
        if (suggestions.length > 0) {
          selectedSuggestion = (selectedSuggestion + 1) % suggestions.length
          render()
        }
        return
      }
      if (key.name === 'tab') {
        const suggestions = currentSuggestions()
        if (suggestions.length > 0) {
          const selected = suggestions[Math.min(selectedSuggestion, suggestions.length - 1)]
          buffer = selected.name
          selectedSuggestion = 0
          render()
        } else {
          printList()
        }
        return
      }
      if (key.name === 'escape') return
      if (!char) return

      buffer += char
      selectedSuggestion = 0
      render()
    }

    input.on('keypress', onKeypress)
  })
}

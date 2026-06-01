import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  Disclosure,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner,
  Switch,
  TextArea,
  TextField,
  Toast,
  toast,
} from '@heroui/react'
import { marked } from 'marked'
import JSZip from 'jszip'
import { Check, Copy, Download, Save, Plus, Trash2, Eye, Pencil, Plug, Unplug, Upload, FileCode, X, Sparkles } from 'lucide-react'
import * as configService from '../services/config'

type McpLaunchConfig = {
  command: string
  args: string[]
  cwd: string
  mode: 'dev' | 'packaged'
}

type SkillInfo = { name: string; version: string; description: string; builtin: boolean }

type McpClientConfig = {
  type: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
  autoConnect?: boolean
}

type McpServerStatus = {
  name: string
  config: McpClientConfig
  status: string
  toolCount: number
  error?: string
}

type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: unknown
}

type TopTab = 'server' | 'integration'

type ServerFormState = {
  name: string
  type: string
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  timeoutMs: string
}

type SkillPanelState = {
  name: string
  mode: 'preview' | 'edit'
}

type SkillDialogState = SkillPanelState | null

function formatCommandPart(value: string) {
  if (!value) return value
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function getPackagedLauncherLabel(command: string) {
  return command.endsWith('ciphertalk-mcp') ? '`ciphertalk-mcp`' : '`ciphertalk-mcp.cmd`'
}

function createEmptyServerForm(): ServerFormState {
  return {
    name: '',
    type: 'stdio',
    command: '',
    args: '',
    env: '',
    cwd: '',
    url: '',
    headers: '',
    timeoutMs: '30000',
  }
}

type ParsedServerResult = { name?: string; form: Partial<ServerFormState>; error?: string }

function configObjectToForm(cfg: Record<string, unknown>): Partial<ServerFormState> {
  const form: Partial<ServerFormState> = {}
  if (typeof cfg.url === 'string' && cfg.url) {
    form.type = cfg.url.endsWith('/sse') ? 'sse' : 'http'
    form.url = cfg.url
    if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
      form.headers = Object.entries(cfg.headers as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('\n')
    }
  } else if (typeof cfg.command === 'string' && cfg.command) {
    form.type = 'stdio'
    form.command = cfg.command
    if (Array.isArray(cfg.args)) {
      form.args = (cfg.args as unknown[]).map(a => {
        const s = String(a)
        return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
      }).join(' ')
    }
    if (typeof cfg.cwd === 'string') form.cwd = cfg.cwd
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      form.env = Object.entries(cfg.env as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('\n')
    }
  }
  if (typeof cfg.timeout === 'number') form.timeoutMs = String(cfg.timeout)
  return form
}

function parseServerJson(text: string): ParsedServerResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return { form: {}, error: 'JSON 格式错误，请检查括号和引号是否匹配' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { form: {}, error: '请粘贴对象格式的 JSON' }
  }
  const obj = parsed as Record<string, unknown>

  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const entries = Object.entries(obj.mcpServers as Record<string, unknown>)
    if (entries.length === 0) return { form: {}, error: 'mcpServers 中没有服务器' }
    const [name, cfg] = entries[0]
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { form: {}, error: '服务器配置格式不正确' }
    return { name, form: configObjectToForm(cfg as Record<string, unknown>) }
  }

  if (obj.command || obj.url) {
    return { form: configObjectToForm(obj) }
  }

  const entries = Object.entries(obj)
  if (entries.length > 0) {
    const [name, cfg] = entries[0]
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      const cfgObj = cfg as Record<string, unknown>
      if (cfgObj.command || cfgObj.url) {
        return { name, form: configObjectToForm(cfgObj) }
      }
    }
  }

  return { form: {}, error: '无法识别格式，支持：完整 mcpServers 包裹 / 单条服务器对象 / 直接 command/url 配置' }
}

function stringifyKeyValueLines(value?: Record<string, string>) {
  if (!value) return ''
  return Object.entries(value).map(([key, val]) => `${key}=${val}`).join('\n')
}

function parseKeyValueLines(value: string): Record<string, string> | undefined {
  const entries = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separator = line.indexOf('=')
      if (separator < 0) return null
      const key = line.slice(0, separator).trim()
      const val = line.slice(separator + 1).trim()
      return key ? [key, val] as const : null
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry))
  return entries.length ? Object.fromEntries(entries) : undefined
}

function parseArgs(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  return parts.map(part => part.replace(/^["']|["']$/g, '')).filter(Boolean)
}

function renderMarkdown(content: string) {
  return { __html: marked.parse(content || '') as string }
}

function McpPage() {
  const [topTab, setTopTab] = useState<TopTab>('server')

  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpExposeMediaPaths, setMcpExposeMediaPaths] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exportingSkillZip, setExportingSkillZip] = useState<string | null>(null)
  const [launchConfig, setLaunchConfig] = useState<McpLaunchConfig>({
    command: 'npm', args: ['run', 'mcp'], cwd: 'D:/CipherTalk', mode: 'dev',
  })

  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])

  const [skillDialog, setSkillDialog] = useState<SkillDialogState>(null)
  const [skillContent, setSkillContent] = useState('')
  const [editingSkillContent, setEditingSkillContent] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'skill' | 'server'; name: string } | null>(null)
  const [serverPanelOpen, setServerPanelOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<string | null>(null)
  const [serverForm, setServerForm] = useState<ServerFormState>(createEmptyServerForm)
  const [serverBusy, setServerBusy] = useState<Record<string, 'connect' | 'disconnect' | 'tools'>>({})
  const [toolDialogServer, setToolDialogServer] = useState<string | null>(null)
  const [serverTools, setServerTools] = useState<Record<string, McpToolInfo[]>>({})
  const [serverFormMode, setServerFormMode] = useState<'fields' | 'json'>('fields')
  const [jsonPasteText, setJsonPasteText] = useState('')
  const [jsonPasteError, setJsonPasteError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [enabled, exposeMediaPaths, skillList] = await Promise.all([
          configService.getMcpEnabled(),
          configService.getMcpExposeMediaPaths(),
          window.electronAPI.skillManager.list(),
        ])
        setMcpEnabled(enabled)
        setMcpExposeMediaPaths(exposeMediaPaths)
        setSkills(skillList)
        try {
          const cfg = await window.electronAPI.app.getMcpLaunchConfig()
          if (cfg?.command && Array.isArray(cfg.args) && cfg.cwd) setLaunchConfig(cfg)
        } catch (inner) {
          if (!String(inner || '').includes("No handler registered for 'app:getMcpLaunchConfig'"))
            console.error('获取 MCP 启动配置失败:', inner)
        }
      } catch (e) {
        console.error('加载 MCP 配置失败:', e)
        toast.danger('加载 MCP 配置失败')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  const loadIntegrationData = useCallback(async () => {
    try {
      const [skillList, serverList] = await Promise.all([
        window.electronAPI.skillManager.list(),
        window.electronAPI.mcpClient.listStatuses(),
      ])
      setSkills(skillList)
      setMcpServers(serverList)
    } catch (e) {
      console.error('加载集成数据失败:', e)
    }
  }, [])

  useEffect(() => {
    if (topTab === 'integration') void loadIntegrationData()
  }, [topTab, loadIntegrationData])

  const mcpRunCommand = useMemo(() => {
    return [launchConfig.command, ...launchConfig.args].map(formatCommandPart).join(' ')
  }, [launchConfig])

  const mcpServerJsonTemplate = useMemo(() => JSON.stringify({
    mcpServers: { ciphertalk: { command: launchConfig.command, args: launchConfig.args, cwd: launchConfig.cwd } },
  }, null, 2), [launchConfig])

  const handleSave = async () => {
    setSaving(true)
    try {
      await Promise.all([configService.setMcpEnabled(mcpEnabled), configService.setMcpExposeMediaPaths(mcpExposeMediaPaths)])
      toast.success('MCP 配置已保存')
    } catch { toast.danger('保存 MCP 配置失败') }
    finally { setSaving(false) }
  }

  const copyText = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${label}已复制`) }
    catch { toast.danger('复制失败，请手动复制') }
  }

  const exportSkillZip = async (skillName: string) => {
    setExportingSkillZip(skillName)
    try {
      const result = await window.electronAPI.skillManager.exportZip(skillName)
      toast[result.success ? 'success' : 'danger'](
        result.success ? `Skill 已导出到 ${result.outputPath}` : (result.error || '导出失败')
      )
    } catch { toast.danger('导出失败') }
    finally { setExportingSkillZip(null) }
  }

  const openSkillPanel = async (name: string, mode: 'preview' | 'edit') => {
    const result = await window.electronAPI.skillManager.readContent(name)
    if (result.success) {
      setSkillContent(result.content || '')
      setEditingSkillContent(result.content || '')
      setSkillDialog({ name, mode })
    } else toast.danger(result.error || '读取失败')
  }

  const saveEditSkill = async () => {
    if (!skillDialog?.name) return
    const result = await window.electronAPI.skillManager.updateContent(skillDialog.name, editingSkillContent)
    toast[result.success ? 'success' : 'danger'](result.success ? 'Skill 已保存' : (result.error || '保存失败'))
    if (result.success) {
      setSkillContent(editingSkillContent)
      setSkillDialog({ name: skillDialog.name, mode: 'preview' })
      void loadIntegrationData()
    }
  }

  const deleteSkill = async (name: string) => {
    const result = await window.electronAPI.skillManager.delete(name)
    toast[result.success ? 'success' : 'danger'](result.success ? `Skill "${name}" 已删除` : (result.error || '删除失败'))
    setDeleteTarget(null)
    if (result.success) void loadIntegrationData()
  }

  const importSkill = async () => {
    try {
      const { canceled, filePaths } = await window.electronAPI.dialog.openFile({
        title: '导入 Skill 压缩包',
        filters: [{ name: 'Zip', extensions: ['zip'] }],
        properties: ['openFile'],
      })
      if (canceled || !filePaths?.[0]) return
      const result = await window.electronAPI.skillManager.importZip(filePaths[0])
      toast[result.success ? 'success' : 'danger'](
        result.success ? `Skill "${result.skillName}" 已导入` : (result.error || '导入失败')
      )
      if (result.success) void loadIntegrationData()
    } catch { toast.danger('导入失败') }
  }

  const downloadSkillTemplate = async () => {
    try {
      const zip = new JSZip()
      const root = zip.folder('ciphertalk-skill-template')
      root?.file('SKILL.md', `---\nname: ciphertalk-example\nversion: '1.0.0'\ndescription: Describe what this skill helps with.\n---\n\n# CipherTalk Example Skill\n\n## When to use\nUse this skill when...\n\n## Workflow\n1. Read the user request.\n2. Use the relevant CipherTalk context.\n3. Return a concise answer.\n`)
      root?.folder('references')?.file('README.md', '# References\n\nPut supporting docs here when the skill needs them.\n')
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'ciphertalk-skill-template.zip'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success('Skill 导入模板已生成')
    } catch { toast.danger('模板生成失败') }
  }

  const connectServer = async (name: string) => {
    if (serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'connect' }))
    try {
      const result = await window.electronAPI.mcpClient.connect(name)
      if (result.success && result.tools) setServerTools(prev => ({ ...prev, [name]: result.tools || [] }))
      toast[result.success ? 'success' : 'danger'](
        result.success ? `已连接到 "${name}"，发现 ${result.tools?.length ?? 0} 个工具` : (result.error || '连接失败')
      )
      void loadIntegrationData()
    } finally {
      setServerBusy(prev => { const n = { ...prev }; delete n[name]; return n })
    }
  }

  const disconnectServer = async (name: string) => {
    if (serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'disconnect' }))
    try {
      const result = await window.electronAPI.mcpClient.disconnect(name)
      if (result.success) setToolDialogServer(current => current === name ? null : current)
      toast[result.success ? 'success' : 'danger'](result.success ? `已断开 "${name}"` : (result.error || '断开失败'))
      void loadIntegrationData()
    } finally {
      setServerBusy(prev => { const n = { ...prev }; delete n[name]; return n })
    }
  }

  const openToolsDialog = async (name: string) => {
    setToolDialogServer(name)
    if (serverTools[name] || serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'tools' }))
    try {
      const result = await window.electronAPI.mcpClient.listTools(name)
      if (result.success) setServerTools(prev => ({ ...prev, [name]: result.tools || [] }))
      else toast.danger(result.error || '工具加载失败')
    } finally {
      setServerBusy(prev => { const n = { ...prev }; delete n[name]; return n })
    }
  }

  const resetJsonPasteState = () => {
    setServerFormMode('fields')
    setJsonPasteText('')
    setJsonPasteError(null)
  }

  const applyJsonPaste = () => {
    const result = parseServerJson(jsonPasteText)
    if (result.error) { setJsonPasteError(result.error); return }
    setJsonPasteError(null)
    setServerForm(prev => ({
      ...createEmptyServerForm(),
      ...prev,
      ...(result.name && !editingServer ? { name: result.name } : {}),
      ...result.form,
    }))
    setServerFormMode('fields')
  }

  const openAddServer = () => {
    if (serverPanelOpen && !editingServer) { setServerPanelOpen(false); resetJsonPasteState(); return }
    setEditingServer(null)
    setServerForm(createEmptyServerForm())
    resetJsonPasteState()
    setServerPanelOpen(true)
  }

  const openEditServer = (srv: McpServerStatus) => {
    if (serverPanelOpen && editingServer === srv.name) {
      setServerPanelOpen(false); setEditingServer(null); setServerForm(createEmptyServerForm()); resetJsonPasteState()
      return
    }
    setServerPanelOpen(true)
    setEditingServer(srv.name)
    setServerForm({
      name: srv.name,
      type: srv.config.type,
      command: srv.config.command || '',
      args: srv.config.args?.join(' ') || '',
      env: stringifyKeyValueLines(srv.config.env),
      cwd: srv.config.cwd || '',
      url: srv.config.url || '',
      headers: stringifyKeyValueLines(srv.config.headers),
      timeoutMs: String(srv.config.timeoutMs || 30000),
    })
  }

  const saveServer = async () => {
    const name = serverForm.name.trim()
    if (!name) { toast.danger('请输入服务器名称'); return }
    if (!editingServer && mcpServers.some(s => s.name === name)) { toast.danger(`服务器 "${name}" 已存在，请换一个名称`); return }
    const timeoutMs = Number(serverForm.timeoutMs)
    if (serverForm.timeoutMs.trim() && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) { toast.danger('超时时间必须是正整数毫秒'); return }
    const config: McpClientConfig = { type: serverForm.type }
    if (serverForm.type === 'stdio') {
      if (!serverForm.command.trim()) { toast.danger('请输入启动命令'); return }
      config.command = serverForm.command.trim()
      config.args = parseArgs(serverForm.args)
      config.env = parseKeyValueLines(serverForm.env)
      config.cwd = serverForm.cwd.trim() || undefined
    } else {
      if (!serverForm.url.trim()) { toast.danger('请输入服务器 URL'); return }
      config.url = serverForm.url.trim()
      config.headers = parseKeyValueLines(serverForm.headers)
    }
    config.timeoutMs = serverForm.timeoutMs.trim() ? Math.round(timeoutMs) : undefined
    const result = await window.electronAPI.mcpClient.saveConfig(name, config, Boolean(editingServer))
    toast[result.success ? 'success' : 'danger'](result.success ? `服务器 "${name}" 已保存` : (result.error || '保存失败'))
    if (result.success) {
      setEditingServer(null); setServerPanelOpen(false); setServerForm(createEmptyServerForm())
      void loadIntegrationData()
    }
  }

  const deleteServer = async (name: string) => {
    const result = await window.electronAPI.mcpClient.deleteConfig(name)
    toast[result.success ? 'success' : 'danger'](result.success ? `服务器 "${name}" 已删除` : (result.error || '删除失败'))
    setDeleteTarget(null)
    if (result.success) void loadIntegrationData()
  }

  const renderStatusChip = (status: string) => {
    const map: Record<string, { label: string; color: 'success' | 'danger' | 'default' | 'warning' }> = {
      connected: { label: '已连接', color: 'success' },
      disconnected: { label: '未连接', color: 'default' },
      error: { label: '错误', color: 'danger' },
      connecting: { label: '连接中', color: 'warning' },
    }
    const info = map[status] || map.disconnected
    return <Chip color={info.color} variant="secondary" size="sm">{info.label}</Chip>
  }

  const closeServerPanel = () => {
    setServerPanelOpen(false); setEditingServer(null); setServerForm(createEmptyServerForm()); resetJsonPasteState()
  }

  const renderServerForm = () => (
    <Card className="border-2 border-accent bg-surface-tertiary">
      <Card.Header className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <Card.Title>{editingServer ? `编辑服务器：${editingServer}` : '添加 MCP 服务器'}</Card.Title>
          <Card.Description>参数会保存到本机 MCP 客户端配置中。</Card.Description>
        </div>
        <Button isIconOnly variant="tertiary" size="sm" onPress={closeServerPanel}><X size={16} /></Button>
      </Card.Header>
      <Card.Content>
        <div className="flex flex-col gap-4">
          {!editingServer && (
            <div className="flex gap-2">
              <Button variant={serverFormMode === 'fields' ? 'primary' : 'tertiary'} size="sm"
                onPress={() => setServerFormMode('fields')}>表单填写</Button>
              <Button variant={serverFormMode === 'json' ? 'primary' : 'tertiary'} size="sm"
                onPress={() => setServerFormMode('json')}>粘贴 JSON</Button>
            </div>
          )}

          {serverFormMode === 'json' ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted">
                粘贴来自 Claude Desktop、Cursor 等工具的{' '}
                <code className="px-1.5 py-0.5 rounded bg-surface text-xs font-mono text-foreground">mcpServers</code>
                {' '}配置，系统会自动识别并填入表单。
              </p>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-foreground font-semibold">JSON 配置</span>
                <TextArea
                  value={jsonPasteText}
                  onChange={(e) => { setJsonPasteText(e.target.value); setJsonPasteError(null) }}
                  placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "some-mcp-server"]\n    }\n  }\n}'}
                  className="min-h-[200px] font-mono text-xs"
                />
                <span className={`text-xs ${jsonPasteError ? 'text-danger' : 'text-muted'}`}>
                  {jsonPasteError || '支持：完整 mcpServers 对象 / 单条服务器对象 / 直接 command 或 url 配置'}
                </span>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="tertiary" onPress={closeServerPanel}>取消</Button>
                <Button variant="primary" isDisabled={!jsonPasteText.trim()} onPress={applyJsonPaste}>解析并填入</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <TextField value={serverForm.name} onChange={(v) => setServerForm(f => ({ ...f, name: v }))}
                  isDisabled={!!editingServer} className="w-full">
                  <Label>服务器名称</Label>
                  <Input placeholder="my-mcp-server" />
                </TextField>

                <Select className="w-full" value={serverForm.type}
                  onChange={(v) => setServerForm(f => ({ ...f, type: String(v) }))}>
                  <Label>传输类型</Label>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="stdio" textValue="Stdio">Stdio<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="sse" textValue="SSE">SSE<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="http" textValue="Streamable HTTP">Streamable HTTP<ListBox.ItemIndicator /></ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>

                <TextField value={serverForm.timeoutMs} onChange={(v) => setServerForm(f => ({ ...f, timeoutMs: v }))} className="w-full">
                  <Label>超时时间 (ms)</Label>
                  <Input type="number" placeholder="30000" />
                </TextField>
              </div>

              {serverForm.type === 'stdio' ? (
                <div className="flex flex-col gap-3">
                  <TextField value={serverForm.command} onChange={(v) => setServerForm(f => ({ ...f, command: v }))} className="w-full">
                    <Label>命令</Label>
                    <Input placeholder="npx、node、python、uvx ..." />
                  </TextField>
                  <TextField value={serverForm.args} onChange={(v) => setServerForm(f => ({ ...f, args: v }))} className="w-full">
                    <Label>参数</Label>
                    <Input placeholder="-y @modelcontextprotocol/server-filesystem D:/Workspace" />
                  </TextField>
                  <TextField value={serverForm.cwd} onChange={(v) => setServerForm(f => ({ ...f, cwd: v }))} className="w-full">
                    <Label>工作目录 (可选)</Label>
                    <Input placeholder="D:/Workspace/project" />
                  </TextField>
                  <div className="flex flex-col gap-1 w-full">
                    <span className="text-xs text-foreground font-semibold">环境变量 (每行 KEY=VALUE)</span>
                    <TextArea value={serverForm.env}
                      onChange={(e) => setServerForm(f => ({ ...f, env: e.target.value }))}
                      placeholder={'API_KEY=...\nNODE_ENV=production'}
                      className="min-h-[80px] font-mono text-xs" />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <TextField value={serverForm.url} onChange={(v) => setServerForm(f => ({ ...f, url: v }))} className="w-full">
                    <Label>URL</Label>
                    <Input placeholder={serverForm.type === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'} />
                  </TextField>
                  <div className="flex flex-col gap-1 w-full">
                    <span className="text-xs text-foreground font-semibold">请求头 (每行 KEY=VALUE)</span>
                    <TextArea value={serverForm.headers}
                      onChange={(e) => setServerForm(f => ({ ...f, headers: e.target.value }))}
                      placeholder={'Authorization=Bearer ...\nX-Api-Key=...'}
                      className="min-h-[80px] font-mono text-xs" />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="tertiary" onPress={closeServerPanel}>取消</Button>
                <Button variant="primary" onPress={saveServer}>保存</Button>
              </div>
            </>
          )}
        </div>
      </Card.Content>
    </Card>
  )

  const renderToolsContent = (serverName: string) => {
    const tools = serverTools[serverName] || []
    const loadingTools = serverBusy[serverName] === 'tools'
    return (
      <div className="flex flex-col gap-3 mt-2 max-h-[68vh] overflow-auto">
        {loadingTools ? (
          <div className="flex gap-2 items-center py-2">
            <Spinner size="sm" />
            <span className="text-xs text-muted">正在读取工具列表...</span>
          </div>
        ) : tools.length === 0 ? (
          <span className="text-xs text-tertiary">暂无工具或服务器尚未返回工具列表。</span>
        ) : (
          tools.map(tool => (
            <div key={tool.name} className="p-3 rounded-xl border border-border bg-surface">
              <span className="text-sm font-semibold text-foreground">{tool.name}</span>
              {tool.description && (
                <p className="mt-1 text-xs text-muted leading-relaxed">{tool.description}</p>
              )}
              {tool.inputSchema !== undefined && tool.inputSchema !== null && (
                <pre className="mt-2 mb-0 p-2 rounded-lg overflow-auto bg-surface-tertiary text-xs text-muted font-mono">
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    )
  }

  return (
    <>
      <Toast.Provider placement="top" />
      <div className="h-full mx-[-0.75rem] mt-[-0.75rem] overflow-y-auto pb-3">
        <div className="max-w-5xl mx-auto px-4 md:px-8 py-3 md:py-4">
          <div className="flex flex-col gap-3">
            {/* ── Top Tabs ── */}
            <div className="flex gap-2 px-1 pt-1">
              <Button variant={topTab === 'server' ? 'primary' : 'tertiary'} size="sm"
                onPress={() => setTopTab('server')}>MCP 服务端</Button>
              <Button variant={topTab === 'integration' ? 'primary' : 'tertiary'} size="sm"
                onPress={() => setTopTab('integration')}>集成中心</Button>
            </div>

            {/* ════════ TAB 1: MCP 服务端 ════════ */}
            {topTab === 'server' && (<>
              <Card>
                <Card.Header>
                  <Card.Title>服务配置</Card.Title>
                  <Card.Description>CipherTalk 作为 MCP 服务端对外暴露工具</Card.Description>
                </Card.Header>
                <Card.Content>
                  <div className="flex flex-col gap-4">
                    <Card className="p-3 rounded-xl border border-border bg-surface">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <span className="text-sm font-semibold text-foreground">MCP 状态标记</span>
                          <p className="mt-1 text-xs text-muted">在 health_check / get_status 中暴露配置状态，不阻止宿主调用工具。</p>
                        </div>
                        <Switch isSelected={mcpEnabled} onChange={setMcpEnabled}
                          isDisabled={loading || saving}>
                          <Switch.Control><Switch.Thumb /></Switch.Control>
                        </Switch>
                      </div>
                    </Card>

                    <Card className="p-3 rounded-xl border border-border bg-surface">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <span className="text-sm font-semibold text-foreground">默认解析媒体本地路径</span>
                          <p className="mt-1 text-xs text-muted">控制 get_messages / search_messages 等工具是否返回图片、视频、语音、文件本地路径。</p>
                        </div>
                        <Switch isSelected={mcpExposeMediaPaths} onChange={setMcpExposeMediaPaths}
                          isDisabled={loading || saving}>
                          <Switch.Control><Switch.Thumb /></Switch.Control>
                        </Switch>
                      </div>
                    </Card>

                    <div>
                      <span className="text-sm font-semibold text-foreground">启动命令</span>
                      <div className="flex flex-col sm:flex-row gap-2 mt-1">
                        <Input value={mcpRunCommand} readOnly className="flex-1" />
                        <Button variant="tertiary" onPress={() => copyText(mcpRunCommand, '启动命令')}>
                          <Copy size={14} /> 复制
                        </Button>
                      </div>
                    </div>

                    <div>
                      <span className="text-sm font-semibold text-foreground">mcpServers 配置</span>
                      <TextArea value={mcpServerJsonTemplate} readOnly
                        className="w-full min-h-[200px] font-mono text-xs" />
                      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center mt-2">
                        <Button variant="tertiary" onPress={() => copyText(mcpServerJsonTemplate, 'mcpServers 配置')}>
                          <Copy size={14} /> 复制配置
                        </Button>
                        <span className="text-xs text-muted">
                          {launchConfig.mode === 'packaged'
                            ? 'Windows 下已自动通过 cmd /c 调用启动器，Claude Desktop、Cursor 等工具可直接使用。'
                            : 'cwd 已自动使用当前仓库目录。'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted">
                        {launchConfig.mode === 'packaged'
                          ? `当前为打包版启动器 ${getPackagedLauncherLabel(launchConfig.args.find(a => a.includes('ciphertalk-mcp')) ?? launchConfig.command)}`
                          : '当前为开发态入口 npm run mcp'}
                      </span>
                      <Button variant="primary" isIconOnly isPending={saving}
                        isDisabled={loading || saving} onPress={handleSave}>
                        <Save size={16} />
                      </Button>
                    </div>
                  </div>
                </Card.Content>
              </Card>

              <Card>
                <Card.Header>
                  <Card.Title>外部 Skills</Card.Title>
                  <Card.Description>导出给外部 Agent 使用（Codex、Claude、Cursor 等）</Card.Description>
                </Card.Header>
                <Card.Content>
                  <div className="flex flex-col gap-3">
                    {skills.filter(s => s.builtin).map(skill => (
                      <Card key={skill.name} className="p-3 rounded-xl border border-border bg-surface">
                        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex gap-2 items-center flex-wrap">
                              <FileCode size={18} className="text-accent shrink-0" />
                              <span className="text-sm font-semibold text-foreground truncate">{skill.name}</span>
                              <Chip variant="secondary" size="sm">v{skill.version}</Chip>
                              <Chip color="accent" variant="primary" size="sm">内置</Chip>
                            </div>
                            <p className="mt-1 text-xs text-muted truncate">{skill.description}</p>
                          </div>
                          <Button variant="tertiary" size="sm"
                            isDisabled={exportingSkillZip === skill.name}
                            onPress={() => exportSkillZip(skill.name)}>
                            <Download size={14} />
                            {exportingSkillZip === skill.name ? '导出中...' : '导出 zip'}
                          </Button>
                        </div>
                      </Card>
                    ))}
                    <span className="text-xs text-tertiary">导出 zip 后解压到对应 Agent 的 skills 目录即可使用。</span>
                  </div>
                </Card.Content>
              </Card>
            </>)}

            {/* ════════ TAB 2: 集成中心 ════════ */}
            {topTab === 'integration' && (<>
              <Card>
                <Card.Header className="flex items-center justify-between">
                  <div>
                    <Card.Title>MCP 客户端</Card.Title>
                    <Card.Description>连接外部 MCP 服务器并调用其工具</Card.Description>
                  </div>
                  <Button variant="tertiary" size="sm" onPress={openAddServer}>
                    {serverPanelOpen && !editingServer ? <><X size={14} /> 收起</> : <><Plus size={14} /> 添加服务器</>}
                  </Button>
                </Card.Header>
                <Card.Content>
                  <div className="flex flex-col gap-3">
                    {mcpServers.length === 0 && (
                      <div className="text-center py-6 text-sm text-tertiary">暂无 MCP 服务器配置，点击上方按钮添加</div>
                    )}
                    {serverPanelOpen && !editingServer && renderServerForm()}
                    {mcpServers.map(srv => (
                      <div key={srv.name} className="flex flex-col gap-2">
                        <Card className={`p-3 rounded-xl border border-border bg-surface ${(serverBusy[srv.name] && serverBusy[srv.name] !== 'tools') || srv.status === 'connecting' ? 'opacity-60' : ''}`}>
                          <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full">
                            <div className="min-w-0 flex-1">
                              <div className="flex gap-2 items-center flex-wrap">
                                <Plug size={16} className={srv.status === 'connected' ? 'text-accent shrink-0' : 'text-tertiary shrink-0'} />
                                <span className="text-sm font-semibold text-foreground truncate">{srv.name}</span>
                                <Chip variant="secondary" size="sm">{srv.config.type.toUpperCase()}</Chip>
                                {renderStatusChip(srv.status)}
                                {srv.config.timeoutMs && <span className="text-xs text-muted">{srv.config.timeoutMs}ms</span>}
                              </div>
                              <p className="mt-1 text-xs text-tertiary truncate">
                                {srv.config.type === 'stdio' ? `${srv.config.command} ${(srv.config.args || []).join(' ')}` : srv.config.url}
                              </p>
                              {srv.error && <p className="mt-1 text-xs text-danger">{srv.error}</p>}
                            </div>
                            <div className="flex gap-1 items-center flex-wrap">
                              {srv.status === 'connected' && (
                                <Button variant="tertiary" size="sm"
                                  isDisabled={Boolean(serverBusy[srv.name] && serverBusy[srv.name] !== 'tools')}
                                  onPress={() => openToolsDialog(srv.name)}>
                                  {serverBusy[srv.name] === 'tools' ? <Spinner size="sm" color="current" /> : null}
                                  {srv.toolCount} 工具
                                </Button>
                              )}
                              {srv.status === 'connected' ? (
                                <Button isIconOnly variant="tertiary" size="sm"
                                  isDisabled={Boolean(serverBusy[srv.name])}
                                  onPress={() => disconnectServer(srv.name)}>
                                  {serverBusy[srv.name] === 'disconnect' ? <Spinner size="sm" color="current" /> : <Unplug size={14} />}
                                </Button>
                              ) : (
                                <Button isIconOnly variant="tertiary" size="sm"
                                  isDisabled={Boolean(serverBusy[srv.name] || srv.status === 'connecting')}
                                  onPress={() => connectServer(srv.name)}>
                                  {serverBusy[srv.name] === 'connect' || srv.status === 'connecting' ? <Spinner size="sm" color="current" /> : <Plug size={14} />}
                                </Button>
                              )}
                              <Button isIconOnly variant="tertiary" size="sm"
                                isDisabled={Boolean(serverBusy[srv.name] || srv.status === 'connecting')}
                                onPress={() => openEditServer(srv)}>
                                <Pencil size={14} />
                              </Button>
                              <Button isIconOnly variant="tertiary" size="sm"
                                isDisabled={Boolean(serverBusy[srv.name] || srv.status === 'connecting')}
                                onPress={() => setDeleteTarget({ type: 'server', name: srv.name })}>
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          </div>
                        </Card>
                        {serverPanelOpen && editingServer === srv.name && renderServerForm()}
                      </div>
                    ))}
                  </div>
                </Card.Content>
              </Card>

              <Card>
                <Card.Header className="flex items-center justify-between">
                  <div>
                    <Card.Title>内部 Skills</Card.Title>
                    <Card.Description>管理和配置内部使用的 Skills</Card.Description>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="tertiary" size="sm" onPress={downloadSkillTemplate}>
                      <Download size={14} /> 下载模板
                    </Button>
                    <Button variant="tertiary" size="sm" onPress={importSkill}>
                      <Upload size={14} /> 导入
                    </Button>
                  </div>
                </Card.Header>
                <Card.Content>
                  <div className="flex flex-col gap-3">
                    {skills.length === 0 && (
                      <div className="text-center py-6 text-sm text-tertiary">暂无 Skills，可先下载模板后导入 zip</div>
                    )}
                    {skills.map(skill => (
                      <div key={skill.name} className="flex flex-col gap-2">
                        <Card className="p-3 rounded-xl border border-border bg-surface">
                          <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full">
                            <div className="min-w-0 flex-1">
                              <div className="flex gap-2 items-center flex-wrap">
                                <FileCode size={18} className="text-accent shrink-0" />
                                <span className="text-sm font-semibold text-foreground truncate">{skill.name}</span>
                                <Chip variant="secondary" size="sm">v{skill.version}</Chip>
                                {skill.builtin && <Chip color="accent" variant="primary" size="sm">内置</Chip>}
                              </div>
                              <p className="mt-1 text-xs text-muted truncate">{skill.description}</p>
                            </div>
                            <div className="flex gap-1 items-center flex-wrap">
                              <Button isIconOnly variant="tertiary" size="sm" onPress={() => openSkillPanel(skill.name, 'preview')}>
                                <Eye size={14} />
                              </Button>
                              {!skill.builtin && (
                                <>
                                  <Button isIconOnly variant="tertiary" size="sm" onPress={() => openSkillPanel(skill.name, 'edit')}>
                                    <Pencil size={14} />
                                  </Button>
                                  <Button isIconOnly variant="tertiary" size="sm" onPress={() => setDeleteTarget({ type: 'skill', name: skill.name })}>
                                    <Trash2 size={14} />
                                  </Button>
                                </>
                              )}
                              <Button variant="tertiary" size="sm"
                                isDisabled={exportingSkillZip === skill.name}
                                onPress={() => exportSkillZip(skill.name)}>
                                <Download size={14} />
                                {exportingSkillZip === skill.name ? '...' : '导出'}
                              </Button>
                            </div>
                          </div>
                        </Card>
                      </div>
                    ))}
                  </div>
                </Card.Content>
              </Card>
            </>)}
          </div>
        </div>
      </div>

      {/* ── Tools Modal ── */}
      <Modal isOpen={toolDialogServer !== null}
        onOpenChange={(open) => { if (!open) setToolDialogServer(null) }}>
        <Modal.Backdrop>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Icon className="bg-default text-foreground"><Plug className="size-5" /></Modal.Icon>
                <Modal.Heading>工具预览: {toolDialogServer}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>{toolDialogServer && renderToolsContent(toolDialogServer)}</Modal.Body>
              <Modal.Footer><Button slot="close" variant="tertiary">关闭</Button></Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {/* ── Skill Preview/Edit Modal ── */}
      <Modal isOpen={skillDialog !== null}
        onOpenChange={(open) => { if (!open) setSkillDialog(null) }}>
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Icon className="bg-default text-foreground"><FileCode className="size-5" /></Modal.Icon>
                <Modal.Heading>{skillDialog?.mode === 'edit' ? '编辑 Skill' : '预览 Skill'}: {skillDialog?.name}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                {skillDialog?.mode === 'edit' ? (
                  <TextArea value={editingSkillContent}
                    onChange={(e) => setEditingSkillContent(e.target.value)}
                    className="min-h-[400px] font-mono text-xs" />
                ) : (
                  <div className="markdown-body max-h-[68vh] overflow-auto p-4 rounded-xl border border-border bg-surface text-foreground"
                    dangerouslySetInnerHTML={renderMarkdown(skillContent)} />
                )}
              </Modal.Body>
              <Modal.Footer>
                {skillDialog?.mode === 'preview' && skills.find(s => s.name === skillDialog.name && !s.builtin) && (
                  <Button variant="tertiary" onPress={() => setSkillDialog({ name: skillDialog!.name, mode: 'edit' })}>
                    <Pencil size={14} /> 编辑
                  </Button>
                )}
                {skillDialog?.mode === 'edit' && (
                  <Button variant="tertiary" onPress={() => setSkillDialog({ name: skillDialog!.name, mode: 'preview' })}>取消</Button>
                )}
                {skillDialog?.mode === 'edit' && (
                  <Button variant="primary" onPress={saveEditSkill}>保存</Button>
                )}
                <Button slot="close" variant="tertiary">关闭</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {/* ── Delete Confirm Modal ── */}
      <Modal isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <Modal.Backdrop>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Icon className="bg-danger-soft text-danger-soft-foreground"><Trash2 className="size-5" /></Modal.Icon>
                <Modal.Heading>确认删除</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted">
                  确定要删除{deleteTarget?.type === 'skill' ? ' Skill' : ' MCP 服务器'} "{deleteTarget?.name}" 吗？此操作不可撤销。
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary">取消</Button>
                <Button variant="danger" onPress={() => {
                  if (deleteTarget?.type === 'skill') void deleteSkill(deleteTarget.name)
                  else void deleteServer(deleteTarget!.name)
                }}>删除</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  )
}

export default McpPage

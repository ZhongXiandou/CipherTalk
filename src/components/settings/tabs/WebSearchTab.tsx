/**
 * 联网搜索设置（Tavily）—— AI Agent 的 web_search 工具。
 * 启用并填 key 后，AI 助手在需要外部/实时信息时会自动联网搜索（聊天记录答不了的问题）。
 * 自带 IPC（webSearch:getConfig/setConfig/test）。
 */
import { useEffect, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, Switch, TextField } from '@heroui/react'
import { CircleCheck, CircleExclamation, PlugConnection } from '@gravity-ui/icons'
import type { WebSearchConfig } from '@/types/electron'

const DEFAULT_CFG: WebSearchConfig = {
  enabled: false,
  apiKey: '',
  maxResults: 5,
}

export default function WebSearchTab() {
  const [cfg, setCfg] = useState<WebSearchConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.electronAPI.webSearch.getConfig().then((res) => {
      if (res.success && res.config) setCfg({ ...DEFAULT_CFG, ...res.config })
      setLoaded(true)
    })
  }, [])

  const patch = (p: Partial<WebSearchConfig>) => setCfg((c) => ({ ...c, ...p }))

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.webSearch.test(cfg)
      setStatus(res.success
        ? { ok: true, text: `连接成功，返回 ${res.resultCount ?? 0} 条结果` }
        : { ok: false, text: res.error || '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.webSearch.setConfig(cfg)
      setStatus(res.success ? { ok: true, text: '已保存' } : { ok: false, text: res.error || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null

  return (
    <Card>
      <Card.Header className="flex-row items-start justify-between gap-3">
        <div>
          <Card.Title>联网搜索（Tavily）</Card.Title>
          <Card.Description>
            启用后，AI 助手遇到聊天记录之外的问题（新闻、公开数据、百科、行情等）会自动联网搜索并标注来源。
            需要 Tavily API Key（tavily.com 注册，有免费额度）。请求走系统代理。
          </Card.Description>
        </div>
        <Switch
          aria-label={cfg.enabled ? '关闭联网搜索' : '启用联网搜索'}
          isSelected={cfg.enabled}
          onChange={(v) => patch({ enabled: v })}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch>
      </Card.Header>
      <Card.Content className="space-y-5">
        <TextField fullWidth onChange={(v) => patch({ apiKey: v })} value={cfg.apiKey}>
          <Label>API Key</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="tvly-..." type="password" />
          </InputGroup>
          <Description>在 tavily.com 控制台获取，格式形如 tvly-xxxx。</Description>
        </TextField>

        <TextField
          fullWidth
          onChange={(v) => patch({ maxResults: Math.min(Math.max(Math.floor(Number(v) || 0), 1), 10) })}
          value={cfg.maxResults ? String(cfg.maxResults) : ''}
        >
          <Label>每次返回结果数</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="5" inputMode="numeric" />
          </InputGroup>
          <Description>每次搜索返回的网页条数（1–10），默认 5。</Description>
        </TextField>

        {status && (
          <p className={`flex items-center gap-1.5 text-sm ${status.ok ? 'text-green-600' : 'text-red-600'}`}>
            {status.ok ? <CircleCheck width={16} height={16} /> : <CircleExclamation width={16} height={16} />}
            {status.text}
          </p>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button isDisabled={testing || !cfg.apiKey} onPress={() => void handleTest()} type="button" variant="outline">
          <PlugConnection width={16} height={16} />
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button isDisabled={saving} onPress={() => void handleSave()} type="button" variant="primary">
          {saving ? '保存中…' : '保存'}
        </Button>
      </Card.Footer>
    </Card>
  )
}

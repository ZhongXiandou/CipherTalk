/**
 * 嵌入模型设置（语义/向量检索用，独立于聊天模型）。
 * 只保留必要项：接口 URL、API Key、模型、向量维度 + 启用开关 + 测试/保存。
 * 协议固定 openai-compatible（对 OpenAI 官方也通），不再做服务商下拉。
 * 自带 IPC（embedding:getConfig/setConfig/test）。
 */
import { useEffect, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, Switch, TextField } from '@heroui/react'
import { AlertCircle, CheckCircle, ExternalLink, Plug } from 'lucide-react'
import type { EmbeddingConfig } from '@/types/electron'

const SILICONFLOW_REFERRAL_URL = 'https://cloud.siliconflow.cn/i/lNl8YK1m'

const DEFAULT_CFG: EmbeddingConfig = {
  enabled: false,
  provider: '',
  protocol: 'openai-compatible',
  apiKey: '',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3',
  dimension: 0,
}

export default function EmbeddingTab() {
  const [cfg, setCfg] = useState<EmbeddingConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.electronAPI.embedding.getConfig().then((res) => {
      if (res.success && res.config) setCfg({ ...DEFAULT_CFG, ...res.config, protocol: 'openai-compatible' })
      setLoaded(true)
    })
  }, [])

  const patch = (p: Partial<EmbeddingConfig>) => setCfg((c) => ({ ...c, ...p }))

  const handleOpenSiliconFlowReferral = () => {
    void window.electronAPI.shell.openExternal(SILICONFLOW_REFERRAL_URL)
  }

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.embedding.test(cfg)
      if (res.success) {
        // 不自动回填维度：避免"测试没发 dimensions、实际发了"不一致。仅提示探测到的维度。
        setStatus({
          ok: true,
          text: cfg.dimension > 0
            ? `连接成功，按设定维度输出 ${res.dimension}`
            : `连接成功，模型默认维度 ${res.dimension}（如需固定维度，在上方"向量维度"填写）`,
        })
      } else {
        setStatus({ ok: false, text: res.error || '测试失败' })
      }
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.embedding.setConfig(cfg)
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
          <Card.Title>语义检索（嵌入模型）</Card.Title>
          <Card.Description>
            供 AI 助手做语义/向量检索，独立于聊天模型。需 OpenAI 兼容的嵌入接口（如硅基流动 bge-m3、通义、智谱、OpenAI）。
          </Card.Description>
          <Button className="mt-3" onPress={handleOpenSiliconFlowReferral} size="sm" type="button" variant="outline">
            <ExternalLink size={14} />
            推荐：硅基流动
          </Button>
        </div>
        <Switch
          aria-label={cfg.enabled ? '关闭语义检索嵌入模型' : '启用语义检索嵌入模型'}
          isSelected={cfg.enabled}
          onChange={(v) => patch({ enabled: v })}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch>
      </Card.Header>
      <Card.Content className="space-y-5">
        <TextField fullWidth onChange={(v) => patch({ baseURL: v })} value={cfg.baseURL}>
          <Label>接口 URL（baseURL）</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="https://api.siliconflow.cn/v1" />
          </InputGroup>
          <Description>填 /v1 基地址即可，会自动拼 /embeddings。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ apiKey: v })} value={cfg.apiKey}>
          <Label>API Key</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="请输入嵌入服务 API Key" type="password" />
          </InputGroup>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ model: v })} value={cfg.model}>
          <Label>嵌入模型</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="BAAI/bge-m3" />
          </InputGroup>
          <Description>嵌入型号需手填（不在聊天模型列表里）。</Description>
        </TextField>

        <TextField
          fullWidth
          onChange={(v) => patch({ dimension: Math.max(0, Math.floor(Number(v) || 0)) })}
          value={cfg.dimension ? String(cfg.dimension) : ''}
        >
          <Label>向量维度</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="留空 = 自动（用模型默认维度）" inputMode="numeric" />
          </InputGroup>
          <Description>
            留空/0 = 自动；填具体值则要求接口按该维度输出（需模型支持，如 text-embedding-3 / Qwen3-embedding；bge-m3 等固定维度的填默认值或留空）。
          </Description>
        </TextField>

        {status && (
          <p className={`flex items-center gap-1.5 text-sm ${status.ok ? 'text-green-600' : 'text-red-600'}`}>
            {status.ok ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
            {status.text}
          </p>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button isDisabled={testing || !cfg.apiKey || !cfg.model} onPress={() => void handleTest()} type="button" variant="outline">
          <Plug size={16} />
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button isDisabled={saving} onPress={() => void handleSave()} type="button" variant="primary">
          {saving ? '保存中…' : '保存'}
        </Button>
      </Card.Footer>
    </Card>
  )
}

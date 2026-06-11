/**
 * 文字转语音设置 —— 朗读 AI 回复、微信消息、克隆好友语音回复共用。
 * 走 OpenAI 兼容 /audio/speech 接口（硅基流动 CosyVoice、OpenAI tts 等）。
 * 自带 IPC（tts:getConfig/setConfig/test），未配置时各处朗读回退系统语音。
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, ListBox, Select, Switch, TextArea, TextField } from '@heroui/react'
import { AlertCircle, CheckCircle, Volume2 } from 'lucide-react'
import type { TtsConfig } from '@/types/electron'

const DEFAULT_CFG: TtsConfig = {
  enabled: false,
  protocol: 'openai-speech',
  apiKey: '',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/CosyVoice2-0.5B',
  voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',
  instructions: '',
  speed: 1,
}

const PROTOCOL_OPTIONS: Array<{ value: TtsConfig['protocol']; label: string; hint: string }> = [
  { value: 'openai-speech', label: '语音接口（/audio/speech）', hint: '标准 TTS 端点：硅基流动 CosyVoice、OpenAI tts-1/gpt-4o-mini-tts 等' },
  { value: 'openai-chat', label: '聊天接口出音频（/chat/completions）', hint: 'gpt-4o-audio 风格：把文本发给聊天接口、从回复里取音频，小米等平台用这种' },
  { value: 'custom', label: '自定义完整 URL', hint: '直接请求你填写的完整接口地址，不自动拼接路径，按 OpenAI speech 兼容 JSON 发送' },
]

const DEFAULT_TTS_ENDPOINTS = new Set([
  DEFAULT_CFG.baseURL,
  'https://api.openai.com/v1',
])

export default function TtsTab() {
  const [cfg, setCfg] = useState<TtsConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    void window.electronAPI.tts.getConfig().then((res) => {
      if (res.success && res.config) setCfg({ ...DEFAULT_CFG, ...res.config })
      setLoaded(true)
    })
    return () => { previewAudioRef.current?.pause() }
  }, [])

  const patch = (p: Partial<TtsConfig>) => setCfg((c) => ({ ...c, ...p }))

  const handleProtocolChange = (protocol: TtsConfig['protocol']) => {
    setCfg((current) => ({
      ...current,
      protocol,
      baseURL: protocol === 'custom' && DEFAULT_TTS_ENDPOINTS.has(current.baseURL.trim()) ? '' : current.baseURL,
    }))
  }

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.tts.test(cfg)
      if (res.success && res.audioBase64) {
        previewAudioRef.current?.pause()
        const audio = new Audio(`data:${res.mimeType || 'audio/mpeg'};base64,${res.audioBase64}`)
        previewAudioRef.current = audio
        void audio.play()
        setStatus({ ok: true, text: '合成成功，正在播放试听' })
      } else {
        setStatus({ ok: false, text: res.error || '试听失败' })
      }
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.tts.setConfig(cfg)
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
          <Card.Title>文字转语音（TTS）</Card.Title>
          <Card.Description>
            启用后，AI 助手回复、微信消息右键「朗读」和克隆好友的语音回复都会用这里的音色合成语音；
            未启用时回退系统朗读。支持 OpenAI 兼容 /audio/speech 接口（硅基流动 CosyVoice、OpenAI tts 等）。
          </Card.Description>
        </div>
        <Switch
          aria-label={cfg.enabled ? '关闭文字转语音' : '启用文字转语音'}
          isSelected={cfg.enabled}
          onChange={(v) => patch({ enabled: v })}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch>
      </Card.Header>
      <Card.Content className="space-y-5">
        <Select
          selectedKey={cfg.protocol || 'openai-speech'}
          onSelectionChange={(key) => {
            if (key != null) handleProtocolChange(String(key) as TtsConfig['protocol'])
          }}
          placeholder="选择接口形态"
          variant="secondary"
          fullWidth
        >
          <Label>接口形态</Label>
          <Select.Trigger>
            <Select.Value>
              {({ defaultChildren }) => PROTOCOL_OPTIONS.find((o) => o.value === (cfg.protocol || 'openai-speech'))?.label || defaultChildren}
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {PROTOCOL_OPTIONS.map((option) => (
                <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{PROTOCOL_OPTIONS.find((o) => o.value === (cfg.protocol || 'openai-speech'))?.hint}</Description>
        </Select>

        <TextField fullWidth onChange={(v) => patch({ apiKey: v })} value={cfg.apiKey}>
          <Label>API Key</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="sk-..." type="password" />
          </InputGroup>
          <Description>服务商控制台获取，仅保存在本地。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ baseURL: v })} value={cfg.baseURL}>
          <Label>接口地址</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder={cfg.protocol === 'custom' ? 'https://your-api.example.com/v1/audio/speech' : 'https://api.siliconflow.cn/v1'} />
          </InputGroup>
          <Description>
            {cfg.protocol === 'custom'
              ? '填写完整接口地址，系统会原样 POST，不拼接 /audio/speech 或 /chat/completions。'
              : cfg.protocol === 'openai-chat'
                ? '填写 OpenAI 兼容 /v1 地址，会自动拼接 /chat/completions。'
                : '填写 OpenAI 兼容 /v1 地址，会自动拼接 /audio/speech。'}
          </Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ model: v })} value={cfg.model}>
          <Label>模型</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="FunAudioLLM/CosyVoice2-0.5B" />
          </InputGroup>
          <Description>如硅基流动 FunAudioLLM/CosyVoice2-0.5B、OpenAI gpt-4o-mini-tts。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ voice: v })} value={cfg.voice}>
          <Label>音色</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="FunAudioLLM/CosyVoice2-0.5B:anna" />
          </InputGroup>
          <Description>硅基流动格式为 模型:音色名（alex/anna/bella…）；OpenAI 为 alloy/nova 等。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ instructions: v })} value={cfg.instructions || ''}>
          <Label>语气/风格指令</Label>
          <TextArea
            maxLength={1000}
            placeholder="温柔、轻声、像微信语音一样自然，带一点笑意"
            rows={3}
            variant="secondary"
          />
          <Description>支持该能力的语音模型会按这里的自然语言控制朗读；克隆好友语音会优先使用画像自动生成的指令。</Description>
        </TextField>

        <TextField
          fullWidth
          onChange={(v) => {
            const value = Number(v)
            patch({ speed: Number.isFinite(value) && value > 0 ? Math.min(Math.max(value, 0.25), 4) : 1 })
          }}
          value={cfg.speed ? String(cfg.speed) : ''}
        >
          <Label>语速</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="1" inputMode="decimal" />
          </InputGroup>
          <Description>1 = 正常语速，范围 0.25–4。</Description>
        </TextField>

        {status && (
          <p className={`flex items-start gap-1.5 text-sm break-all ${status.ok ? 'text-green-600' : 'text-red-600'}`}>
            {status.ok ? <CheckCircle className="mt-0.5 shrink-0" size={16} /> : <AlertCircle className="mt-0.5 shrink-0" size={16} />}
            <span>{status.text}</span>
          </p>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button isDisabled={testing || !cfg.apiKey || !cfg.model} onPress={() => void handleTest()} type="button" variant="outline">
          <Volume2 size={16} />
          {testing ? '合成中…' : '试听'}
        </Button>
        <Button isDisabled={saving} onPress={() => void handleSave()} type="button" variant="primary">
          {saving ? '保存中…' : '保存'}
        </Button>
      </Card.Footer>
    </Card>
  )
}

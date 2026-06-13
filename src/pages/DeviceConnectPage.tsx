import { useEffect, useState, type ReactElement } from 'react'
import { Button, Chip, Modal, Spinner, toast } from '@heroui/react'
import { MessageCircle, MessagesSquare, Send } from 'lucide-react'

type ComingSoonPlatform = {
  key: string
  name: string
  icon: ReactElement
  gradient: string
}

const ICON_SIZE = 28

const COMING_SOON: ComingSoonPlatform[] = [
  {
    key: 'feishu',
    name: '飞书',
    icon: <MessagesSquare size={ICON_SIZE} />,
    gradient: 'linear-gradient(135deg, #3370FF 0%, #00D6B9 100%)',
  },
  {
    key: 'telegram',
    name: 'Telegram',
    icon: <Send size={ICON_SIZE} />,
    gradient: 'linear-gradient(135deg, #2AABEE 0%, #229ED9 100%)',
  },
]

type WechatStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

const STATUS_TEXT: Record<WechatStatus, string> = {
  disconnected: '未连接',
  connecting: '等待扫码',
  connected: '已连接',
  error: '连接异常',
}

function cardClass() {
  return 'flex flex-col gap-4 rounded-2xl border border-(--border-color) bg-surface-secondary p-5 backdrop-blur-[18px] transition-shadow hover:shadow-lg'
}

function WechatCard() {
  const [status, setStatus] = useState<WechatStatus>('disconnected')
  const [error, setError] = useState<string | null>(null)
  const [qrcodeImage, setQrcodeImage] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const api = window.electronAPI.deviceConnect.wechat
    api.getStatus().then((s) => { setStatus(s.status); setError(s.error) }).catch(() => undefined)

    const offStatus = api.onStatus((s) => {
      setStatus(s.status)
      setError(s.error)
      if (s.status === 'connected') {
        setModalOpen(false)
        setQrcodeImage(null)
        setScanned(false)
      }
    })
    const offQrcode = api.onQrcode((p) => { setQrcodeImage(p.qrcodeImage); setScanned(false) })
    const offScan = api.onScanState((p) => {
      if (p.state === 'scaned') setScanned(true)
      else if (p.state === 'failed') { setScanned(false); if (p.error) toast.danger(p.error) }
    })
    return () => { offStatus(); offQrcode(); offScan() }
  }, [])

  const handleConnect = async () => {
    setBusy(true)
    setScanned(false)
    setQrcodeImage(null)
    setModalOpen(true)
    try {
      const res = await window.electronAPI.deviceConnect.wechat.connect()
      if (!res.success) {
        toast.danger(res.error || '获取二维码失败')
        setModalOpen(false)
      } else if (res.qrcodeImage) {
        setQrcodeImage(res.qrcodeImage)
      }
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : '连接失败')
      setModalOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async () => {
    setModalOpen(false)
    await window.electronAPI.deviceConnect.wechat.cancel().catch(() => undefined)
  }

  const handleDisconnect = async () => {
    setBusy(true)
    try {
      await window.electronAPI.deviceConnect.wechat.disconnect()
      toast.success('已断开微信连接')
    } finally {
      setBusy(false)
    }
  }

  const statusColor = status === 'connected' ? 'success' : status === 'error' ? 'danger' : undefined

  return (
    <>
      <div className={cardClass()}>
        <div className="flex items-center gap-3">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-xl text-white"
            style={{ background: 'linear-gradient(135deg, #1AAD5A 0%, #07C160 100%)' }}
          >
            <MessageCircle size={ICON_SIZE} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold text-foreground">微信</span>
              <Chip size="sm" variant="soft" color={statusColor}>{STATUS_TEXT[status]}</Chip>
            </div>
            <p className="mt-1 truncate text-sm text-muted">
              {status === 'connected' ? '消息会自动交给 AI 助手处理并回复' : '扫码连接，让 AI 助手直接在微信收发消息'}
            </p>
          </div>
        </div>

        {error && status === 'error' && <p className="text-xs text-danger">{error}</p>}

        {status === 'connected' ? (
          <Button variant="tertiary" fullWidth isDisabled={busy} onPress={handleDisconnect}>断开连接</Button>
        ) : (
          <Button variant="primary" fullWidth isDisabled={busy} onPress={handleConnect}>连接微信</Button>
        )}
      </div>

      {modalOpen && (
        <Modal isOpen onOpenChange={(open) => { if (!open) void handleCancel() }}>
          <Modal.Backdrop>
            <Modal.Container size="sm">
              <Modal.Dialog>
                <Modal.CloseTrigger />
                <Modal.Header>
                  <Modal.Heading>微信扫码连接</Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <div className="flex flex-col items-center gap-4 py-2">
                    <div className="flex size-70 items-center justify-center rounded-xl bg-white">
                      {qrcodeImage ? (
                        <img src={qrcodeImage} alt="微信连接二维码" className="size-70" />
                      ) : (
                        <Spinner />
                      )}
                    </div>
                    <p className="text-sm text-muted">
                      {scanned ? '已扫码，请在手机微信上点击确认' : '请用手机微信扫描二维码以连接'}
                    </p>
                  </div>
                </Modal.Body>
                <Modal.Footer>
                  <Button slot="close" variant="tertiary">取消</Button>
                </Modal.Footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}
    </>
  )
}

function ComingSoonCard({ platform }: { platform: ComingSoonPlatform }) {
  return (
    <div className={cardClass()}>
      <div className="flex items-center gap-3">
        <div
          className="flex size-12 shrink-0 items-center justify-center rounded-xl text-white opacity-70"
          style={{ background: platform.gradient }}
        >
          {platform.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold text-foreground">{platform.name}</span>
            <Chip size="sm" variant="soft">敬请期待</Chip>
          </div>
          <p className="mt-1 truncate text-sm text-muted">敬请期待</p>
        </div>
      </div>
      <Button variant="ghost" fullWidth isDisabled>敬请期待</Button>
    </div>
  )
}

function DeviceConnectPage() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">设备连接</h1>
        <p className="mt-1 text-sm text-muted">把 AI 助手接入聊天平台，直接在对话里收发消息</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <WechatCard />
        {COMING_SOON.map((platform) => (
          <ComingSoonCard key={platform.key} platform={platform} />
        ))}
      </div>
    </div>
  )
}

export default DeviceConnectPage

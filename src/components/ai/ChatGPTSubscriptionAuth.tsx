import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Chip, Spinner } from '@heroui/react'
import { ArrowUpRight, ArrowsRotateLeft, CircleCheck } from '@gravity-ui/icons'
import type { CodexSubscriptionStatus } from '@/types/electron'

type ChatGPTSubscriptionAuthProps = {
  compact?: boolean
  onAuthenticationChange?: (authenticated: boolean) => void
}

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro',
  team: 'Team',
  business: 'Business',
  self_serve_business_usage_based: 'Business',
  enterprise: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  edu: 'Edu',
  unknown: '未知套餐',
}

export default function ChatGPTSubscriptionAuth({ compact = false, onAuthenticationChange }: ChatGPTSubscriptionAuthProps) {
  const [status, setStatus] = useState<CodexSubscriptionStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const onAuthenticationChangeRef = useRef(onAuthenticationChange)
  onAuthenticationChangeRef.current = onAuthenticationChange

  const refresh = async () => {
    const next = await window.electronAPI.codexSubscription.getStatus()
    setStatus(next)
    if (next.authenticated) {
      setPending(false)
      setError('')
    }
    onAuthenticationChangeRef.current?.(next.authenticated)
    return next
  }

  useEffect(() => {
    let active = true
    void window.electronAPI.codexSubscription.getStatus().then((next) => {
      if (!active) return
      setStatus(next)
      onAuthenticationChangeRef.current?.(next.authenticated)
    })
    const off = window.electronAPI.codexSubscription.onStatusChanged((next) => {
      if (!active) return
      setStatus(next)
      if (next.authenticated) {
        setPending(false)
        setError('')
      }
      onAuthenticationChangeRef.current?.(next.authenticated)
    })
    return () => {
      active = false
      off()
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => window.clearInterval(timer)
  }, [pending])

  const login = async () => {
    setPending(true)
    setError('')
    const result = await window.electronAPI.codexSubscription.login()
    if (!result.success) {
      setPending(false)
      setError(result.error || 'ChatGPT 登录启动失败')
    }
  }

  const logout = async () => {
    setPending(true)
    setError('')
    const result = await window.electronAPI.codexSubscription.logout()
    setPending(false)
    if (!result.success) setError(result.error || '退出登录失败')
    else await refresh()
  }

  if (!status) {
    return <div className="flex min-h-16 items-center gap-2 text-muted-foreground text-sm"><Spinner size="sm" />正在读取 ChatGPT 登录状态...</div>
  }

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4 rounded-md border border-border p-4'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">ChatGPT 账号</span>
            {status.authenticated && (
              <Chip size="sm" variant="soft" color="success">
                <CircleCheck className="size-3.5" />
                <Chip.Label>{PLAN_LABELS[status.planType || 'unknown'] || status.planType}</Chip.Label>
              </Chip>
            )}
          </div>
          <div className="mt-1 truncate text-muted-foreground text-sm">
            {status.authenticated ? (status.email || '已登录') : '未登录'}
          </div>
        </div>
        {status.authenticated ? (
          <Button type="button" variant="outline" size="sm" onPress={() => void logout()} isDisabled={pending}>
            {pending ? <Spinner size="sm" /> : <ArrowsRotateLeft width={16} height={16} />}
            退出登录
          </Button>
        ) : (
          <Button type="button" variant="primary" size="sm" onPress={() => void login()} isDisabled={pending || !status.available}>
            {pending ? <Spinner size="sm" /> : <ArrowUpRight width={16} height={16} />}
            {pending ? '等待授权...' : '登录 ChatGPT'}
          </Button>
        )}
      </div>
      {(error || status.error) && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Title>ChatGPT 连接失败</Alert.Title>
            <Alert.Description>{error || status.error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </div>
  )
}

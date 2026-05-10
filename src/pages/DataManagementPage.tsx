/**
 * DataManagementPage
 *
 * Direct-DB 迁移后：本页由"解密/缓存管理页"改造为"数据通道诊断页"。
 * - 展示 dbPath / wxid / db_storage 目录扫描结果
 * - 展示当前连接状态（基于 wcdb.testConnection）
 * - 订阅 wcdb.onChange，以滚动日志形式展示最近监控事件
 * - 提供"重连"按钮，调用 wcdb.close + wcdb.open
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Database, RefreshCw, Plug, PlugZap, Activity } from 'lucide-react'
import * as configService from '../services/config'
import './DataManagementPage.scss'

type ConnStatus = 'idle' | 'checking' | 'connected' | 'error'
interface DbInfo { fileName: string; filePath: string; fileSize: number; wxid: string }
interface MonitorLog { id: number; at: string; table: string; dbPath: string }

const MAX_LOGS = 50
const STATUS_LABEL: Record<ConnStatus, string> = {
  idle: '未连接', checking: '检测中...', connected: '已连接', error: '连接异常'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DataManagementPage() {
  const [dbPath, setDbPath] = useState('')
  const [wxid, setWxid] = useState('')
  const [databases, setDatabases] = useState<DbInfo[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [connStatus, setConnStatus] = useState<ConnStatus>('idle')
  const [connError, setConnError] = useState<string>('')
  const [sessionCount, setSessionCount] = useState<number | null>(null)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [logs, setLogs] = useState<MonitorLog[]>([])
  const logIdRef = useRef(0)

  const showMessage = useCallback((text: string, success: boolean) => {
    setMessage({ text, success })
    setTimeout(() => setMessage(null), 2500)
  }, [])

  const loadAccountAndDbs = useCallback(async () => {
    setIsScanning(true)
    try {
      const active = await configService.getActiveAccount()
      setDbPath(active?.dbPath || '')
      setWxid(active?.wxid || '')
    } catch { /* ignore */ }
    try {
      const r = await window.electronAPI.dataManagement.scanDatabases()
      if (r.success && r.databases) {
        setDatabases(r.databases.map((db) => ({
          fileName: db.fileName, filePath: db.filePath, fileSize: db.fileSize, wxid: db.wxid
        })))
      }
    } catch (e) {
      console.warn('[DataManagement] scanDatabases 失败:', e)
    } finally {
      setIsScanning(false)
    }
  }, [])

  const checkConnection = useCallback(async () => {
    const active = await configService.getActiveAccount()
    if (!active?.dbPath || !active?.wxid || !active?.decryptKey) {
      setConnStatus('idle')
      setConnError('未找到已激活账号（dbPath / wxid / key 缺失）')
      return
    }
    setConnStatus('checking'); setConnError('')
    try {
      const r = await window.electronAPI.wcdb.testConnection(active.dbPath, active.decryptKey, active.wxid, true)
      if (r.success) {
        setConnStatus('connected')
        setSessionCount(r.sessionCount ?? null)
      } else {
        setConnStatus('error'); setConnError(r.error || '连接失败')
      }
    } catch (e) {
      setConnStatus('error'); setConnError(String(e))
    }
  }, [])

  useEffect(() => {
    void loadAccountAndDbs()
    void checkConnection()
  }, [loadAccountAndDbs, checkConnection])

  useEffect(() => {
    const onChange = window.electronAPI.wcdb.onChange
    if (typeof onChange !== 'function') return
    const remove = onChange((payload) => {
      const id = ++logIdRef.current
      setLogs((prev) => [{
        id, at: new Date().toLocaleTimeString(),
        table: payload?.table || 'Unknown', dbPath: payload?.dbPath || ''
      }, ...prev].slice(0, MAX_LOGS))
    })
    return () => { remove?.() }
  }, [])

  const handleReconnect = useCallback(async () => {
    const active = await configService.getActiveAccount()
    if (!active?.dbPath || !active?.wxid || !active?.decryptKey) {
      showMessage('未找到已激活账号，无法重连', false); return
    }
    setIsReconnecting(true); setConnStatus('checking'); setConnError('')
    try {
      try { await window.electronAPI.wcdb.close() } catch { /* ignore */ }
      const ok = await window.electronAPI.wcdb.open(active.dbPath, active.decryptKey, active.wxid)
      if (ok) {
        showMessage('已重新建立直连', true)
        await checkConnection()
      } else {
        setConnStatus('error'); setConnError('重连失败'); showMessage('重连失败', false)
      }
    } catch (e) {
      setConnStatus('error'); setConnError(String(e)); showMessage(`重连失败: ${e}`, false)
    } finally {
      setIsReconnecting(false)
    }
  }, [checkConnection, showMessage])

  const dbStoragePath = useMemo(() => {
    if (databases.length === 0) return ''
    const first = databases[0].filePath
    const idx = first.toLowerCase().lastIndexOf('db_storage')
    return idx >= 0 ? first.slice(0, idx + 'db_storage'.length) : ''
  }, [databases])

  return (
    <>
      {message && (
        <div className={`message-toast ${message.success ? 'success' : 'error'}`}>{message.text}</div>
      )}

      <div className="page-header"><h1>数据通道诊断</h1></div>

      <div className="page-scroll">
        <section className="page-section">
          <div className="section-header">
            <div>
              <h2>直连状态</h2>
              <p className="section-desc">当前 Direct-DB 通道连接信息</p>
            </div>
            <div className="section-actions">
              <button className="btn btn-secondary" onClick={() => void checkConnection()} disabled={connStatus === 'checking'}>
                <RefreshCw size={16} className={connStatus === 'checking' ? 'spin' : ''} />
                重新检测
              </button>
              <button className="btn btn-primary" onClick={() => void handleReconnect()} disabled={isReconnecting}>
                <PlugZap size={16} />
                {isReconnecting ? '重连中...' : '重连'}
              </button>
            </div>
          </div>

          <div className="database-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div><strong>dbPath：</strong><span style={{ marginLeft: 8 }}>{dbPath || '（未设置）'}</span></div>
            <div><strong>wxid：</strong><span style={{ marginLeft: 8 }}>{wxid || '（未设置）'}</span></div>
            <div><strong>db_storage：</strong><span style={{ marginLeft: 8 }}>{dbStoragePath || '（未扫描到）'}</span></div>
            <div>
              <strong>状态：</strong>
              <span style={{ marginLeft: 8 }}>
                <Plug size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                {STATUS_LABEL[connStatus]}
                {sessionCount !== null && connStatus === 'connected' && `（会话数：${sessionCount}）`}
              </span>
            </div>
            {connError && (
              <div style={{ color: '#ff6b6b' }}><strong>错误：</strong><span style={{ marginLeft: 8 }}>{connError}</span></div>
            )}
          </div>
        </section>

        <section className="page-section">
          <div className="section-header">
            <div>
              <h2>数据库文件</h2>
              <p className="section-desc">
                {isScanning ? '扫描中...' : `扫描到 ${databases.length} 个数据库文件（仅展示元信息，不再解密落地）`}
              </p>
            </div>
            <div className="section-actions">
              <button className="btn btn-secondary" onClick={() => void loadAccountAndDbs()} disabled={isScanning}>
                <RefreshCw size={16} className={isScanning ? 'spin' : ''} />
                刷新
              </button>
            </div>
          </div>
          <div className="database-list">
            {databases.map((db) => (
              <div key={db.filePath} className="database-item">
                <div className="status-icon decrypted"><Database size={16} /></div>
                <div className="db-info">
                  <div className="db-name">{db.fileName}</div>
                  <div className="db-meta">
                    <span>{db.wxid}</span><span>•</span><span>{formatFileSize(db.fileSize)}</span>
                  </div>
                </div>
              </div>
            ))}
            {!isScanning && databases.length === 0 && (
              <div className="empty-state">
                <Database size={48} strokeWidth={1} />
                <p>未找到数据库文件</p>
                <p className="hint">请确认已完成初始引导</p>
              </div>
            )}
          </div>
        </section>

        <section className="page-section">
          <div className="section-header">
            <div>
              <h2>监控事件日志</h2>
              <p className="section-desc">实时订阅 wcdb.onChange（最近 {MAX_LOGS} 条）</p>
            </div>
            <div className="section-actions">
              <button className="btn btn-secondary" onClick={() => setLogs([])} disabled={logs.length === 0}>清空</button>
            </div>
          </div>
          <div className="database-list">
            {logs.length === 0 && (
              <div className="empty-state">
                <Activity size={48} strokeWidth={1} />
                <p>暂无监控事件</p>
                <p className="hint">数据库发生变化时会在此滚动展示</p>
              </div>
            )}
            {logs.map((log) => (
              <div key={log.id} className="database-item">
                <div className="status-icon decrypted"><Activity size={16} /></div>
                <div className="db-info">
                  <div className="db-name">[{log.at}] {log.table}</div>
                  <div className="db-meta"><span>{log.dbPath}</span></div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  )
}

export default DataManagementPage

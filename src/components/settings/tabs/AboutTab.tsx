import { Download, RefreshCw, Github } from 'lucide-react'
import type { UpdateDownloadProgressPayload } from '../../../types/electron'
import type { UpdateInfo } from '../types'
import { formatFileSize, formatSpeed } from '../utils'
import { ProgressBar } from '../ui'

interface AboutTabProps {
  appVersion: string
  updateInfo: UpdateInfo | null
  isDownloading: boolean
  downloadProgress: number
  downloadProgressDetail: UpdateDownloadProgressPayload | null
  isCheckingUpdate: boolean
  onUpdateNow: () => void
  onCheckUpdate: () => void
}

function AboutTab({
  appVersion,
  updateInfo,
  isDownloading,
  downloadProgress,
  downloadProgressDetail,
  isCheckingUpdate,
  onUpdateNow,
  onCheckUpdate
}: AboutTabProps) {
  return (
    <div className="tab-content about-tab">
      <div className="about-card">
        <div className="about-logo">
          <img src="./About.png" alt="密语 CipherTalk" />
        </div>
        <p className="about-version">v{appVersion || '...'}</p>

        <div className="about-update">
          {updateInfo?.hasUpdate ? (
            <>
              <p className="update-hint">
                {isDownloading ? `正在下载 v${updateInfo.version}` : updateInfo.forceUpdate ? '检测到强制更新' : `新版本 v${updateInfo.version} 可用`}
              </p>
              {isDownloading ? (
                <ProgressBar
                  value={downloadProgress}
                  label={`${downloadProgress.toFixed(0)}%`}
                  meta={(
                    <>
                      <span>
                        {formatFileSize(downloadProgressDetail?.transferred ?? updateInfo.diagnostics?.downloadedBytes ?? 0)} / {formatFileSize(downloadProgressDetail?.total ?? updateInfo.diagnostics?.totalBytes ?? 0)}
                      </span>
                      <span>速度 {formatSpeed(downloadProgressDetail?.bytesPerSecond ?? 0)}</span>
                    </>
                  )}
                />
              ) : (
                <button className="btn btn-primary" onClick={onUpdateNow} disabled={isDownloading}>
                  <Download size={16} /> 立即更新
                </button>
              )}
            </>
          ) : (
            <button className="btn btn-secondary" onClick={onCheckUpdate} disabled={isCheckingUpdate || isDownloading}>
              <RefreshCw size={16} className={isCheckingUpdate ? 'spin' : ''} />
              {isCheckingUpdate ? '检查中...' : '检查更新'}
            </button>
          )}
        </div>
      </div>

      <div className="about-footer">
        <div className="github-capsules">
          <button
            className="btn btn-secondary github-link-btn"
            onClick={() => window.electronAPI.shell.openExternal('https://github.com/ILoveBingLu/miyu')}
          >
            <Github size={16} />
            <span>密语 CipherTalk</span>
          </button>
          <button
            className="btn btn-secondary github-link-btn"
            onClick={() => window.electronAPI.shell.openExternal('https://github.com/hicccc77/WeFlow')}
          >
            <Github size={16} />
            <span>WeFlow</span>
          </button>
        </div>

        <p className="about-warning">
          软件为免费，如果有人找你收钱，请骂死他，太贱了，拿别人东西卖钱！
        </p>

        <div className="about-links">
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.shell.openExternal('https://miyu.aiqji.com') }}>官网</a>
          <span>·</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.shell.openExternal('https://chatlab.fun') }}>ChatLab</a>
          <span>·</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.window.openAgreementWindow() }}>用户协议</a>
        </div>
        <p className="copyright">© {new Date().getFullYear()} 密语-CipherTalk. All rights reserved.</p>
      </div>
    </div>
  )
}

export default AboutTab

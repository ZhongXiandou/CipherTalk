import { useState, type CSSProperties } from 'react'
import { Label, Slider, Tabs, type Key } from '@heroui/react'
import { ImageIcon, Moon, Monitor, PanelBottom, PanelLeft, Sun, Upload, Video } from 'lucide-react'
import { useThemeStore, type HomeBackgroundSource, type NavLayout } from '../../../stores/themeStore'
import { useSettingsStore } from '../settingsStore'
import Select from '../../Select'

type ThemeMode = 'light' | 'dark' | 'system'

const toThemeMode = (key: Key): ThemeMode => String(key) as ThemeMode
const toNavLayout = (key: Key): NavLayout => String(key) as NavLayout
const toHomeBackgroundSource = (key: Key): HomeBackgroundSource => String(key) as HomeBackgroundSource

const getFileName = (filePath: string) => filePath.split(/[\\/]/).filter(Boolean).pop() || '自定义背景'
const toSliderNumber = (value: number | number[]): number => Array.isArray(value) ? value[0] ?? 0 : value

function AppearanceTab() {
  const {
    themeMode,
    navLayout,
    dockAutoHide,
    homeBackground,
    setThemeMode,
    setNavLayout,
    setDockAutoHide,
    setHomeBackgroundSource,
    setHomeBackgroundCustom,
    setHomeBackgroundBlur
  } = useThemeStore()
  const quoteStyle = useSettingsStore(s => s.config.quoteStyle)
  const closeToTray = useSettingsStore(s => s.config.closeToTray)
  const setField = useSettingsStore(s => s.setField)
  const [backgroundImporting, setBackgroundImporting] = useState(false)
  const [backgroundError, setBackgroundError] = useState('')

  const customBackgroundReady = Boolean(homeBackground.customUrl)
    && (homeBackground.customType === 'image' || homeBackground.customType === 'video')
  const backgroundPreviewStyle = {
    '--home-background-preview-blur': `${homeBackground.blur}px`
  } as CSSProperties

  const handlePickBackground = async () => {
    setBackgroundError('')
    setBackgroundImporting(true)
    try {
      const result = await window.electronAPI.dialog.openFile({
        properties: ['openFile'],
        filters: [
          { name: '图片或视频', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'ogg'] },
          { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
          { name: '视频', extensions: ['mp4', 'webm', 'ogg'] }
        ]
      })
      const sourcePath = result.filePaths?.[0]
      if (result.canceled || !sourcePath) return

      const imported = await window.electronAPI.file.importHomeBackground(sourcePath)
      if (!imported.success || !imported.path || !imported.url || !imported.mediaType) {
        setBackgroundError(imported.error || '导入背景失败')
        return
      }

      setHomeBackgroundCustom({
        type: imported.mediaType,
        path: imported.path,
        url: imported.url
      })
    } catch (e) {
      setBackgroundError(`导入背景失败：${e}`)
    } finally {
      setBackgroundImporting(false)
    }
  }

  return (
    <div className="tab-content">
      <Tabs selectedKey={themeMode} onSelectionChange={(key) => setThemeMode(toThemeMode(key))} className="w-full max-w-md">
        <Tabs.ListContainer>
          <Tabs.List aria-label="外观模式" className="*:gap-2">
            <Tabs.Tab id="light"><Sun size={16} aria-hidden />浅色<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="dark"><Moon size={16} aria-hidden />深色<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="system"><Monitor size={16} aria-hidden />跟随系统<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>导航布局</h3>
      <Tabs selectedKey={navLayout} onSelectionChange={(key) => setNavLayout(toNavLayout(key))} className="w-full max-w-md">
        <Tabs.ListContainer>
          <Tabs.List aria-label="导航布局" className="*:gap-2">
            <Tabs.Tab id="sidebar"><PanelLeft size={16} aria-hidden />侧边栏<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="dock"><PanelBottom size={16} aria-hidden />底部 Dock<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      {navLayout === 'dock' && (
        <>
          <h3 className="section-title" style={{ marginTop: '1.5rem' }}>Dock 自动收起</h3>
          <Select<'on' | 'off'>
            style={{ maxWidth: 460 }}
            value={dockAutoHide ? 'on' : 'off'}
            onChange={(v) => setDockAutoHide(v === 'on')}
            options={[
              {
                value: 'on',
                label: '空闲时自动收起',
                description: '鼠标离开 Dock 2.5 秒后收回；移到屏幕底部重新浮出'
              },
              {
                value: 'off',
                label: '始终显示',
                description: 'Dock 一直停留在底部不收起'
              }
            ]}
          />
        </>
      )}

      <h3 className="section-title" style={{ marginTop: '2rem' }}>首页背景</h3>
      <div className="home-background-settings">
        <Tabs
          selectedKey={homeBackground.source}
          onSelectionChange={(key) => setHomeBackgroundSource(toHomeBackgroundSource(key))}
          className="w-full max-w-md"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="首页背景来源" className="*:gap-2">
              <Tabs.Tab id="preset"><Video size={16} aria-hidden />预设背景<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="custom"><ImageIcon size={16} aria-hidden />自定义<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>

        <div className="home-background-config">
          <div className="home-background-preview" aria-label="首页背景预览">
            {homeBackground.source === 'custom' && customBackgroundReady ? (
              homeBackground.customType === 'image' ? (
                <img src={homeBackground.customUrl} alt="" style={backgroundPreviewStyle} />
              ) : (
                <video src={homeBackground.customUrl} autoPlay muted loop playsInline style={backgroundPreviewStyle} />
              )
            ) : (
              <video src="/beijing.mp4" autoPlay muted loop playsInline style={backgroundPreviewStyle} />
            )}
            <span className="home-background-preview-badge">
              {homeBackground.source === 'custom' && customBackgroundReady
                ? homeBackground.customType === 'image' ? '图片' : '视频'
                : '预设视频'}
            </span>
          </div>

          {homeBackground.source === 'custom' && (
            <div className="home-background-controls">
              <button
                type="button"
                className="btn btn-secondary home-background-import-btn"
                onClick={handlePickBackground}
                disabled={backgroundImporting}
              >
                <Upload size={16} aria-hidden />
                {backgroundImporting ? '导入中...' : customBackgroundReady ? '更换背景' : '选择背景'}
              </button>
              <div className="home-background-file-name">
                {customBackgroundReady ? getFileName(homeBackground.customPath) : '未选择自定义背景'}
              </div>
              {backgroundError && <div className="home-background-error">{backgroundError}</div>}
            </div>
          )}
        </div>

        <Slider
          className="home-background-blur-slider"
          value={homeBackground.blur}
          minValue={0}
          maxValue={30}
          step={1}
          onChange={(value) => setHomeBackgroundBlur(toSliderNumber(value))}
        >
          <Label>背景模糊度</Label>
          <Slider.Output>{homeBackground.blur}px</Slider.Output>
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>引用消息样式</h3>
      <div className="quote-style-options">
        <label className={`radio-label ${quoteStyle === 'default' ? 'active' : ''}`}>
          <input
            type="radio"
            name="quoteStyle"
            value="default"
            checked={quoteStyle === 'default'}
            onChange={() => setField('quoteStyle', 'default')}
          />
          <div className="radio-content">
            <div className="style-preview">
              <img src="./logo.png" className="preview-avatar" alt="对方" />
              <div className="preview-bubble default">
                <div className="preview-quote">张三: 那天去爬山的照片...</div>
                <div className="preview-text">拍得真不错！</div>
              </div>
            </div>
          </div>
        </label>

        <label className={`radio-label ${quoteStyle === 'wechat' ? 'active' : ''}`}>
          <input
            type="radio"
            name="quoteStyle"
            value="wechat"
            checked={quoteStyle === 'wechat'}
            onChange={() => setField('quoteStyle', 'wechat')}
          />
          <div className="radio-content">
            <div className="style-preview">
              <img src="./logo.png" className="preview-avatar" alt="对方" />
              <div className="preview-group">
                <div className="preview-bubble wechat">拍得真不错！</div>
                <div className="preview-quote-bubble">张三: 那天去爬山的照片...</div>
              </div>
            </div>
          </div>
        </label>
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>窗口关闭行为</h3>
      <Select<'tray' | 'quit'>
        style={{ maxWidth: 460 }}
        value={closeToTray ? 'tray' : 'quit'}
        onChange={(v) => setField('closeToTray', v === 'tray')}
        options={[
          {
            value: 'tray',
            label: '最小化到托盘',
            description: '点击关闭按钮后，应用将最小化到系统托盘继续运行'
          },
          {
            value: 'quit',
            label: '直接退出应用',
            description: '点击关闭按钮后，应用将完全退出'
          }
        ]}
      />
    </div>
  )
}

export default AppearanceTab

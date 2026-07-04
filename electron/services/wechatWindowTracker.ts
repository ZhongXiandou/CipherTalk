import { screen } from 'electron'
import { wxKeyService } from './wxKeyService'

/**
 * Windows-only WeChat main-window tracker for the reply suggestion tile.
 *
 * WeChat image preview / media viewer windows are also top-level windows owned by
 * Weixin.exe, so do not pick the largest WeChat-owned window. Track only the real
 * Chinese-titled main window instead.
 */

export type WeChatWindowState = {
  found: boolean
  minimized: boolean
  /** True only when the foreground window is the real Chinese-titled WeChat main window. */
  foregroundActive: boolean
  /** True when the foreground window is neither WeChat nor absent. */
  otherForegroundActive: boolean
  foregroundBounds: { x: number; y: number; width: number; height: number } | null
  /** DIP bounds; null when found is false. */
  bounds: { x: number; y: number; width: number; height: number } | null
}

const NOT_FOUND: WeChatWindowState = { found: false, minimized: false, foregroundActive: false, otherForegroundActive: false, foregroundBounds: null, bounds: null }

const GW_HWNDNEXT = 2
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const WINEVENT_OUTOFCONTEXT = 0x0000
const WINEVENT_SKIPOWNPROCESS = 0x0002
const EVENT_SYSTEM_FOREGROUND = 0x0003
const EVENT_SYSTEM_MINIMIZESTART = 0x0016
const EVENT_SYSTEM_MINIMIZEEND = 0x0017
const EVENT_OBJECT_LOCATIONCHANGE = 0x800B
const OBJID_WINDOW = 0
const CHILDID_SELF = 0
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const SWP_NOOWNERZORDER = 0x0200

let loaded = false
let unavailable = false
let koffi: any = null
let GetTopWindow: any, GetWindow: any, GetWindowThreadProcessId: any
let IsWindowVisible: any, IsIconic: any, GetWindowTextLengthW: any, GetWindowTextW: any
let GetWindowRect: any, GetForegroundWindow: any, DwmGetWindowAttribute: any
let GetForegroundWindowHandle: any, SetWindowPos: any
let SetWinEventHook: any, UnhookWinEvent: any, WinEventProc: any
let pidBuf: any = null
let rectBuf: any = null
let titleBuf: Buffer | null = null

let cachedPid: number | null = null
let lastPidProbe = 0
let cachedMainHwndAddr = 0n

function ensureLoaded(): boolean {
  if (loaded) return !unavailable
  loaded = true
  try {
    koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    GetTopWindow = user32.func('void* GetTopWindow(void* hwnd)')
    GetWindow = user32.func('void* GetWindow(void* hwnd, uint32 uCmd)')
    GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void* hwnd, void* pid)')
    IsWindowVisible = user32.func('bool IsWindowVisible(void* hwnd)')
    IsIconic = user32.func('bool IsIconic(void* hwnd)')
    GetWindowTextLengthW = user32.func('int32 GetWindowTextLengthW(void* hwnd)')
    GetWindowTextW = user32.func('int32 GetWindowTextW(void* hwnd, void* text, int32 maxCount)')
    GetWindowRect = user32.func('bool GetWindowRect(void* hwnd, void* rect)')
    GetForegroundWindow = user32.func('void* GetForegroundWindow()')
    GetForegroundWindowHandle = user32.func('uintptr GetForegroundWindow()')
    SetWindowPos = user32.func('bool SetWindowPos(uintptr hWnd, uintptr hWndInsertAfter, int32 X, int32 Y, int32 cx, int32 cy, uint32 uFlags)')
    SetWinEventHook = user32.func('void* SetWinEventHook(uint32 eventMin, uint32 eventMax, void* hmodWinEventProc, void* pfnWinEventProc, uint32 idProcess, uint32 idThread, uint32 dwFlags)')
    UnhookWinEvent = user32.func('bool UnhookWinEvent(void* hWinEventHook)')
    WinEventProc = koffi.proto('void __stdcall WinEventProc(void* hWinEventHook, uint32 event, void* hwnd, int32 idObject, int32 idChild, uint32 idEventThread, uint32 dwmsEventTime)')
    DwmGetWindowAttribute = dwmapi.func('int32 DwmGetWindowAttribute(void* hwnd, uint32 attr, void* rect, uint32 cb)')
    pidBuf = koffi.alloc('uint32', 1)
    rectBuf = koffi.alloc('int32', 4)
    titleBuf = Buffer.alloc(512 * 2)
    return true
  } catch {
    unavailable = true
    return false
  }
}

function readPid(hwnd: any): number {
  GetWindowThreadProcessId(hwnd, pidBuf)
  return koffi.decode(pidBuf, 'uint32', 1)[0]
}

function readRect(hwnd: any): { left: number; top: number; right: number; bottom: number } | null {
  const ok = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rectBuf, 16) === 0
    || GetWindowRect(hwnd, rectBuf)
  if (!ok) return null
  const [left, top, right, bottom] = koffi.decode(rectBuf, 'int32', 4)
  if (right <= left || bottom <= top) return null
  return { left, top, right, bottom }
}

function readTitle(hwnd: any): string {
  if (!titleBuf) return ''
  const len = GetWindowTextLengthW(hwnd)
  if (len <= 0) return ''
  titleBuf.fill(0)
  GetWindowTextW(hwnd, titleBuf, 512)
  return titleBuf.toString('ucs2').replace(/\u0000+$/, '').trim()
}

function isWeChatMainTitle(title: string): boolean {
  return title === '\u5fae\u4fe1'
}

function hwndAddress(hwnd: any): bigint {
  try { return koffi.address(hwnd) as bigint } catch { return 0n }
}

function findMainWindow(pid: number): { hwnd: any; hwndAddr: bigint; rect: { left: number; top: number; right: number; bottom: number } } | null {
  let hwnd = GetTopWindow(null)
  let best: { hwnd: any; hwndAddr: bigint; rect: any; area: number } | null = null
  let guard = 0
  while (hwnd && guard++ < 5000) {
    if (readPid(hwnd) === pid && IsWindowVisible(hwnd) && isWeChatMainTitle(readTitle(hwnd))) {
      const rect = readRect(hwnd)
      if (rect) {
        const area = (rect.right - rect.left) * (rect.bottom - rect.top)
        if (!best || area > best.area) best = { hwnd, hwndAddr: hwndAddress(hwnd), rect, area }
      }
    }
    hwnd = GetWindow(hwnd, GW_HWNDNEXT)
  }
  return best ? { hwnd: best.hwnd, hwndAddr: best.hwndAddr, rect: best.rect } : null
}

function foregroundWindow(): { hwnd: any; hwndAddr: bigint; bounds: { x: number; y: number; width: number; height: number } | null } | null {
  const hwnd = GetForegroundWindow()
  if (!hwnd) return null
  const rect = readRect(hwnd)
  const bounds = rect
    ? screen.screenToDipRect(null, { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top })
    : null
  return { hwnd, hwndAddr: hwndAddress(hwnd), bounds }
}

export function probeWeChatWindow(): WeChatWindowState {
  if (process.platform !== 'win32' || !ensureLoaded()) return NOT_FOUND

  let pid = cachedPid
  let main = pid ? findMainWindow(pid) : null
  if (!main) {
    const now = Date.now()
    if (now - lastPidProbe > 3000) {
      lastPidProbe = now
      cachedPid = wxKeyService.getWeChatPid()
      pid = cachedPid
      main = pid ? findMainWindow(pid) : null
    }
  }
  if (!pid || !main) return NOT_FOUND

  cachedMainHwndAddr = main.hwndAddr
  const minimized = IsIconic(main.hwnd)
  const foreground = foregroundWindow()
  const foregroundActive = foreground?.hwndAddr === main.hwndAddr
  const { left, top, right, bottom } = main.rect
  const dip = screen.screenToDipRect(null, { x: left, y: top, width: right - left, height: bottom - top })
  return {
    found: true,
    minimized,
    foregroundActive,
    otherForegroundActive: Boolean(foreground && !foregroundActive),
    foregroundBounds: foreground?.bounds || null,
    bounds: { x: dip.x, y: dip.y, width: dip.width, height: dip.height },
  }
}

function getWeChatPidForHook(): number | null {
  if (cachedPid) return cachedPid
  cachedPid = wxKeyService.getWeChatPid()
  return cachedPid
}

function shouldHandleWinEvent(pid: number, event: number, hwnd: any, idObject: number, idChild: number): boolean {
  if (!hwnd) return false
  if (event === EVENT_SYSTEM_FOREGROUND) return true
  if (event === EVENT_OBJECT_LOCATIONCHANGE && (idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF)) return false

  const addr = hwndAddress(hwnd)
  if (cachedMainHwndAddr && addr === cachedMainHwndAddr) return true

  const main = findMainWindow(pid)
  if (!main) return false
  cachedMainHwndAddr = main.hwndAddr
  return addr === main.hwndAddr
}

export function watchWeChatWindowEvents(onChange: () => void): (() => void) | null {
  if (process.platform !== 'win32' || !ensureLoaded()) return null

  const pid = getWeChatPidForHook()
  if (!pid) return null

  const callback = koffi.register((hook: unknown, event: number, hwnd: unknown, idObject: number, idChild: number) => {
    try {
      if (shouldHandleWinEvent(pid, event, hwnd, idObject, idChild)) onChange()
    } catch {
      // Keep native callbacks noexcept; the fallback poll will recover state.
    }
  }, koffi.pointer(WinEventProc))

  const flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
  const hooks = [
    SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, null, callback, pid, 0, flags),
    SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, null, callback, pid, 0, flags),
    SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, null, callback, 0, 0, WINEVENT_OUTOFCONTEXT),
  ].filter(Boolean)

  if (hooks.length === 0) {
    koffi.unregister(callback)
    return null
  }

  return () => {
    for (const hook of hooks) {
      try { UnhookWinEvent(hook) } catch { /* ignore */ }
    }
    try { koffi.unregister(callback) } catch { /* ignore */ }
  }
}

function nativeWindowHandleToBigInt(handle: Buffer): bigint {
  if (handle.length >= 8) return handle.readBigUInt64LE(0)
  if (handle.length >= 4) return BigInt(handle.readUInt32LE(0))
  return 0n
}

export function placeNativeWindowBehindForeground(nativeWindowHandle: Buffer): boolean {
  if (process.platform !== 'win32' || !ensureLoaded()) return false
  const hwnd = nativeWindowHandleToBigInt(nativeWindowHandle)
  const foreground = BigInt(GetForegroundWindowHandle() || 0)
  if (!hwnd || !foreground || hwnd === foreground) return false
  const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER
  try {
    return Boolean(SetWindowPos(hwnd, foreground, 0, 0, 0, 0, flags))
  } catch {
    return false
  }
}

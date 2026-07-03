import type { ComponentType } from 'react'

/**
 * 通用图标组件类型：与具体图标库解耦。
 * lucide / @gravity-ui/icons 的图标组件都可赋值给它（均接受 className）。
 */
export type IconComponent = ComponentType<{ className?: string }>

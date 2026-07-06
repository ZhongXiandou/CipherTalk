import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createLiquidGlassBubbleMap, type GlassFilterMap } from '../../utils/liquidGlass'

const FILTER_ID = 'home-moment-glass'
// 形状跟随气泡本身（18/18/18/4 圆角矩形 SDF），折射观感对齐玻璃球：
// 无内部波纹、折射带铺满全表面（edgeSize 盖过半高）、同等强度 strength 6
const BUBBLE_GLASS = {
  radii: { topLeft: 18, topRight: 18, bottomRight: 18, bottomLeft: 4 },
  edgeSize: 28,
  edgeStrength: 7,
  surface: 0,
  strength: 6,
}

/** 回忆一刻文字气泡的液态玻璃外壳：按自身尺寸生成位移贴图，用 backdrop-filter 折射。
 *  气泡文字长度会变（换一条/多行），故用 ResizeObserver 跟随尺寸重建贴图。 */
export function LiquidGlassBubble({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLQuoteElement>(null)
  const [map, setMap] = useState<GlassFilterMap | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (width < 2 || height < 2) return
      const next = createLiquidGlassBubbleMap(width, height, BUBBLE_GLASS)
      if (next) setMap(next)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const backdrop = map ? `url(#${FILTER_ID}) blur(1.2px)` : undefined

  return (
    <blockquote
      ref={ref}
      className="random-message-body random-message-body--glass"
      style={map ? { backdropFilter: backdrop, WebkitBackdropFilter: backdrop } : undefined}
    >
      {map && (
        <svg aria-hidden="true" focusable="false" style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}>
          <filter
            id={FILTER_ID}
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={map.width}
            height={map.height}
          >
            <feImage href={map.href} xlinkHref={map.href} width={map.width} height={map.height} result="displacementMap" />
            <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={map.scale} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
      )}
      {children}
    </blockquote>
  )
}

import { memo } from 'react'

// 粒子数量在模块作用域固定一次,避免每次渲染重建数组。
const PARTICLES = Array.from({ length: 15 })

// 无 props 的纯展示组件,memo 后整个设置页生命周期只渲染一次。
function BackgroundFx() {
  return (
    <div className="bg-particles">
      {PARTICLES.map((_, i) => (
        <div key={i} className="particle" />
      ))}
    </div>
  )
}

export default memo(BackgroundFx)

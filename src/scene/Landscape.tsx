import { useCallback, useEffect, useRef, useState } from 'react'
import type { LandscapeHandle, QualityLevel } from './createLandscape'

type QualityChoice = QualityLevel | 'auto'

const NEXT_CHOICE: Record<QualityChoice, QualityChoice> = {
  auto: 'high',
  high: 'low',
  low: 'auto',
}

const CHOICE_LABEL: Record<QualityChoice, string> = {
  auto: '自动',
  high: '高',
  low: '低',
}

/** Three.js 3D 风景：暮色山谷 + 湖面倒影。整块画面由 WebGL 实时渲染。 */
export default function Landscape() {
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<LandscapeHandle | null>(null)
  const [choice, setChoice] = useState<QualityChoice>('auto')
  const [degraded, setDegraded] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let disposed = false
    let handle: LandscapeHandle | null = null

    const boot = async () => {
      const { createLandscape } = await import('./createLandscape')
      if (disposed || !hostRef.current) return

      handle = createLandscape(hostRef.current, {
        quality: 'auto',
        onReady: () => {
          setReady(true)
          document.documentElement.classList.add('scene-ready')
        },
        onAutoDegrade: () => setDegraded(true),
      })
      handleRef.current = handle
    }

    void boot()

    return () => {
      disposed = true
      handle?.dispose()
      handleRef.current = null
      document.documentElement.classList.remove('scene-ready')
    }
  }, [])

  useEffect(() => {
    handleRef.current?.setQuality(choice)
  }, [choice])

  const cycleQuality = useCallback(() => {
    setDegraded(false)
    setChoice((current) => NEXT_CHOICE[current])
  }, [])

  return (
    <>
      <div className="scene" ref={hostRef} aria-hidden="true" />
      <div className="scene__vignette" aria-hidden="true" />

      {!ready ? (
        <p className="scene__loading" role="status">
          正在生成 3D 风景…
        </p>
      ) : null}

      <div className="scene__controls">
        {degraded ? (
          <p className="scene__notice">检测到掉帧，已自动降为低画质</p>
        ) : null}
        <button
          type="button"
          className="chip"
          onClick={cycleQuality}
          title="切换渲染画质：自动 / 高 / 低"
          aria-label={`当前画质：${CHOICE_LABEL[choice]}，点击切换`}
        >
          <span className="chip__dot" aria-hidden="true" />
          画质 {CHOICE_LABEL[choice]}
        </button>
      </div>
    </>
  )
}

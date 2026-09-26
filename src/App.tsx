import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { SpacetimeEngine, fmt, type EngineState } from './engine'
import './App.css'

const RATES = [4, 8, 12, 24]

const INITIAL: EngineState = {
  t: 0, playing: false, rate: 8, sliceRate: 8, n: 0, duration: 12.5, aspect: 16 / 9,
  source: 'Test pattern', hover: { show: false }, loading: { show: false },
}

function useViewport() {
  const [vp, setVp] = useState({ w: innerWidth, h: innerHeight })
  useEffect(() => {
    const on = () => setVp({ w: innerWidth, h: innerHeight })
    addEventListener('resize', on)
    return () => removeEventListener('resize', on)
  }, [])
  return vp
}

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<SpacetimeEngine | null>(null)
  const [s, setS] = useState<EngineState>(INITIAL)
  const [orbit, setOrbit] = useState(true)
  const vp = useViewport()

  useEffect(() => {
    const engine = new SpacetimeEngine(
      mountRef.current!,
      previewRef.current!,
      { sliceSpacing: 0.07, farOpacity: 0.05, showCage: true },
      patch => setS(prev => ({ ...prev, ...patch })),
    )
    engineRef.current = engine
    return () => {
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    if (engineRef.current) engineRef.current.orbit = orbit
  }, [orbit])

  const engine = () => engineRef.current!
  const wide = vp.w >= 1000 && vp.h >= 600
  const n = s.n, dur = s.duration || 1
  const active = Math.min(n - 1, Math.max(0, Math.floor(s.t * s.sliceRate)))
  const progressPct = Math.min(100, (s.t / dur) * 100)
  const tickStep = dur > 30 ? 5 : 1
  const ticks: number[] = []
  for (let i = tickStep; i < dur; i += tickStep) ticks.push((i / dur) * 100)

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) void engine().loadFile(f, s.rate)
    e.target.value = ''
  }

  const onScrubDown = (e: ReactPointerEvent) => {
    const scrub = (ev: { clientX: number }) => {
      const rect = trackRef.current!.getBoundingClientRect()
      engine().seek(Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)) * engine().duration)
    }
    scrub(e)
    const up = () => {
      removeEventListener('pointermove', scrub)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', scrub)
    addEventListener('pointerup', up)
  }

  return (
    <div className="stage">
      <div ref={mountRef} className="mount" />

      <header className="header">
        <div className="brand">
          <h1 className="title">Video Spacetime</h1>
          <div className="axes">x · y · t</div>
        </div>
        <div className="header-actions">
          <div className="source">{s.source}</div>
          <label className="btn btn-accent">
            Upload video
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7" /><path d="M7 7h10v10" /></svg>
            <input type="file" accept="video/*" onChange={onFile} hidden />
          </label>
        </div>
      </header>

      {wide && (
        <aside className="plate">
          <div className="kicker">Plate I — The volume</div>
          <div className="rule" />
          <p className="lede">A normal video is a sequence through time. Here that sequence becomes a physical object.</p>
        </aside>
      )}

      <div className="preview" style={{ width: wide ? 240 : 168 }}>
        <div className="preview-frame">
          <canvas ref={previewRef} width={480} height={270} />
        </div>
        <div className="preview-meta">
          <span className="italic">Active slice</span>
          <span>{s.aspect.toFixed(2)} : 1</span>
        </div>
      </div>

      {s.hover.show && (
        <div className="tooltip" style={{ left: s.hover.x, top: s.hover.y }}>{s.hover.label}</div>
      )}

      {s.loading.show && (
        <div className="loading">
          <div className="loading-inner">
            <div className="loading-title">Slicing time</div>
            <div className="loading-track"><div style={{ width: `${s.loading.pct}%` }} /></div>
            <div className="loading-label">{s.loading.label}</div>
          </div>
        </div>
      )}

      <footer className={`footer ${wide ? 'wide' : ''}`}>
        {wide && <div className="hint">Drag to rotate · Scroll to zoom · Shift-drag to pan · Click a slice to jump there</div>}
        <div className="timeline">
          <div className="time">{fmt(s.t)}</div>
          <div ref={trackRef} className="track" onPointerDown={onScrubDown}>
            <div className="track-line" />
            <div className="track-fill" style={{ width: `${progressPct}%` }} />
            {ticks.map(p => <div key={p} className="tick" style={{ left: `${p}%` }} />)}
            <div className="knob" style={{ left: `${progressPct}%` }} />
          </div>
          <div className="time muted">{fmt(dur)}</div>
        </div>

        <div className="controls">
          <div className="transport">
            <button className="btn-square" aria-label="Previous frame" onClick={() => engine().step(-1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <button className="btn btn-accent btn-play" onClick={() => engine().setPlaying(!s.playing)}>
              {s.playing
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M7 4.5v15l12-7.5z" /></svg>}
              {s.playing ? 'Pause' : 'Play'}
            </button>
            <button className="btn-square" aria-label="Next frame" onClick={() => engine().step(1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
            </button>
            <div className="frame-count">
              <div className="label">Frame</div>
              <div className="value">{String(active + 1).padStart(3, '0')} / {String(n).padStart(3, '0')}</div>
            </div>
          </div>

          <div className="options">
            <div className="sampling">
              {wide && <div className="label">Sampling</div>}
              <div className="seg">
                {RATES.map(r => (
                  <button key={r} className={r === s.rate ? 'on' : ''} onClick={() => r !== s.rate && void engine().setRate(r)}>{r} fps</button>
                ))}
              </div>
            </div>
            <button className={`btn-small ${orbit ? 'on' : ''}`} onClick={() => setOrbit(o => !o)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
              Auto camera
            </button>
            <button className="btn-small" onClick={() => engine().resetView()}>Reset view</button>
          </div>
        </div>
      </footer>
    </div>
  )
}

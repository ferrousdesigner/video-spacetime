import * as THREE from 'three'

export type Hover = { show: false } | { show: true; x: number; y: number; label: string }
export type Loading = { show: false } | { show: true; pct: number; label: string }

export interface EngineState {
  t: number
  playing: boolean
  rate: number
  /** slices per second actually sampled (differs from rate when a long video is capped) */
  sliceRate: number
  n: number
  duration: number
  aspect: number
  source: string
  hover: Hover
  loading: Loading
}

export interface EngineOptions {
  sliceSpacing: number
  farOpacity: number
  showCage: boolean
}

interface Frame {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  edge: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>
  canvas: HTMLCanvasElement
}

const MAX_SLICES = 360
const DEMO_DURATION = 12.5

export function fmt(s: number) {
  s = Math.max(0, s || 0)
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), cs = Math.floor((s % 1) * 100)
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + String(cs).padStart(2, '0')
}

export class SpacetimeEngine {
  orbit = true
  t = 0
  duration = DEMO_DURATION
  rate = 8
  playing = false

  private opts: EngineOptions
  private preview: HTMLCanvasElement
  private emit: (patch: Partial<EngineState>) => void
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200)
  private group = new THREE.Group()
  private ray = new THREE.Raycaster()
  private cam = { theta: 0.85, phi: 1.15, radius: 9, target: new THREE.Vector3() }
  private frames: Frame[] = []
  private cursor?: THREE.LineLoop
  private hoverBox?: THREE.LineLoop
  private hoverIdx = -1
  private depth = 7
  private video: HTMLVideoElement | null = null
  private videoUrl?: string
  private videoName = ''
  private drag: { x: number; y: number; moved: boolean; shift: boolean } | null = null
  private hovering = false
  private raf = 0
  private fit = 1
  private ro: ResizeObserver
  private disposers: (() => void)[] = []

  constructor(mount: HTMLElement, preview: HTMLCanvasElement, opts: EngineOptions, emit: (patch: Partial<EngineState>) => void) {
    this.preview = preview
    this.opts = opts
    this.emit = emit
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    r.setPixelRatio(Math.min(2, devicePixelRatio))
    r.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(r.domElement)
    this.scene.add(this.group)

    // dust
    const g = new THREE.BufferGeometry(), pts: number[] = []
    for (let i = 0; i < 700; i++) pts.push((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 26, (Math.random() - 0.5) * 40)
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xd8cbb4, size: 0.035, transparent: true, opacity: 0.35, depthWrite: false })))

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight
      r.setSize(w, h)
      this.camera.aspect = w / h
      // pull back on portrait screens so the volume still fits
      this.fit = Math.max(1, 0.9 / this.camera.aspect)
      this.camera.updateProjectionMatrix()
    }
    this.ro = new ResizeObserver(resize)
    this.ro.observe(mount)
    resize()
    this.bindPointer(r.domElement)
    this.buildDemo()

    let last = performance.now(), lastUi = 0
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (this.playing) {
        if (this.video) this.t = this.video.currentTime
        else {
          this.t += dt
          if (this.t >= this.duration) this.t = 0
        }
        if (this.orbit && !this.drag) this.cam.theta += dt * 0.08
      }
      this.updateScene()
      this.drawPreview()
      if (now - lastUi > 66) {
        lastUi = now
        this.emit({ t: this.t, playing: this.playing })
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.disposers.forEach(d => d())
    this.video?.pause()
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl)
    this.clearGroup()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private drawPreview() {
    const cv = this.preview
    const src = this.video && this.video.readyState >= 2 ? this.video : this.frames[this.activeIndex()]?.canvas
    if (!cv || !src) return
    const x = cv.getContext('2d')!
    const sw = src instanceof HTMLVideoElement ? src.videoWidth : src.width
    const sh = src instanceof HTMLVideoElement ? src.videoHeight : src.height
    const s = Math.min(cv.width / sw, cv.height / sh)
    x.fillStyle = '#0c0b0a'
    x.fillRect(0, 0, cv.width, cv.height)
    x.drawImage(src, (cv.width - sw * s) / 2, (cv.height - sh * s) / 2, sw * s, sh * s)
  }

  activeIndex() {
    return Math.min(this.frames.length - 1, Math.max(0, Math.floor(this.t * this.rate)))
  }

  // ── playback ──

  setPlaying(p: boolean) {
    this.playing = p
    if (this.video) {
      if (p) void this.video.play()
      else this.video.pause()
    }
    this.emit({ playing: p })
  }

  seek(t: number) {
    this.t = Math.max(0, Math.min(this.duration - 0.001, t))
    if (this.video) this.video.currentTime = this.t
    this.emit({ t: this.t })
  }

  step(delta: number) {
    this.setPlaying(false)
    this.seek((this.activeIndex() + delta) / this.rate + 0.0001)
  }

  async setRate(r: number) {
    if (this.video) await this.extract(null, r)
    else {
      this.rate = r
      this.buildDemo()
    }
    this.emit({ rate: r })
  }

  resetView() {
    Object.assign(this.cam, { theta: 0.85, phi: 1.15, radius: Math.max(4.5, this.depth * 1.35 + 2) })
    this.cam.target.set(0, 0, 0)
  }

  async loadFile(file: File, rate: number) {
    try {
      await this.extract(file, rate)
    } catch {
      this.emit({ loading: { show: false }, source: 'Could not read that video' })
    }
  }

  // ── frames ──

  private buildDemo() {
    this.video = null
    this.duration = DEMO_DURATION
    const n = Math.round(this.duration * this.rate), list: HTMLCanvasElement[] = []
    for (let i = 0; i < n; i++) list.push(this.drawPattern(i / this.rate))
    this.setFrames(list, 16 / 9)
    this.emit({ source: 'Test pattern', duration: this.duration })
  }

  private drawPattern(t: number) {
    const c = document.createElement('canvas')
    c.width = 320
    c.height = 180
    const x = c.getContext('2d')!
    x.fillStyle = '#1b1917'
    x.fillRect(0, 0, 320, 180)
    x.strokeStyle = 'rgba(243,242,242,0.08)'
    x.lineWidth = 1
    for (let i = 20; i < 320; i += 20) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 180); x.stroke() }
    for (let i = 20; i < 180; i += 20) { x.beginPath(); x.moveTo(0, i); x.lineTo(320, i); x.stroke() }
    const a = (t / 6) * Math.PI * 2
    x.strokeStyle = 'rgba(243,242,242,0.25)'
    x.beginPath(); x.arc(160, 90, 58, 0, Math.PI * 2); x.stroke()
    const bx = (t / this.duration) * 320
    x.fillStyle = 'rgba(243,242,242,0.85)'
    x.fillRect(bx - 2, 0, 4, 180)
    x.fillStyle = '#c28d41'
    x.beginPath(); x.arc(160 + Math.cos(a) * 58, 90 + Math.sin(a) * 58, 13, 0, Math.PI * 2); x.fill()
    x.fillStyle = '#e8e2d8'
    x.beginPath(); x.arc(160 + Math.cos(-a * 2) * 28, 90 + Math.sin(-a * 2) * 28, 5, 0, Math.PI * 2); x.fill()
    x.fillStyle = 'rgba(243,242,242,0.7)'
    x.font = '12px Lora, serif'
    x.fillText(fmt(t), 12, 168)
    return c
  }

  private clearGroup() {
    const geos = new Set<THREE.BufferGeometry>()
    this.group.children.slice().forEach(o => {
      this.group.remove(o)
      const obj = o as THREE.Mesh
      if (obj.geometry) geos.add(obj.geometry)
      const m = obj.material as THREE.MeshBasicMaterial | undefined
      if (m) {
        m.map?.dispose()
        m.dispose()
      }
    })
    geos.forEach(g => g.dispose())
  }

  private setFrames(canvases: HTMLCanvasElement[], aspect: number) {
    this.clearGroup()
    const n = canvases.length, sp = this.opts.sliceSpacing, depth = n * sp, h = 1, w = aspect * h
    const plane = new THREE.PlaneGeometry(w, h), edges = new THREE.EdgesGeometry(plane)
    this.frames = canvases.map((c, i) => {
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      const mesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }))
      mesh.position.z = (i - (n - 1) / 2) * sp
      mesh.userData.i = i
      const edge = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xf3f2f2, transparent: true, depthWrite: false }))
      edge.position.z = mesh.position.z
      this.group.add(mesh, edge)
      return { mesh, edge, canvas: c }
    })
    if (this.opts.showCage) {
      const cage = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(w * 1.06, h * 1.06, depth + sp * 2)),
        new THREE.LineBasicMaterial({ color: 0xb68235, transparent: true, opacity: 0.45 }),
      )
      const ax = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-w * 0.53, -h * 0.53 - 0.08, -depth / 2),
        new THREE.Vector3(-w * 0.53, -h * 0.53 - 0.08, depth / 2),
      ])
      this.group.add(cage, new THREE.Line(ax, new THREE.LineBasicMaterial({ color: 0xb68235, transparent: true, opacity: 0.8 })))
    }
    const loopGeo = new THREE.BufferGeometry().setFromPoints(
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => new THREE.Vector3(a * w * 0.515, b * h * 0.515, 0)),
    )
    this.cursor = new THREE.LineLoop(loopGeo, new THREE.LineBasicMaterial({ color: 0xe1ad66 }))
    this.hoverBox = new THREE.LineLoop(loopGeo, new THREE.LineBasicMaterial({ color: 0xf3f2f2, transparent: true, opacity: 0.7 }))
    this.hoverBox.visible = false
    this.group.add(this.cursor, this.hoverBox)
    this.hoverIdx = -1
    this.depth = depth
    this.cam.radius = Math.max(4.5, depth * 1.35 + 2)
    this.cam.target.set(0, 0, 0)
    this.emit({ n, aspect, sliceRate: this.rate })
  }

  private async extract(file: File | null, rate: number) {
    const wasPlaying = this.playing
    this.setPlaying(false)
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.loop = true
    if (file) {
      if (this.videoUrl) URL.revokeObjectURL(this.videoUrl)
      this.videoUrl = URL.createObjectURL(file)
      this.videoName = file.name
    }
    v.src = this.videoUrl!
    this.emit({ loading: { show: true, pct: 0, label: 'Reading video' } })
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej })
    const dur = v.duration
    let n = Math.max(2, Math.floor(dur * rate))
    const capped = n > MAX_SLICES
    n = Math.min(n, MAX_SLICES)
    const aspect = v.videoWidth / v.videoHeight, W = 320, H = Math.round(W / aspect), list: HTMLCanvasElement[] = []
    const sliceRate = n / dur
    for (let i = 0; i < n; i++) {
      await new Promise(res => { v.onseeked = res; v.currentTime = Math.min(dur - 0.01, i / sliceRate) })
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      c.getContext('2d')!.drawImage(v, 0, 0, W, H)
      list.push(c)
      if (i % 4 === 0) this.emit({ loading: { show: true, pct: Math.round((i / n) * 100), label: 'Slice ' + (i + 1) + ' of ' + n } })
    }
    v.onseeked = null
    v.currentTime = 0
    this.video?.pause()
    this.video = v
    this.rate = sliceRate
    this.duration = dur
    this.t = 0
    this.setFrames(list, aspect)
    this.emit({
      loading: { show: false },
      source: this.videoName + (capped ? ' · capped at ' + MAX_SLICES + ' slices' : ''),
      duration: dur,
      t: 0,
    })
    if (wasPlaying) this.setPlaying(true)
  }

  // ── rendering ──

  private opacityAt(d: number) {
    const P = [1, 0.7, 0.5, 0.4, 0.2], floor = this.opts.farOpacity
    if (d >= 4) return Math.max(floor, 0.2 - (d - 4) * 0.04)
    const i = Math.floor(d), f = d - i
    return P[i] + (P[i + 1] - P[i]) * f
  }

  private updateScene() {
    const c = this.cam
    c.phi = Math.max(0.15, Math.min(Math.PI - 0.15, c.phi))
    this.camera.position.setFromSphericalCoords(c.radius * this.fit, c.phi, c.theta).add(c.target)
    this.camera.lookAt(c.target)
    const a = this.activeIndex(), sp = this.opts.sliceSpacing, n = this.frames.length
    this.frames.forEach((f, i) => {
      const o = this.opacityAt(Math.abs(i - a))
      f.mesh.material.opacity = o
      f.mesh.renderOrder = i === a ? 10 : 0
      f.edge.material.opacity = i === a ? 0 : Math.min(0.35, o * 0.45)
    })
    if (this.cursor) this.cursor.position.z = (a - (n - 1) / 2) * sp + 0.001
    if (this.hoverBox) {
      this.hoverBox.visible = this.hoverIdx >= 0 && this.hoverIdx !== a
      this.hoverBox.position.z = (this.hoverIdx - (n - 1) / 2) * sp
    }
    this.renderer.render(this.scene, this.camera)
  }

  // ── pointer ──

  private pick(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const v = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.ray.setFromCamera(v, this.camera)
    const hits = this.ray.intersectObjects(this.frames.map(f => f.mesh))
    if (!hits.length) return -1
    // prefer the most visible slice along the ray
    const opacity = (h: THREE.Intersection) => ((h.object as THREE.Mesh).material as THREE.Material).opacity
    let best = hits[0]
    for (const h of hits) if (opacity(h) > opacity(best) + 0.25) best = h
    return best.object.userData.i as number
  }

  private bindPointer(dom: HTMLCanvasElement) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      dom.addEventListener(type, fn, opts)
      this.disposers.push(() => dom.removeEventListener(type, fn))
    }
    dom.style.touchAction = 'none'
    on('pointerdown', e => {
      this.drag = { x: e.clientX, y: e.clientY, moved: false, shift: e.shiftKey }
      dom.setPointerCapture(e.pointerId)
      dom.style.cursor = 'grabbing'
    })
    on('pointermove', e => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y
        if (Math.abs(dx) + Math.abs(dy) > 2) this.drag.moved = true
        this.drag.x = e.clientX
        this.drag.y = e.clientY
        if (this.drag.shift || e.shiftKey) {
          const k = this.cam.radius * 0.0012
          const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0)
          const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1)
          this.cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k)
        } else {
          this.cam.theta -= dx * 0.006
          this.cam.phi -= dy * 0.006
        }
        if (this.hovering) this.setHover({ show: false })
        return
      }
      const i = this.pick(e)
      this.hoverIdx = i
      const rect = dom.getBoundingClientRect()
      dom.style.cursor = i >= 0 ? 'pointer' : 'grab'
      this.setHover(i >= 0
        ? { show: true, x: e.clientX - rect.left, y: e.clientY - rect.top, label: 'Frame ' + String(i + 1).padStart(3, '0') + ' · ' + fmt(i / this.rate) }
        : { show: false })
    })
    on('pointerup', e => {
      const d = this.drag
      this.drag = null
      dom.style.cursor = 'grab'
      if (d && !d.moved) {
        const i = this.pick(e)
        if (i >= 0) this.seek(i / this.rate + 0.0001)
      }
    })
    on('pointerleave', () => {
      this.hoverIdx = -1
      this.setHover({ show: false })
    })
    on('wheel', e => {
      e.preventDefault()
      this.cam.radius = Math.max(1.2, Math.min(80, this.cam.radius * Math.exp(e.deltaY * 0.0012)))
    }, { passive: false })
  }

  private setHover(h: Hover) {
    if (!h.show && !this.hovering) return
    this.hovering = h.show
    this.emit({ hover: h })
  }
}

import type { Course, TerrainSegment, TerrainWave, CourseTheme, ControlPoint, Hazard } from './terrain'
import { buildSegments, terrainY, DEFAULT_COURSE, buildSpline, splineY, hexWithAlpha, waterPoolBounds } from './terrain'
import './editor.css'

export interface EditorHandle { show: () => void; hide: () => void }

export function initEditor(opts: {
  getCourse: () => Course
  onCourseChange: (c: Course) => void
}): EditorHandle {

  // ---- overlay ----
  const overlay = document.createElement('div')
  overlay.className = 'editor-overlay'
  overlay.style.display = 'none'
  document.body.appendChild(overlay)

  // ---- toolbar ----
  const toolbar = document.createElement('div')
  toolbar.className = 'editor-toolbar'
  const backBtn = mkBtn('← Back', () => { overlay.style.display = 'none' })
  const titleEl = document.createElement('span')
  titleEl.className = 'editor-title'; titleEl.textContent = 'Map Editor'
  const saveBtn = mkBtn('Save', () => {
    localStorage.setItem('golf01_course', JSON.stringify(editCourse))
    saveBtn.textContent = 'Saved ✓'
    setTimeout(() => { saveBtn.textContent = 'Save' }, 1500)
  })
  const loadBtn = mkBtn('Load', () => {
    const raw = localStorage.getItem('golf01_course')
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      editCourse = {
        ...DEFAULT_COURSE, ...parsed,
        controlPoints: parsed.controlPoints ?? DEFAULT_COURSE.controlPoints,
        theme: { ...DEFAULT_COURSE.theme, ...(parsed.theme ?? {}) },
      }
      emit(); rebuild()
    } catch { /* ignore */ }
  })
  const controlsBtn = mkBtn('Controls', () => { controlsPopup.style.display = 'flex' })
  toolbar.append(backBtn, titleEl, saveBtn, loadBtn, controlsBtn)
  overlay.appendChild(toolbar)

  // ---- controls popup ----
  const controlsPopup = document.createElement('div')
  controlsPopup.style.cssText = [
    'display:none;position:absolute;inset:0;z-index:20',
    'align-items:center;justify-content:center',
    'background:rgba(0,0,0,0.55)',
  ].join(';')
  const controlsCard = document.createElement('div')
  controlsCard.style.cssText = [
    'background:#1a1a1f;border:1px solid #444;border-radius:6px',
    'padding:20px 28px;color:#ccc;font:13px monospace;min-width:320px',
  ].join(';')
  controlsCard.innerHTML = `
    <div style="font-size:15px;font-weight:bold;color:#eee;margin-bottom:14px">Controls — Game View</div>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Click</td><td>Add spline control point</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Drag point</td><td>Move control point</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Double-click point</td><td>Delete control point</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Space + drag</td><td>Pan camera</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Scroll wheel</td><td>Zoom</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Minimap drag</td><td>Jump camera to position</td></tr>
    </table>
    <div style="font-size:15px;font-weight:bold;color:#eee;margin:16px 0 14px">Controls — Global View</div>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Click</td><td>Add spline control point</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Drag point</td><td>Move control point</td></tr>
      <tr><td style="padding:4px 16px 4px 0;color:#7af">Double-click point</td><td>Delete control point</td></tr>
    </table>
  `
  const closeBtn = mkBtn('Close', () => { controlsPopup.style.display = 'none' })
  closeBtn.style.cssText += ';margin-top:16px;width:100%'
  controlsCard.appendChild(closeBtn)
  controlsPopup.appendChild(controlsCard)
  controlsPopup.addEventListener('click', (e) => { if (e.target === controlsPopup) controlsPopup.style.display = 'none' })
  overlay.appendChild(controlsPopup)

  // ---- body ----
  const body = document.createElement('div')
  body.className = 'editor-body'
  overlay.appendChild(body)

  const sidebar = document.createElement('div')
  sidebar.className = 'editor-sidebar'
  body.appendChild(sidebar)

  // ---- preview area ----
  const previewWrap = document.createElement('div')
  previewWrap.className = 'editor-preview'
  body.appendChild(previewWrap)

  // view toggle header
  const previewHeader = document.createElement('div')
  previewHeader.className = 'preview-header'
  previewWrap.appendChild(previewHeader)

  // canvas wrap (takes remaining space)
  const canvasWrap = document.createElement('div')
  canvasWrap.className = 'preview-canvas-wrap'
  previewWrap.appendChild(canvasWrap)
  const previewCanvas = document.createElement('canvas')
  canvasWrap.appendChild(previewCanvas)

  // game zoom bar (shown only in game mode)
  const gameZoomBar = document.createElement('div')
  gameZoomBar.className = 'game-zoom-bar'
  gameZoomBar.style.display = 'none'
  previewWrap.appendChild(gameZoomBar)

  // ---- view mode state ----
  let viewMode: 'global' | 'game' = 'global'
  let gvCamX = 0, gvCamY = 0, gvZoom = 1.0

  const globalViewBtn = makeViewBtn('Global', 'global')
  const gameViewBtn   = makeViewBtn('Game',   'game')
  previewHeader.append(globalViewBtn, gameViewBtn)

  function makeViewBtn(label: string, mode: 'global' | 'game'): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'view-btn' + (viewMode === mode ? ' active' : '')
    btn.textContent = label
    btn.addEventListener('click', () => {
      if (viewMode === mode) return
      viewMode = mode
      globalViewBtn.className = 'view-btn' + (viewMode === 'global' ? ' active' : '')
      gameViewBtn.className   = 'view-btn' + (viewMode === 'game'   ? ' active' : '')
      gameZoomBar.style.display = viewMode === 'game' ? 'flex' : 'none'
      if (viewMode === 'game') initGameCamera()
      drawPreview()
    })
    return btn
  }

  function initGameCamera() {
    const cw = canvasWrap.clientWidth || 800, ch = canvasWrap.clientHeight || 400
    gvCamX = Math.max(0, editCourse.teeBackX - cw * 0.25 / gvZoom)
    gvCamY = Math.max(0, editCourse.baseGround - ch * 0.55 / gvZoom)
  }

  // game zoom slider
  const gzText = document.createElement('span')
  gzText.style.cssText = 'color:#666;font:12px monospace'
  gzText.textContent = 'zoom'
  const gzSlider = document.createElement('input')
  gzSlider.type = 'range'; gzSlider.min = '0.15'; gzSlider.max = '2'; gzSlider.step = '0.05'; gzSlider.value = '1'
  gzSlider.style.width = '140px'
  const gzLabel = document.createElement('span')
  gzLabel.style.cssText = 'color:#888;font:12px monospace;min-width:44px'
  gzLabel.textContent = '1.00×'
  gzSlider.addEventListener('input', () => {
    const oldZ = gvZoom
    gvZoom = parseFloat(gzSlider.value)
    gzLabel.textContent = gvZoom.toFixed(2) + '×'
    const cw = canvasWrap.clientWidth || 800, ch = canvasWrap.clientHeight || 400
    gvCamX += cw * (1/oldZ - 1/gvZoom) / 2
    gvCamY += ch * (1/oldZ - 1/gvZoom) / 2
    drawPreview()
  })
  gameZoomBar.append(gzText, gzSlider, gzLabel)

  // scroll wheel zoom in game view
  canvasWrap.addEventListener('wheel', (e) => {
    if (viewMode !== 'game') return
    e.preventDefault()
    const rect = previewCanvas.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top
    const wX = cx / gvZoom + gvCamX, wY = cy / gvZoom + gvCamY
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    gvZoom = Math.max(0.15, Math.min(2, gvZoom * factor))
    gvCamX = wX - cx / gvZoom
    gvCamY = wY - cy / gvZoom
    gzSlider.value = String(gvZoom.toFixed(2))
    gzLabel.textContent = gvZoom.toFixed(2) + '×'
    drawPreview()
  }, { passive: false })

  // ---- working copy ----
  let editCourse: Course = structuredClone(opts.getCourse())

  // ---- water pool cache ----
  // Flood-fill bounds only change when editCourse's content does, so this is
  // rebuilt in emit()/rebuild() (the content-change choke points) instead of
  // on every redraw — panning, zooming, and resizing redraw constantly but
  // never need to recompute this. The fill itself is a flat rectangle down to
  // worldH rather than a hand-traced terrain curve: the ground is already
  // solid-filled down to worldH everywhere, so a flat bottom hides it just as
  // well — and unlike a traced curve, it can't self-intersect into an
  // unfillable shape on steep or overshooting (spline) terrain.
  interface WaterPoolGeom { left: number; right: number; level: number }
  let waterPools: WaterPoolGeom[] = []

  function rebuildWaterPools() {
    const segs = buildSegments(editCourse)
    const spCoeffs = buildSpline(editCourse.controlPoints)
    const ptY = makePtY(segs, spCoeffs)
    waterPools = []
    for (const hz of editCourse.hazards) {
      if (hz.kind !== 'water' || hz.level == null) continue
      const bounds = waterPoolBounds(hz.cx, hz.level, ptY, editCourse.worldW)
      if (!bounds) continue
      waterPools.push({ left: bounds.left, right: bounds.right, level: hz.level })
    }
  }
  rebuildWaterPools()

  // Game-view minimap bounds (screen coords) — shared between drawGame() and
  // the mouse handlers below so clicking/dragging it can pan the camera.
  const GAME_MINIMAP = { x: 8, y: 8, w: 160, h: 40 }

  // ---- interaction state ----
  let dragIdx = -1
  let panDragging = false
  let panLast = { x: 0, y: 0 }
  let miniDragging = false
  let spaceHeld = false

  // Space = temporary pan tool (same convention as Figma/Illustrator/Inkscape).
  // Only active while the editor overlay is visible.
  window.addEventListener('keydown', (e) => {
    if (overlay.style.display === 'none') return
    if (e.key === ' ' && !e.repeat) {
      spaceHeld = true
      previewCanvas.style.cursor = 'grab'
      e.preventDefault()
    }
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceHeld = false
      if (!panDragging) previewCanvas.style.cursor = 'default'
    }
  })
  // Set while a water trap's Anchor X control has focus, so its position can
  // be highlighted in the preview; cleared on blur.
  let activeXHazard: Hazard | null = null

  function drawActiveXMarker(ctx: CanvasRenderingContext2D, tx: (x: number) => number, ty: (y: number) => number) {
    if (!activeXHazard) return
    const x = tx(activeXHazard.cx)
    ctx.save()
    ctx.strokeStyle = 'rgba(255,40,40,0.9)'; ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.beginPath(); ctx.moveTo(x, ty(0)); ctx.lineTo(x, ty(editCourse.worldH)); ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }

  // ---- helpers ----
  function mkBtn(label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'editor-btn' + (extraClass ? ' ' + extraClass : '')
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  function mksec(title: string, startCollapsed = false): { sec: HTMLElement; content: HTMLElement } {
    const sec = document.createElement('div'); sec.className = 'editor-section'
    const hdr = document.createElement('div'); hdr.className = 'section-header'
    const colBtn = document.createElement('button'); colBtn.className = 'collapse-btn'
    colBtn.textContent = startCollapsed ? '+' : '−'
    const lbl = document.createElement('span'); lbl.textContent = title
    hdr.append(colBtn, lbl)
    const content = document.createElement('div'); content.className = 'section-content'
    if (startCollapsed) content.style.display = 'none'
    colBtn.addEventListener('click', () => {
      const hidden = content.style.display === 'none'
      content.style.display = hidden ? '' : 'none'
      colBtn.textContent = hidden ? '−' : '+'
    })
    sec.append(hdr, content)
    return { sec, content }
  }

  function sliderRow(
    label: string, value: number, min: number, max: number, step: number,
    onChange: (v: number) => void, fmt?: (v: number) => string,
  ): HTMLElement {
    const row = document.createElement('div'); row.className = 'slider-row'
    const lbl = document.createElement('span'); lbl.className = 'slider-label'; lbl.textContent = label
    const slider = document.createElement('input')
    slider.type = 'range'; slider.min = String(min); slider.max = String(max); slider.step = String(step); slider.value = String(value)
    const numFmt = fmt ?? ((v: number) => String(Math.round(v)))
    const num = document.createElement('input'); num.type = 'number'; num.className = 'slider-num'
    num.min = String(min); num.max = String(max); num.step = String(step); num.value = numFmt(value)
    slider.addEventListener('input', () => { const v = parseFloat(slider.value); num.value = numFmt(v); onChange(v) })
    num.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, parseFloat(num.value) || 0))
      slider.value = String(v); num.value = numFmt(v); onChange(v)
    })
    row.append(lbl, slider, num)
    return row
  }

  function colorRow(label: string, value: string, onChange: (v: string) => void): HTMLElement {
    const row = document.createElement('div'); row.className = 'slider-row'
    const lbl = document.createElement('span'); lbl.className = 'slider-label'; lbl.textContent = label
    const picker = document.createElement('input'); picker.type = 'color'; picker.className = 'color-picker'; picker.value = value
    picker.addEventListener('input', () => onChange(picker.value))
    row.append(lbl, picker)
    return row
  }

  function toggleBtn(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLButtonElement {
    let value = initial
    const btn = document.createElement('button') as HTMLButtonElement
    const refresh = () => { btn.className = 'editor-btn mode-toggle' + (value ? ' active' : '') }
    btn.textContent = label
    btn.addEventListener('click', () => { value = !value; refresh(); onChange(value) })
    refresh()
    return btn
  }

  // ---- global view metrics ----
  // Uses a uniform scale (min of x/y fit) so the world isn't vertically stretched
  // to fill a landscape canvas.
  function globalMetrics() {
    const cw = canvasWrap.clientWidth || 400
    const ch = canvasWrap.clientHeight || 300
    const pad = 16
    const fitSx = (cw - pad * 2) / editCourse.worldW
    const fitSy = (ch - pad * 2) / editCourse.worldH
    const s = Math.min(fitSx, fitSy)
    const worldPxW = editCourse.worldW * s
    const worldPxH = editCourse.worldH * s
    const ox = (cw - worldPxW) / 2   // world left edge in canvas px
    const oy = (ch - worldPxH) / 2   // world top edge in canvas px
    return {
      cw, ch, s, ox, oy, worldPxW, worldPxH,
      tx: (x: number) => ox + x * s,
      ty: (y: number) => oy + y * s,
      wx: (cx: number) => (cx - ox) / s,
      wy: (cy: number) => (cy - oy) / s,
    }
  }

  // ---- composite terrain Y ----
  function makePtY(segs: ReturnType<typeof buildSegments>, spCoeffs: ReturnType<typeof buildSpline>) {
    return (x: number): number => {
      const s = editCourse.useSpline, w = editCourse.useWaves
      if (s && w) return splineY(x, spCoeffs) + terrainY(x, segs) - editCourse.baseGround
      if (s)      return splineY(x, spCoeffs)
      if (w)      return terrainY(x, segs)
      return editCourse.baseGround
    }
  }

  // ---- emit ----
  function emit() { rebuildWaterPools(); drawPreview(); opts.onCourseChange(structuredClone(editCourse)) }

  // ---- draw ----
  function drawPreview() {
    viewMode === 'game' ? drawGame() : drawGlobal()
  }

  // Water-trap overlay for the editor preview: floods outward from each trap's
  // anchor (`cx`) until the terrain rises above `level`, then fills the gap
  // between that surface line and the real terrain curve — so the pool always
  // conforms to the valley it's sitting in. tx/ty map world→canvas (the
  // identity in game view, which already applies the camera transform).
  function drawWaterTrapsPreview(
    ctx: CanvasRenderingContext2D,
    tx: (x: number) => number,
    ty: (y: number) => number,
  ) {
    const th = editCourse.theme
    for (const { left, right, level } of waterPools) {
      ctx.beginPath()
      ctx.moveTo(tx(left), ty(level))
      ctx.lineTo(tx(right), ty(level))
      ctx.lineTo(tx(right), ty(editCourse.worldH))
      ctx.lineTo(tx(left), ty(editCourse.worldH))
      ctx.closePath()
      ctx.fillStyle = hexWithAlpha(th.waterFill, 0.85)
      ctx.fill()
      ctx.strokeStyle = hexWithAlpha(th.waterLine, 0.7); ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(tx(left), ty(level)); ctx.lineTo(tx(right), ty(level)); ctx.stroke()
    }
  }

  function drawGlobal() {
    const { cw, ch, s, ox, oy, worldPxW, worldPxH, tx, ty } = globalMetrics()
    if (previewCanvas.width !== cw) previewCanvas.width = cw
    if (previewCanvas.height !== ch) previewCanvas.height = ch
    const ctx = previewCanvas.getContext('2d')!
    ctx.clearRect(0, 0, cw, ch)
    const th = editCourse.theme
    const segs = buildSegments(editCourse)
    const spCoeffs = buildSpline(editCourse.controlPoints)
    const ptY = makePtY(segs, spCoeffs)

    // sky clipped to world rect
    ctx.save()
    ctx.beginPath(); ctx.rect(ox, oy, worldPxW, worldPxH); ctx.clip()
    const skyGrad = ctx.createLinearGradient(ox, oy, ox, oy + worldPxH)
    skyGrad.addColorStop(0, th.skyTop); skyGrad.addColorStop(1, th.skyBottom)
    ctx.fillStyle = skyGrad; ctx.fillRect(ox, oy, worldPxW, worldPxH)
    ctx.restore()

    // world boundary
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1
    ctx.strokeRect(ox, oy, worldPxW, worldPxH)

    // spline curve
    if (editCourse.useSpline && spCoeffs.length > 0) {
      ctx.beginPath()
      for (let x = 0; x <= editCourse.worldW; x += 8) {
        const y = splineY(x, spCoeffs)
        x === 0 ? ctx.moveTo(tx(x), ty(y)) : ctx.lineTo(tx(x), ty(y))
      }
      ctx.strokeStyle = 'rgba(80,160,255,0.55)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
      ctx.stroke(); ctx.setLineDash([])
    }

    // segment boundary lines
    if (editCourse.useWaves) {
      ctx.strokeStyle = 'rgba(80,140,255,0.25)'; ctx.setLineDash([4, 4])
      let segX = 0
      for (let i = 0; i < segs.length - 1; i++) {
        segX += segs[i].length
        ctx.beginPath(); ctx.moveTo(tx(segX), oy); ctx.lineTo(tx(segX), oy + worldPxH)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // Water is drawn before the terrain, as a plain rectangle — the terrain
    // fill (opaque down to worldH) then paints over whatever part of that
    // rectangle sits above the real ground, giving a shoreline that exactly
    // follows the terrain's contour for free instead of a hard rectangular edge.
    drawWaterTrapsPreview(ctx, tx, ty)

    // terrain fill
    ctx.beginPath(); ctx.moveTo(tx(0), ty(ptY(0)))
    for (let x = 5; x <= editCourse.worldW; x += 5) ctx.lineTo(tx(x), ty(ptY(x)))
    ctx.lineTo(tx(editCourse.worldW), ty(editCourse.worldH)); ctx.lineTo(tx(0), ty(editCourse.worldH))
    ctx.closePath(); ctx.fillStyle = th.groundFill; ctx.fill()

    // terrain line
    ctx.beginPath(); ctx.moveTo(tx(0), ty(ptY(0)))
    for (let x = 5; x <= editCourse.worldW; x += 5) ctx.lineTo(tx(x), ty(ptY(x)))
    ctx.strokeStyle = th.groundLine
    ctx.lineWidth = Math.max(1, th.groundLineW * s * 0.8); ctx.stroke()

    drawActiveXMarker(ctx, tx, ty)

    // segment labels
    if (editCourse.useWaves) {
      ctx.fillStyle = 'rgba(80,140,255,0.55)'; ctx.font = '10px monospace'; ctx.textAlign = 'center'
      let segX = 0
      for (let i = 0; i < segs.length; i++) {
        ctx.fillText(`S${i+1}`, tx(segX + segs[i].length / 2), oy + 12); segX += segs[i].length
      }
      ctx.textAlign = 'left'
    }

    // tees
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    for (const teeX of [editCourse.teeBackX, editCourse.teeForwardX])
      ctx.fillRect(tx(teeX) - 2, ty(ptY(teeX)) - 6 * s, 4, 6 * s)

    // hole flag
    const hgY = ptY(editCourse.holeX)
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(tx(editCourse.holeX), ty(hgY)); ctx.lineTo(tx(editCourse.holeX), ty(hgY) - 14); ctx.stroke()
    ctx.fillStyle = '#e44'; ctx.beginPath()
    ctx.moveTo(tx(editCourse.holeX), ty(hgY) - 14)
    ctx.lineTo(tx(editCourse.holeX) + 7, ty(hgY) - 10)
    ctx.lineTo(tx(editCourse.holeX), ty(hgY) - 6); ctx.closePath(); ctx.fill()

    // base ground dashed
    ctx.strokeStyle = 'rgba(255,255,100,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5])
    ctx.beginPath(); ctx.moveTo(tx(0), ty(editCourse.baseGround)); ctx.lineTo(tx(editCourse.worldW), ty(editCourse.baseGround))
    ctx.stroke(); ctx.setLineDash([])

    // control points
    if (editCourse.useSpline) {
      for (let i = 0; i < editCourse.controlPoints.length; i++) {
        const pt = editCourse.controlPoints[i]
        ctx.beginPath(); ctx.arc(tx(pt.x), ty(pt.y), 5, 0, Math.PI * 2)
        ctx.fillStyle = dragIdx === i ? '#fff' : '#4af'; ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
      }
    }
  }

  function drawGame() {
    const cw = canvasWrap.clientWidth || 800
    const ch = canvasWrap.clientHeight || 400
    if (previewCanvas.width !== cw) previewCanvas.width = cw
    if (previewCanvas.height !== ch) previewCanvas.height = ch
    const ctx = previewCanvas.getContext('2d')!
    const th = editCourse.theme
    const segs = buildSegments(editCourse)
    const spCoeffs = buildSpline(editCourse.controlPoints)
    const ptY = makePtY(segs, spCoeffs)
    const vW = cw / gvZoom, vH = ch / gvZoom

    // void outside world
    ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, cw, ch)

    ctx.save()
    ctx.scale(gvZoom, gvZoom)
    ctx.translate(-gvCamX, -gvCamY)

    // clip to world rect
    ctx.beginPath(); ctx.rect(0, 0, editCourse.worldW, editCourse.worldH); ctx.clip()

    // sky — gradient spans visible viewport so it stays screen-fixed when panning
    const sky = ctx.createLinearGradient(0, gvCamY, 0, gvCamY + vH)
    sky.addColorStop(0, th.skyTop); sky.addColorStop(1, th.skyBottom)
    ctx.fillStyle = sky; ctx.fillRect(0, 0, editCourse.worldW, editCourse.worldH)

    // sun (fixed screen position → world position via camera)
    const sunX = gvCamX + vW * 0.80, sunY = gvCamY + vH * 0.17, ss = th.sunSize / gvZoom
    ctx.beginPath(); ctx.arc(sunX, sunY, ss * 2,   0, Math.PI * 2); ctx.fillStyle = th.sunRing2; ctx.fill()
    ctx.beginPath(); ctx.arc(sunX, sunY, ss * 1.5, 0, Math.PI * 2); ctx.fillStyle = th.sunRing1; ctx.fill()
    ctx.beginPath(); ctx.arc(sunX, sunY, ss,       0, Math.PI * 2); ctx.fillStyle = th.sunColor;  ctx.fill()

    // back mountains (p=0.06)
    ;(function() {
      const p = 0.06, shift = gvCamX * (1 - p)
      const es = gvCamX * p - 20, ee = gvCamX * p + vW + 20
      const bY = th.mountain1Y * editCourse.worldH
      ctx.fillStyle = th.mountain1; ctx.beginPath(); let first = true
      for (let ex = es; ex <= ee; ex += 6) {
        const wx = ex + shift
        const h = Math.pow(Math.abs(Math.sin(wx/613+0.0)),0.55)*180
                + Math.pow(Math.abs(Math.sin(wx/379+1.83)),0.70)*90
                + Math.abs(Math.sin(wx/131+2.40))*28
        first ? ctx.moveTo(wx, bY-h) : ctx.lineTo(wx, bY-h); first = false
      }
      ctx.lineTo(ee+shift, editCourse.worldH); ctx.lineTo(es+shift, editCourse.worldH); ctx.closePath(); ctx.fill()
    })()

    // front mountains (p=0.22)
    ;(function() {
      const p = 0.22, shift = gvCamX * (1 - p)
      const es = gvCamX * p - 20, ee = gvCamX * p + vW + 20
      const bY = th.mountain2Y * editCourse.worldH
      ctx.fillStyle = th.mountain2; ctx.beginPath(); let first = true
      for (let ex = es; ex <= ee; ex += 6) {
        const wx = ex + shift
        const h = Math.pow(Math.abs(Math.sin(wx/431+0.60)),0.50)*130
                + Math.pow(Math.abs(Math.sin(wx/251+1.10)),0.65)*55
                + Math.abs(Math.sin(wx/89+2.90))*18
        first ? ctx.moveTo(wx, bY-h) : ctx.lineTo(wx, bY-h); first = false
      }
      ctx.lineTo(ee+shift, editCourse.worldH); ctx.lineTo(es+shift, editCourse.worldH); ctx.closePath(); ctx.fill()
    })()

    drawWaterTrapsPreview(ctx, x => x, y => y)

    // terrain fill
    ctx.beginPath(); ctx.moveTo(0, ptY(0))
    for (let x = 5; x <= editCourse.worldW; x += 5) ctx.lineTo(x, ptY(x))
    ctx.lineTo(editCourse.worldW, editCourse.worldH); ctx.lineTo(0, editCourse.worldH)
    ctx.closePath(); ctx.fillStyle = th.groundFill; ctx.fill()

    // terrain line
    ctx.beginPath(); ctx.moveTo(0, ptY(0))
    for (let x = 5; x <= editCourse.worldW; x += 5) ctx.lineTo(x, ptY(x))
    ctx.strokeStyle = th.groundLine; ctx.lineWidth = th.groundLineW; ctx.stroke()

    drawActiveXMarker(ctx, x => x, y => y)

    // world border
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 6 / gvZoom
    ctx.strokeRect(0, 0, editCourse.worldW, editCourse.worldH)

    // tees
    ctx.fillStyle = '#fff'
    for (const tX of [editCourse.teeBackX, editCourse.teeForwardX])
      ctx.fillRect(tX - 3, ptY(tX) - 10, 6, 10)

    // hole flag
    const fX = editCourse.holeX + 15, fY = ptY(editCourse.holeX + 15)
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(fX, fY); ctx.lineTo(fX, fY - 55); ctx.stroke()
    ctx.fillStyle = '#e44'; ctx.beginPath()
    ctx.moveTo(fX, fY-55); ctx.lineTo(fX+24, fY-44); ctx.lineTo(fX, fY-33); ctx.closePath(); ctx.fill()

    // spline curve + control points
    if (editCourse.useSpline) {
      ctx.beginPath()
      for (let x = 0; x <= editCourse.worldW; x += 8) {
        const y = splineY(x, spCoeffs)
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.strokeStyle = 'rgba(80,160,255,0.40)'; ctx.lineWidth = 1/gvZoom
      ctx.setLineDash([4/gvZoom, 3/gvZoom]); ctx.stroke(); ctx.setLineDash([])
      for (let i = 0; i < editCourse.controlPoints.length; i++) {
        const pt = editCourse.controlPoints[i]
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 6/gvZoom, 0, Math.PI*2)
        ctx.fillStyle = dragIdx === i ? '#fff' : '#4af'; ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5/gvZoom; ctx.stroke()
      }
    }

    ctx.restore()

    // minimap (screen coords)
    const { x: mx, y: my, w: mw, h: mh } = GAME_MINIMAP
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(mx, my, mw, mh)
    ctx.strokeStyle = '#444'; ctx.lineWidth = 1; ctx.strokeRect(mx, my, mw, mh)
    const mmx = (wx: number) => mx + (wx / editCourse.worldW) * mw
    const mmy = (wy: number) => my + (wy / editCourse.worldH) * mh
    ctx.strokeStyle = '#556644'; ctx.lineWidth = 1; ctx.beginPath()
    for (let x = 0; x <= editCourse.worldW; x += 60)
      x === 0 ? ctx.moveTo(mmx(x), mmy(ptY(x))) : ctx.lineTo(mmx(x), mmy(ptY(x)))
    ctx.stroke()
    const rx = mmx(gvCamX), ry = mmy(gvCamY)
    const rw = (vW / editCourse.worldW) * mw, rh = (vH / editCourse.worldH) * mh
    ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(rx, ry, rw, rh)
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1; ctx.strokeRect(rx, ry, rw, rh)
    ctx.fillStyle = '#e44'; ctx.beginPath()
    ctx.arc(mmx(editCourse.holeX), mmy(ptY(editCourse.holeX)), 2, 0, Math.PI*2); ctx.fill()
  }

  // ---- canvas mouse events ----
  previewCanvas.addEventListener('mousedown', (e) => {
    const rect = previewCanvas.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top

    if (viewMode === 'game') {
      // Minimap — always takes priority so it can't accidentally add a point.
      const { x: mx, y: my, w: mw, h: mh } = GAME_MINIMAP
      if (cx >= mx && cx <= mx + mw && cy >= my && cy <= my + mh) {
        miniDragging = true; panToMini(cx, cy); drawPreview(); return
      }
      // Space held → pan, regardless of spline mode or what's under the cursor.
      if (spaceHeld) { startPan(cx, cy); return }
      if (!editCourse.useSpline) return
      // Spline editing: hit-test existing points first, then add on empty click.
      const closest = findClosestCp(cx, cy, (pt) => ({
        sx: (pt.x - gvCamX) * gvZoom, sy: (pt.y - gvCamY) * gvZoom,
      }), 10)
      if (closest !== -1) {
        dragIdx = closest
      } else {
        const newPt: ControlPoint = { x: cx / gvZoom + gvCamX, y: cy / gvZoom + gvCamY }
        editCourse.controlPoints.push(newPt)
        editCourse.controlPoints.sort((a, b) => a.x - b.x)
        emit()
      }
    } else {
      // global view
      if (!editCourse.useSpline) return
      const { tx, ty, wx, wy } = globalMetrics()
      const closest = findClosestCp(cx, cy, (pt) => ({ sx: tx(pt.x), sy: ty(pt.y) }), 10)
      if (closest !== -1) { dragIdx = closest; return }
      // add new point (unclamped — can be outside world bounds)
      const newPt: ControlPoint = { x: wx(cx), y: wy(cy) }
      editCourse.controlPoints.push(newPt)
      editCourse.controlPoints.sort((a, b) => a.x - b.x)
      emit()
    }
  })

  previewCanvas.addEventListener('mousemove', (e) => {
    const rect = previewCanvas.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top

    if (viewMode === 'game') {
      if (miniDragging) {
        panToMini(cx, cy)
        drawPreview()
        previewCanvas.style.cursor = 'grabbing'
        return
      }
      if (dragIdx !== -1) {
        editCourse.controlPoints[dragIdx].x = cx / gvZoom + gvCamX
        editCourse.controlPoints[dragIdx].y = cy / gvZoom + gvCamY
        editCourse.controlPoints.sort((a, b) => a.x - b.x)
        emit()
      } else if (panDragging) {
        const dx = (cx - panLast.x) / gvZoom, dy = (cy - panLast.y) / gvZoom
        gvCamX -= dx; gvCamY -= dy
        panLast = { x: cx, y: cy }
        drawPreview()
      }
      previewCanvas.style.cursor = (panDragging || miniDragging) ? 'grabbing'
        : dragIdx !== -1 ? 'grabbing'
        : spaceHeld ? 'grab'
        : isNearAnyCp(cx, cy, (pt) => ({ sx: (pt.x-gvCamX)*gvZoom, sy: (pt.y-gvCamY)*gvZoom })) ? 'grab'
        : 'crosshair'
    } else {
      if (!editCourse.useSpline) return
      const { tx, ty, wx, wy } = globalMetrics()
      if (dragIdx !== -1) {
        editCourse.controlPoints[dragIdx].x = wx(cx)
        editCourse.controlPoints[dragIdx].y = wy(cy)
        editCourse.controlPoints.sort((a, b) => a.x - b.x)
        emit()
      }
      previewCanvas.style.cursor = dragIdx !== -1 ? 'grabbing'
        : isNearAnyCp(cx, cy, (pt) => ({ sx: tx(pt.x), sy: ty(pt.y) })) ? 'grab'
        : 'crosshair'
    }
  })

  previewCanvas.addEventListener('mouseup',    () => { dragIdx = -1; panDragging = false; miniDragging = false })
  previewCanvas.addEventListener('mouseleave', () => { dragIdx = -1; panDragging = false; miniDragging = false })

  previewCanvas.addEventListener('dblclick', (e) => {
    if (!editCourse.useSpline || editCourse.controlPoints.length <= 2) return
    const rect = previewCanvas.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top
    const toScreen = viewMode === 'game'
      ? (pt: ControlPoint) => ({ sx: (pt.x - gvCamX) * gvZoom, sy: (pt.y - gvCamY) * gvZoom })
      : (pt: ControlPoint) => { const { tx, ty } = globalMetrics(); return { sx: tx(pt.x), sy: ty(pt.y) } }
    const idx = findClosestCp(cx, cy, toScreen, 12)
    if (idx !== -1) { editCourse.controlPoints.splice(idx, 1); emit() }
  })

  function startPan(cx: number, cy: number) { panDragging = true; panLast = { x: cx, y: cy } }

  // Centers the game-view camera on the world position the minimap point
  // (cx, cy) — in canvas/screen coordinates — corresponds to.
  function panToMini(cx: number, cy: number) {
    const { x: mx, y: my, w: mw, h: mh } = GAME_MINIMAP
    const worldX = ((cx - mx) / mw) * editCourse.worldW
    const worldY = ((cy - my) / mh) * editCourse.worldH
    const cw = canvasWrap.clientWidth || 800, ch = canvasWrap.clientHeight || 400
    gvCamX = worldX - (cw / gvZoom) / 2
    gvCamY = worldY - (ch / gvZoom) / 2
  }

  function findClosestCp(
    cx: number, cy: number,
    toScreen: (pt: ControlPoint) => { sx: number; sy: number },
    threshold: number,
  ): number {
    let best = -1, bestD = threshold
    for (let i = 0; i < editCourse.controlPoints.length; i++) {
      const { sx, sy } = toScreen(editCourse.controlPoints[i])
      const d = Math.hypot(sx - cx, sy - cy)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  function isNearAnyCp(
    cx: number, cy: number,
    toScreen: (pt: ControlPoint) => { sx: number; sy: number },
  ): boolean {
    return findClosestCp(cx, cy, toScreen, 10) !== -1
  }

  // ---- build sidebar ----
  function rebuild() {
    rebuildWaterPools() // covers reassigning editCourse wholesale (e.g. show()) without an emit()
    sidebar.innerHTML = ''
    buildWorldSection()
    buildHoleTeeSection()
    buildModeSection()
    if (editCourse.useSpline) buildSplineSection()
    if (editCourse.useWaves) buildSegmentsSection()
    buildHazardsSection()
    buildThemeSection()
    drawPreview()
  }

  function buildWorldSection() {
    const { sec, content } = mksec('World')
    content.appendChild(sliderRow('Width',  editCourse.worldW,     500, 8000, 50,  v => { editCourse.worldW    = v; emit() }))
    content.appendChild(sliderRow('Height', editCourse.worldH,     400, 2000, 50,  v => { editCourse.worldH    = v; emit() }))
    content.appendChild(sliderRow('Base Y', editCourse.baseGround,  50, editCourse.worldH - 50, 10, v => { editCourse.baseGround = v; emit() }))
    sidebar.appendChild(sec)
  }

  function buildHoleTeeSection() {
    const { sec, content } = mksec('Hole & Tees')
    content.appendChild(sliderRow('Back tee X', editCourse.teeBackX,    0, editCourse.worldW, 25, v => { editCourse.teeBackX    = v; emit() }))
    content.appendChild(sliderRow('Fwd tee X',  editCourse.teeForwardX, 0, editCourse.worldW, 25, v => { editCourse.teeForwardX = v; emit() }))
    content.appendChild(sliderRow('Hole X',     editCourse.holeX,       0, editCourse.worldW, 25, v => { editCourse.holeX       = v; emit() }))
    sidebar.appendChild(sec)
  }

  function buildModeSection() {
    const { sec, content } = mksec('Terrain Mode')
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;padding:4px 0'
    row.appendChild(toggleBtn('Waves',  editCourse.useWaves,  v => { editCourse.useWaves  = v; emit(); rebuild() }))
    row.appendChild(toggleBtn('Spline', editCourse.useSpline, v => { editCourse.useSpline = v; emit(); rebuild() }))
    content.appendChild(row)
    sidebar.appendChild(sec)
  }

  function buildSplineSection() {
    const { sec, content } = mksec('Spline Points')
    const countEl = document.createElement('div'); countEl.className = 'spline-count'
    countEl.textContent = `${editCourse.controlPoints.length} point${editCourse.controlPoints.length !== 1 ? 's' : ''} (can be outside world bounds)`
    content.appendChild(countEl)
    content.appendChild(mkBtn('Reset to Default', () => {
      editCourse.controlPoints = structuredClone(DEFAULT_COURSE.controlPoints)
      emit(); rebuild()
    }))
    sidebar.appendChild(sec)
  }

  function buildSegmentsSection() {
    const { sec, content } = mksec('Terrain Waves')
    content.appendChild(mkBtn('+ Add Segment', () => {
      editCourse.segments.push({ length: 800, waves: [{ amplitude: 40, period: 400, phase: 0 }] })
      emit(); rebuild()
    }, 'add-btn'))
    editCourse.segments.forEach((seg, si) => content.appendChild(buildSegmentEl(seg, si)))
    sidebar.appendChild(sec)
  }

  function buildSegmentEl(seg: TerrainSegment, si: number): HTMLElement {
    const el = document.createElement('div'); el.className = 'editor-segment'
    const hdr = document.createElement('div'); hdr.className = 'segment-header'
    const name = document.createElement('span'); name.textContent = `Segment ${si + 1}`
    const del = mkBtn('×', () => {
      if (editCourse.segments.length <= 1) return
      editCourse.segments.splice(si, 1); emit(); rebuild()
    }, 'del-btn')
    hdr.append(name, del); el.appendChild(hdr)
    el.appendChild(sliderRow('Length', seg.length, 50, 6000, 50, v => { seg.length = v; emit() }))
    seg.waves.forEach((wave, wi) => el.appendChild(buildWaveEl(wave, si, wi)))
    el.appendChild(mkBtn('+ Wave', () => { seg.waves.push({ amplitude: 20, period: 200, phase: 0 }); emit(); rebuild() }, 'add-btn'))
    return el
  }

  function buildWaveEl(wave: TerrainWave, si: number, wi: number): HTMLElement {
    const el = document.createElement('div'); el.className = 'editor-wave'
    const hdr = document.createElement('div'); hdr.className = 'wave-header'
    const name = document.createElement('span'); name.textContent = `Wave ${wi + 1}`
    const del = mkBtn('×', () => {
      const seg = editCourse.segments[si]
      if (seg.waves.length <= 1) return
      seg.waves.splice(wi, 1); emit(); rebuild()
    }, 'del-btn')
    hdr.append(name, del); el.appendChild(hdr)
    el.appendChild(sliderRow('Amp',    wave.amplitude, 0,        300,     5,    v => { wave.amplitude = v; emit() }))
    el.appendChild(sliderRow('Period', wave.period,    30,       3000,    25,   v => { wave.period    = v; emit() }))
    el.appendChild(sliderRow('Phase',  wave.phase,    -Math.PI,  Math.PI, 0.05, v => { wave.phase     = v; emit() }, v => v.toFixed(2)))
    return el
  }

  function buildHazardsSection() {
    const { sec, content } = mksec('Water Traps')
    content.appendChild(mkBtn('+ Add Water Trap', () => {
      const cx = Math.round(editCourse.worldW / 2)
      const segs = buildSegments(editCourse)
      const spCoeffs = buildSpline(editCourse.controlPoints)
      const ptY = makePtY(segs, spCoeffs)
      editCourse.hazards.push({ kind: 'water', cx, w: 0, h: 0, level: ptY(cx) - 20 })
      emit(); rebuild()
    }, 'add-btn'))
    let n = 0
    editCourse.hazards.forEach((hz, hi) => {
      if (hz.kind !== 'water') return
      content.appendChild(buildWaterTrapEl(hz, hi, ++n))
    })
    sidebar.appendChild(sec)
  }

  function buildWaterTrapEl(hz: Hazard, hi: number, num: number): HTMLElement {
    const el = document.createElement('div'); el.className = 'editor-segment'
    const hdr = document.createElement('div'); hdr.className = 'segment-header'
    const name = document.createElement('span'); name.textContent = `Water Trap ${num}`
    const del = mkBtn('×', () => { editCourse.hazards.splice(hi, 1); emit(); rebuild() }, 'del-btn')
    hdr.append(name, del); el.appendChild(hdr)
    const xRow = sliderRow('Anchor X', hz.cx, 0, editCourse.worldW, 25, v => { hz.cx = v; emit() })
    for (const inp of xRow.querySelectorAll('input')) {
      inp.addEventListener('focus', () => { activeXHazard = hz; drawPreview() })
      inp.addEventListener('blur', () => { if (activeXHazard === hz) { activeXHazard = null; drawPreview() } })
    }
    el.appendChild(xRow)
    // Stored as a Y coordinate (smaller = higher up), but the control is
    // inverted to read as a height-from-the-bottom so dragging right raises
    // the water level, matching how a "more water" slider should feel.
    el.appendChild(sliderRow('Water Level', editCourse.worldH - (hz.level ?? editCourse.baseGround), 0, editCourse.worldH, 5,
      v => { hz.level = editCourse.worldH - v; emit() }))
    return el
  }

  function buildThemeSection() {
    const { sec, content } = mksec('Theme & Colors', true)
    const th = editCourse.theme
    function colorKey(label: string, key: keyof CourseTheme) {
      content.appendChild(colorRow(label, th[key] as string, v => {
        (editCourse.theme as unknown as Record<string, unknown>)[key] = v; emit()
      }))
    }
    function numKey(label: string, key: keyof CourseTheme, min: number, max: number, step: number) {
      content.appendChild(sliderRow(label, th[key] as number, min, max, step, v => {
        (editCourse.theme as unknown as Record<string, unknown>)[key] = v; emit()
      }))
    }
    colorKey('Sky top',     'skyTop');    colorKey('Sky bottom',  'skyBottom')
    colorKey('Mountain 1',  'mountain1'); numKey  ('Mtn 1 Y',    'mountain1Y', 0, 1, 0.01)
    colorKey('Mountain 2',  'mountain2'); numKey  ('Mtn 2 Y',    'mountain2Y', 0, 1, 0.01)
    colorKey('Ground fill', 'groundFill'); colorKey('Ground line', 'groundLine')
    numKey  ('Ground line W', 'groundLineW', 0.5, 8, 0.5)
    colorKey('Water fill',  'waterFill');  colorKey('Water line',  'waterLine')
    numKey  ('Water line W',  'waterLineW',  0.5, 6, 0.5)
    colorKey('Sun color',   'sunColor');  colorKey('Sun ring 1',  'sunRing1')
    colorKey('Sun ring 2',  'sunRing2');  numKey  ('Sun size',    'sunSize', 8, 80, 2)
    sidebar.appendChild(sec)
  }

  const ro = new ResizeObserver(() => drawPreview())
  ro.observe(canvasWrap)

  return {
    show() {
      editCourse = structuredClone(opts.getCourse())
      if (viewMode === 'game') initGameCamera()
      rebuild()
      overlay.style.display = 'flex'
    },
    hide() { overlay.style.display = 'none' },
  }
}

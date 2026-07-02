import type { Course, TerrainSegment, TerrainWave, CourseTheme, ControlPoint, Hazard, Platform, Pt, Bunker } from './terrain'
import { buildSegments, terrainY, DEFAULT_COURSE, buildSpline, splineY, hexWithAlpha, waterPoolBounds, pointInPoly } from './terrain'
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
        bunkers: parsed.bunkers ?? [],
        platforms: parsed.platforms ?? [],
        theme: { ...DEFAULT_COURSE.theme, ...(parsed.theme ?? {}) },
      }
      emit(); rebuild()
    } catch { /* ignore */ }
  })
  const undoBtn = mkBtn('Undo', () => doUndo())
  const redoBtn = mkBtn('Redo', () => doRedo())
  const controlsBtn = mkBtn('Controls', () => { controlsPopup.style.display = 'flex' })
  toolbar.append(backBtn, titleEl, saveBtn, loadBtn, undoBtn, redoBtn, controlsBtn)
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

  // ---- undo stack ----
  // Each emit() pushes the pre-mutation snapshot (captured as lastEmittedCourse)
  // before overwriting it with the current post-mutation state. Undo pops and
  // restores. Capped at 100 entries to bound memory on large courses.
  const MAX_UNDO = 100
  let undoStack: Course[] = []
  let redoStack: Course[] = []
  let lastEmittedCourse: Course = structuredClone(editCourse)

  function syncUndoRedoBtns() {
    undoBtn.disabled = undoStack.length === 0
    undoBtn.style.opacity = undoStack.length === 0 ? '0.4' : '1'
    redoBtn.disabled = redoStack.length === 0
    redoBtn.style.opacity = redoStack.length === 0 ? '0.4' : '1'
  }

  function doUndo() {
    if (undoStack.length === 0) return
    redoStack.push(structuredClone(editCourse))
    const prev = undoStack.pop()!
    editCourse = prev
    lastEmittedCourse = structuredClone(prev)
    selectedPlatIdx = null
    opts.onCourseChange(structuredClone(editCourse))
    rebuild()
    syncUndoRedoBtns()
  }

  function doRedo() {
    if (redoStack.length === 0) return
    undoStack.push(structuredClone(editCourse))
    const next = redoStack.pop()!
    editCourse = next
    lastEmittedCourse = structuredClone(next)
    selectedPlatIdx = null
    opts.onCourseChange(structuredClone(editCourse))
    rebuild()
    syncUndoRedoBtns()
  }

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

  // ---- bunker editing state ----
  let selectedBunkerIdx: number | null = null
  let bunkerVertDragIdx  = -1
  let bunkerBodyDragging = false
  let bunkerDragOriginMouse: Pt = { x: 0, y: 0 }
  let bunkerDragOriginPts: Pt[] = []

  // ---- platform editing state ----
  let selectedPlatIdx: number | null = null
  let platVertDragIdx = -1            // which vertex is being dragged (-1 = none)
  let platBodyDragging = false
  let platDragOriginMouse: Pt = { x: 0, y: 0 }
  let platDragOriginPts: Pt[] = []   // snapshot of all vertices at drag start

  // Space = temporary pan tool (same convention as Figma/Illustrator/Inkscape).
  // Only active while the editor overlay is visible.
  window.addEventListener('keydown', (e) => {
    if (overlay.style.display === 'none') return
    if (e.key === ' ' && !e.repeat) {
      spaceHeld = true
      previewCanvas.style.cursor = 'grab'
      e.preventDefault()
    }
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault(); doUndo()
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault(); doRedo()
    }
    // Arrow keys move the selected platform. Ignore if an input has focus so
    // sliders and number boxes still work normally.
    if ((selectedPlatIdx !== null || selectedBunkerIdx !== null)
        && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)
        && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault()
      const step = e.shiftKey ? 1 : 10
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp'   ? -step : e.key === 'ArrowDown'  ? step : 0
      if (selectedPlatIdx !== null) {
        const plat = editCourse.platforms[selectedPlatIdx]
        plat.points = plat.points.map(p => ({ x: p.x + dx, y: p.y + dy }))
      }
      if (selectedBunkerIdx !== null) {
        const b = editCourse.bunkers[selectedBunkerIdx]
        b.topEdge = b.topEdge.map(p => ({ x: p.x + dx, y: p.y + dy }))
      }
      emit()
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

  // ---- bunker helpers ----

  const BUNKER_FILL_PREVIEW  = 'rgba(210,185,100,0.80)'
  const BUNKER_STROKE_COLOR  = 'rgba(155,130,40,0.9)'
  const BUNKER_STROKE_SEL    = 'rgba(255,210,60,1)'

  // Draw all bunkers: fill between spline top and terrain.
  // Same draw-before-terrain trick as water: fill from spline rim to worldH,
  // terrain drawn after covers the underground part. ptY is only used to know
  // worldH (via editCourse.worldH) — not for clipping the fill polygon.
  function drawBunkersPreview(
    ctx: CanvasRenderingContext2D,
    tx: (x: number) => number,
    ty: (y: number) => number,
  ) {
    for (let bi = 0; bi < editCourse.bunkers.length; bi++) {
      const b = editCourse.bunkers[bi]
      if (b.topEdge.length < 2) continue
      const sel    = bi === selectedBunkerIdx
      const coeffs = buildSpline(b.topEdge)
      const leftX  = Math.min(...b.topEdge.map(p => p.x))
      const rightX = Math.max(...b.topEdge.map(p => p.x))
      // Fill: spline rim → worldH (terrain drawn after clips the underground part)
      ctx.beginPath()
      ctx.moveTo(tx(leftX), ty(splineY(leftX, coeffs)))
      for (let x = leftX + 5; x < rightX; x += 5) ctx.lineTo(tx(x), ty(splineY(x, coeffs)))
      ctx.lineTo(tx(rightX), ty(splineY(rightX, coeffs)))
      ctx.lineTo(tx(rightX), ty(editCourse.worldH))
      ctx.lineTo(tx(leftX),  ty(editCourse.worldH))
      ctx.closePath()
      ctx.fillStyle = BUNKER_FILL_PREVIEW; ctx.fill()
      // Rim stroke — terrain drawn on top will cover underground portions.
      ctx.beginPath()
      ctx.moveTo(tx(leftX), ty(splineY(leftX, coeffs)))
      for (let x = leftX + 5; x <= rightX; x += 5) ctx.lineTo(tx(x), ty(splineY(x, coeffs)))
      ctx.strokeStyle = sel ? BUNKER_STROKE_SEL : BUNKER_STROKE_COLOR
      ctx.lineWidth = sel ? 2.5 : 1.5; ctx.stroke()
    }
  }

  // Draw handles for the selected bunker's top-edge control points.
  function drawBunkerHandles(
    ctx: CanvasRenderingContext2D,
    toScreen: (p: Pt) => { sx: number; sy: number },
  ) {
    if (selectedBunkerIdx === null) return
    const b = editCourse.bunkers[selectedBunkerIdx]
    if (!b || b.topEdge.length < 2) return
    const pts = b.topEdge
    // Edge midpoints (open polyline → n-1 midpoints)
    ctx.fillStyle = 'rgba(160,160,220,0.7)'; ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1
    for (let i = 0; i < pts.length - 1; i++) {
      const a = toScreen(pts[i]), bb = toScreen(pts[i + 1])
      ctx.beginPath(); ctx.arc((a.sx+bb.sx)/2, (a.sy+bb.sy)/2, MID_R, 0, Math.PI*2); ctx.fill(); ctx.stroke()
    }
    // Vertices (orange to distinguish from platform blue)
    for (let i = 0; i < pts.length; i++) {
      const { sx, sy } = toScreen(pts[i])
      ctx.fillStyle = i === bunkerVertDragIdx ? '#fff' : '#fa8'
      ctx.beginPath(); ctx.arc(sx, sy, VERT_R, 0, Math.PI*2); ctx.fill()
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
    }
  }

  function hitTestBunkerVertex(cx: number, cy: number, toScreen: (p: Pt) => { sx: number; sy: number }): number {
    if (selectedBunkerIdx === null) return -1
    const pts = editCourse.bunkers[selectedBunkerIdx]?.topEdge ?? []
    for (let i = 0; i < pts.length; i++) {
      const { sx, sy } = toScreen(pts[i])
      if (Math.hypot(cx-sx, cy-sy) <= VERT_R + 2) return i
    }
    return -1
  }

  function hitTestBunkerEdgeMid(cx: number, cy: number, toScreen: (p: Pt) => { sx: number; sy: number }): number {
    if (selectedBunkerIdx === null) return -1
    const pts = editCourse.bunkers[selectedBunkerIdx]?.topEdge ?? []
    for (let i = 0; i < pts.length - 1; i++) {
      const a = toScreen(pts[i]), bb = toScreen(pts[i + 1])
      if (Math.hypot(cx-(a.sx+bb.sx)/2, cy-(a.sy+bb.sy)/2) <= MID_R + 3) return i
    }
    return -1
  }

  // Return the index of the first unselected bunker whose fill region contains (wx, wy).
  function hitTestBunkerBody(wx: number, wy: number, ptY: (x:number)=>number): number {
    for (let bi = editCourse.bunkers.length - 1; bi >= 0; bi--) {
      if (bi === selectedBunkerIdx) continue
      const b = editCourse.bunkers[bi]
      if (b.topEdge.length < 2) continue
      const leftX  = Math.min(...b.topEdge.map(p => p.x))
      const rightX = Math.max(...b.topEdge.map(p => p.x))
      if (wx < leftX || wx > rightX) continue
      const coeffs = buildSpline(b.topEdge)
      const topY   = splineY(wx, coeffs)
      const groundY = ptY(wx)
      // rim above terrain = topY < groundY (screen Y, increases downward)
      if (topY < groundY && wy >= topY && wy <= groundY) return bi
    }
    return -1
  }

  // Make a 3-point arc default bunker top edge centered at (cx, cy) in world coords.
  function makeDefaultBunker(cx: number, ptY: (x:number)=>number): Pt[] {
    const hw = 150
    const groundL = ptY(cx - hw), groundC = ptY(cx), groundR = ptY(cx + hw)
    return [
      { x: cx - hw, y: groundL - 30 },
      { x: cx,      y: Math.min(groundC, groundL, groundR) - 60 },
      { x: cx + hw, y: groundR - 30 },
    ]
  }

  // ---- platform helpers ----

  const PLAT_FILL_DEFAULT  = '#f5d800'
  const PLAT_EDGE_DEFAULT  = '#b8a000'
  const PLAT_STROKE_SEL    = 'rgba(220,220,255,1)'
  const VERT_R = 6   // vertex handle radius (screen px)
  const MID_R  = 4   // edge-midpoint handle radius

  // Draw all platforms whose zOrder matches `which`. `toScreen` maps world→canvas.
  function drawPlatformsPreview(
    ctx: CanvasRenderingContext2D,
    which: Platform['zOrder'],
    toScreen: (p: Pt) => { sx: number; sy: number },
  ) {
    for (let pi = 0; pi < editCourse.platforms.length; pi++) {
      const plat = editCourse.platforms[pi]
      if (plat.zOrder !== which || plat.points.length < 3) continue
      const sel = pi === selectedPlatIdx
      const s0 = toScreen(plat.points[0])
      ctx.beginPath(); ctx.moveTo(s0.sx, s0.sy)
      for (let i = 1; i < plat.points.length; i++) {
        const s = toScreen(plat.points[i]); ctx.lineTo(s.sx, s.sy)
      }
      ctx.closePath()
      ctx.fillStyle = plat.fillColor || PLAT_FILL_DEFAULT; ctx.fill()
      ctx.strokeStyle = sel ? PLAT_STROKE_SEL : (plat.edgeColor || PLAT_EDGE_DEFAULT)
      ctx.lineWidth = sel ? 2.5 : 1.5; ctx.stroke()
    }
  }

  // Draw vertex + edge-midpoint handles for the selected platform.
  function drawPlatformHandles(
    ctx: CanvasRenderingContext2D,
    toScreen: (p: Pt) => { sx: number; sy: number },
  ) {
    if (selectedPlatIdx === null) return
    const plat = editCourse.platforms[selectedPlatIdx]
    if (!plat || plat.points.length < 3) return
    const pts = plat.points
    // Edge midpoints
    ctx.fillStyle = 'rgba(160,160,220,0.7)'; ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1
    for (let i = 0; i < pts.length; i++) {
      const a = toScreen(pts[i]), b = toScreen(pts[(i+1) % pts.length])
      const mx = (a.sx+b.sx)/2, my = (a.sy+b.sy)/2
      ctx.beginPath(); ctx.arc(mx, my, MID_R, 0, Math.PI*2); ctx.fill(); ctx.stroke()
    }
    // Vertices (drawn on top of midpoints)
    for (let i = 0; i < pts.length; i++) {
      const { sx, sy } = toScreen(pts[i])
      ctx.fillStyle = i === platVertDragIdx ? '#fff' : '#7af'
      ctx.beginPath(); ctx.arc(sx, sy, VERT_R, 0, Math.PI*2); ctx.fill()
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
    }
  }

  // Hit-test a point against vertex handles of the selected platform.
  // Returns vertex index or -1.
  function hitTestVertex(
    cx: number, cy: number,
    toScreen: (p: Pt) => { sx: number; sy: number },
  ): number {
    if (selectedPlatIdx === null) return -1
    const pts = editCourse.platforms[selectedPlatIdx]?.points ?? []
    for (let i = 0; i < pts.length; i++) {
      const { sx, sy } = toScreen(pts[i])
      if (Math.hypot(cx-sx, cy-sy) <= VERT_R + 2) return i
    }
    return -1
  }

  // Hit-test edge midpoints of the selected platform.
  // Returns the edge index (insert after index i, before i+1), or -1.
  function hitTestEdgeMid(
    cx: number, cy: number,
    toScreen: (p: Pt) => { sx: number; sy: number },
  ): number {
    if (selectedPlatIdx === null) return -1
    const pts = editCourse.platforms[selectedPlatIdx]?.points ?? []
    for (let i = 0; i < pts.length; i++) {
      const a = toScreen(pts[i]), b = toScreen(pts[(i+1) % pts.length])
      if (Math.hypot(cx-(a.sx+b.sx)/2, cy-(a.sy+b.sy)/2) <= MID_R + 3) return i
    }
    return -1
  }

  // Return the index of the first platform whose polygon contains world point (wx,wy),
  // or -1 if none. Skips the currently selected platform (use vertex/body drag instead).
  function hitTestPlatformBody(wx: number, wy: number): number {
    for (let pi = editCourse.platforms.length - 1; pi >= 0; pi--) {
      if (pi === selectedPlatIdx) continue
      const plat = editCourse.platforms[pi]
      if (plat.points.length >= 3 && pointInPoly(wx, wy, plat.points)) return pi
    }
    return -1
  }

  // Screen→world helpers for each view mode (used in event handlers).
  function screenToWorld(cx: number, cy: number): Pt {
    if (viewMode === 'game') return { x: cx / gvZoom + gvCamX, y: cy / gvZoom + gvCamY }
    const { wx, wy } = globalMetrics()
    return { x: wx(cx), y: wy(cy) }
  }

  function worldToScreenFn(): (p: Pt) => { sx: number; sy: number } {
    if (viewMode === 'game') {
      return (p) => ({ sx: (p.x - gvCamX) * gvZoom, sy: (p.y - gvCamY) * gvZoom })
    }
    const { tx, ty } = globalMetrics()
    return (p) => ({ sx: tx(p.x), sy: ty(p.y) })
  }

  // Make a long skinny rectangle (CW winding) centered at world (wx,wy).
  function makeDefaultPlatform(wx: number, wy: number): Pt[] {
    const hw = 180, hh = 18
    return [
      { x: wx - hw, y: wy - hh },
      { x: wx + hw, y: wy - hh },
      { x: wx + hw, y: wy + hh },
      { x: wx - hw, y: wy + hh },
    ]
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
  function emit() {
    // Push the pre-mutation snapshot (lastEmittedCourse) before processing the change.
    // Any new action clears the redo stack — same convention as every editor.
    undoStack.push(lastEmittedCourse)
    if (undoStack.length > MAX_UNDO) undoStack.shift()
    redoStack = []
    lastEmittedCourse = structuredClone(editCourse)
    syncUndoRedoBtns()
    rebuildWaterPools(); drawPreview(); opts.onCourseChange(structuredClone(editCourse))
  }

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

    const toScreenG = (p: Pt) => ({ sx: tx(p.x), sy: ty(p.y) })
    drawPlatformsPreview(ctx, 'back', toScreenG)

    // Water is drawn before the terrain, as a plain rectangle — the terrain
    // fill (opaque down to worldH) then paints over whatever part of that
    // rectangle sits above the real ground, giving a shoreline that exactly
    // follows the terrain's contour for free instead of a hard rectangular edge.
    drawWaterTrapsPreview(ctx, tx, ty)
    drawBunkersPreview(ctx, tx, ty)

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
    drawBunkerHandles(ctx, toScreenG)
    drawPlatformsPreview(ctx, 'front', toScreenG)
    drawPlatformHandles(ctx, toScreenG)

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

    const toScreenGV = (p: Pt) => ({ sx: (p.x - gvCamX) * gvZoom, sy: (p.y - gvCamY) * gvZoom })
    const identity   = (p: Pt) => ({ sx: p.x, sy: p.y })
    drawPlatformsPreview(ctx, 'back', identity)
    drawWaterTrapsPreview(ctx, x => x, y => y)
    drawBunkersPreview(ctx, x => x, y => y)

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
    drawPlatformsPreview(ctx, 'front', identity)

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

    // Handles drawn in screen coords (after restore) so they stay a fixed pixel size.
    drawBunkerHandles(ctx, toScreenGV)
    drawPlatformHandles(ctx, toScreenGV)

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

    // Minimap (game view only) — always takes priority.
    if (viewMode === 'game') {
      const { x: mx, y: my, w: mw, h: mh } = GAME_MINIMAP
      if (cx >= mx && cx <= mx + mw && cy >= my && cy <= my + mh) {
        miniDragging = true; panToMini(cx, cy); drawPreview(); return
      }
    }
    // Space → pan.
    if (spaceHeld) { startPan(cx, cy); return }

    const toScreen = worldToScreenFn()

    // Compute terrain ptY once for bunker hit-testing (cheap, only on click).
    const _segs    = buildSegments(editCourse)
    const _spCoeff = buildSpline(editCourse.controlPoints)
    const _ptY     = makePtY(_segs, _spCoeff)

    // ---- bunker interactions ----
    // 1. Vertex handle of selected bunker?
    const bvIdx = hitTestBunkerVertex(cx, cy, toScreen)
    if (bvIdx !== -1) { bunkerVertDragIdx = bvIdx; return }
    // 2. Edge midpoint of selected bunker? → insert a point.
    const beIdx = hitTestBunkerEdgeMid(cx, cy, toScreen)
    if (beIdx !== -1) {
      const w = screenToWorld(cx, cy)
      editCourse.bunkers[selectedBunkerIdx!].topEdge.splice(beIdx + 1, 0, { x: w.x, y: w.y })
      editCourse.bunkers[selectedBunkerIdx!].topEdge.sort((a, b) => a.x - b.x)
      emit(); drawPreview(); return
    }
    // 3. Inside fill of selected bunker? → body drag.
    if (selectedBunkerIdx !== null) {
      const w = screenToWorld(cx, cy)
      if (hitTestBunkerBody(w.x, w.y, _ptY) === -1) { // body of THIS bunker
        const b = editCourse.bunkers[selectedBunkerIdx]
        const leftX = Math.min(...b.topEdge.map(p => p.x))
        const rightX = Math.max(...b.topEdge.map(p => p.x))
        if (w.x >= leftX && w.x <= rightX) {
          const coeffs = buildSpline(b.topEdge)
          const topY = splineY(w.x, coeffs)
          if (w.y >= _ptY(w.x) && w.y <= topY) {
            bunkerBodyDragging = true
            bunkerDragOriginMouse = w
            bunkerDragOriginPts = b.topEdge.map(p => ({ ...p }))
            return
          }
        }
      }
    }
    // 4. Click on a different unselected bunker? → select it.
    const wBunker = screenToWorld(cx, cy)
    const hitBi = hitTestBunkerBody(wBunker.x, wBunker.y, _ptY)
    if (hitBi !== -1) {
      selectedBunkerIdx = hitBi; selectedPlatIdx = null; rebuild(); return
    }
    // 5. Deselect bunker if one was selected.
    if (selectedBunkerIdx !== null) {
      selectedBunkerIdx = null; rebuild(); return
    }

    // ---- platform interactions ----
    // 1. Vertex handle of selected platform?
    const vIdx = hitTestVertex(cx, cy, toScreen)
    if (vIdx !== -1) {
      platVertDragIdx = vIdx; return
    }
    // 2. Edge midpoint of selected platform? → insert a vertex.
    const eIdx = hitTestEdgeMid(cx, cy, toScreen)
    if (eIdx !== -1) {
      const plat = editCourse.platforms[selectedPlatIdx!]
      const { x: wx, y: wy } = screenToWorld(cx, cy)
      plat.points.splice(eIdx + 1, 0, { x: wx, y: wy })
      emit(); drawPreview(); return
    }
    // 3. Body of selected platform? → body drag.
    if (selectedPlatIdx !== null) {
      const plat = editCourse.platforms[selectedPlatIdx]
      const w = screenToWorld(cx, cy)
      if (pointInPoly(w.x, w.y, plat.points)) {
        platBodyDragging = true
        platDragOriginMouse = w
        platDragOriginPts = plat.points.map(p => ({ ...p }))
        return
      }
    }
    // 4. Body of a different platform? → select it.
    const wc = screenToWorld(cx, cy)
    const hitPi = hitTestPlatformBody(wc.x, wc.y)
    if (hitPi !== -1) {
      selectedPlatIdx = hitPi; rebuild(); return
    }
    // 5. Click on empty space → deselect platform, then handle spline editing.
    if (selectedPlatIdx !== null) {
      selectedPlatIdx = null; rebuild(); return
    }

    // ---- spline editing ----
    if (!editCourse.useSpline) {
      if (viewMode === 'game') startPan(cx, cy)
      return
    }
    if (viewMode === 'game') {
      const closest = findClosestCp(cx, cy, (pt) => ({
        sx: (pt.x - gvCamX) * gvZoom, sy: (pt.y - gvCamY) * gvZoom,
      }), 10)
      if (closest !== -1) { dragIdx = closest; return }
      const newPt: ControlPoint = { x: cx / gvZoom + gvCamX, y: cy / gvZoom + gvCamY }
      editCourse.controlPoints.push(newPt)
      editCourse.controlPoints.sort((a, b) => a.x - b.x)
      emit()
    } else {
      const { tx, ty, wx, wy } = globalMetrics()
      const closest = findClosestCp(cx, cy, (pt) => ({ sx: tx(pt.x), sy: ty(pt.y) }), 10)
      if (closest !== -1) { dragIdx = closest; return }
      const newPt: ControlPoint = { x: wx(cx), y: wy(cy) }
      editCourse.controlPoints.push(newPt)
      editCourse.controlPoints.sort((a, b) => a.x - b.x)
      emit()
    }
  })

  previewCanvas.addEventListener('mousemove', (e) => {
    const rect = previewCanvas.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top

    if (miniDragging) { panToMini(cx, cy); drawPreview(); previewCanvas.style.cursor = 'grabbing'; return }

    // Bunker vertex drag
    if (bunkerVertDragIdx !== -1 && selectedBunkerIdx !== null) {
      const w = screenToWorld(cx, cy)
      const pts = editCourse.bunkers[selectedBunkerIdx].topEdge
      pts[bunkerVertDragIdx] = w
      pts.sort((a, b) => a.x - b.x)
      emit(); return
    }
    // Bunker body drag
    if (bunkerBodyDragging && selectedBunkerIdx !== null) {
      const w = screenToWorld(cx, cy)
      const dx = w.x - bunkerDragOriginMouse.x, dy = w.y - bunkerDragOriginMouse.y
      editCourse.bunkers[selectedBunkerIdx].topEdge = bunkerDragOriginPts.map(p => ({ x: p.x+dx, y: p.y+dy }))
      emit(); return
    }

    // Platform vertex drag
    if (platVertDragIdx !== -1 && selectedPlatIdx !== null) {
      const w = screenToWorld(cx, cy)
      editCourse.platforms[selectedPlatIdx].points[platVertDragIdx] = w
      emit(); return
    }
    // Platform body drag
    if (platBodyDragging && selectedPlatIdx !== null) {
      const w = screenToWorld(cx, cy)
      const dx = w.x - platDragOriginMouse.x, dy = w.y - platDragOriginMouse.y
      editCourse.platforms[selectedPlatIdx].points = platDragOriginPts.map(p => ({ x: p.x+dx, y: p.y+dy }))
      emit(); return
    }

    if (viewMode === 'game') {
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
        : dragIdx !== -1 || platVertDragIdx !== -1 || platBodyDragging ? 'grabbing'
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

  function resetDragState() {
    dragIdx = -1; panDragging = false; miniDragging = false
    platVertDragIdx = -1; platBodyDragging = false
    bunkerVertDragIdx = -1; bunkerBodyDragging = false
  }
  previewCanvas.addEventListener('mouseup',    resetDragState)
  previewCanvas.addEventListener('mouseleave', resetDragState)

  previewCanvas.addEventListener('dblclick', (e) => {
    const rect = previewCanvas.getBoundingClientRect()
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top
    const toScreen = worldToScreenFn()

    // Double-click on a vertex of the selected bunker → delete it (min 2).
    if (selectedBunkerIdx !== null) {
      const b = editCourse.bunkers[selectedBunkerIdx]
      if (b.topEdge.length > 2) {
        const bvIdx = hitTestBunkerVertex(cx, cy, toScreen)
        if (bvIdx !== -1) { b.topEdge.splice(bvIdx, 1); emit(); return }
      }
    }

    // Double-click on a vertex of the selected platform → delete it.
    if (selectedPlatIdx !== null) {
      const plat = editCourse.platforms[selectedPlatIdx]
      if (plat.points.length > 3) {
        const vIdx = hitTestVertex(cx, cy, toScreen)
        if (vIdx !== -1) { plat.points.splice(vIdx, 1); emit(); return }
      }
    }

    // Fall through to spline vertex delete.
    if (!editCourse.useSpline || editCourse.controlPoints.length <= 2) return
    const toScreenCp = viewMode === 'game'
      ? (pt: ControlPoint) => ({ sx: (pt.x - gvCamX) * gvZoom, sy: (pt.y - gvCamY) * gvZoom })
      : (pt: ControlPoint) => { const { tx, ty } = globalMetrics(); return { sx: tx(pt.x), sy: ty(pt.y) } }
    const idx = findClosestCp(cx, cy, toScreenCp, 12)
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
    if (selectedBunkerIdx !== null && selectedBunkerIdx >= editCourse.bunkers.length) selectedBunkerIdx = null
    if (selectedPlatIdx   !== null && selectedPlatIdx   >= editCourse.platforms.length) selectedPlatIdx = null
    sidebar.innerHTML = ''
    buildWorldSection()
    buildHoleTeeSection()
    buildModeSection()
    if (editCourse.useSpline) buildSplineSection()
    if (editCourse.useWaves) buildSegmentsSection()
    buildHazardsSection()
    buildBunkersSection()
    buildPlatformsSection()
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

  function buildBunkersSection() {
    const { sec, content } = mksec('Bunkers')
    content.appendChild(mkBtn('+ Add Bunker', () => {
      let cx = editCourse.worldW / 2
      if (viewMode === 'game') {
        const cw = canvasWrap.clientWidth || 800
        cx = gvCamX + cw / gvZoom / 2
      }
      const segs = buildSegments(editCourse)
      const spCoeffs = buildSpline(editCourse.controlPoints)
      const ptY = makePtY(segs, spCoeffs)
      const newBunker: Bunker = {
        topEdge: makeDefaultBunker(cx, ptY),
        friction: 4, shallowMult: 0.75, deepMult: 0.25, deepThreshold: 300,
      }
      editCourse.bunkers.push(newBunker)
      selectedBunkerIdx = editCourse.bunkers.length - 1
      selectedPlatIdx = null
      emit(); rebuild()
    }, 'add-btn'))
    editCourse.bunkers.forEach((b, bi) => content.appendChild(buildBunkerEl(b, bi)))
    sidebar.appendChild(sec)
  }

  function buildBunkerEl(b: Bunker, bi: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'editor-segment' + (bi === selectedBunkerIdx ? ' platform-selected' : '')
    el.style.cursor = 'pointer'
    el.addEventListener('click', () => { selectedBunkerIdx = bi; selectedPlatIdx = null; rebuild() })

    const hdr = document.createElement('div'); hdr.className = 'segment-header'
    const name = document.createElement('span'); name.textContent = `Bunker ${bi + 1}`
    const dup = mkBtn('Dup', () => {
      const copy: Bunker = { ...b, topEdge: b.topEdge.map(p => ({ ...p })) }
      editCourse.bunkers.splice(bi + 1, 0, copy)
      selectedBunkerIdx = bi + 1
      emit(); rebuild()
    })
    const del = mkBtn('×', () => {
      editCourse.bunkers.splice(bi, 1)
      if (selectedBunkerIdx === bi) selectedBunkerIdx = null
      else if (selectedBunkerIdx !== null && selectedBunkerIdx > bi) selectedBunkerIdx--
      emit(); rebuild()
    }, 'del-btn')
    hdr.append(name, dup, del); el.appendChild(hdr)

    // Center X: shifts all rim points horizontally as a unit.
    const getCenterX = () => (Math.min(...b.topEdge.map(p => p.x)) + Math.max(...b.topEdge.map(p => p.x))) / 2
    el.appendChild(sliderRow('Center X', getCenterX(), 0, editCourse.worldW, 10, v => {
      const delta = v - getCenterX()
      b.topEdge = b.topEdge.map(p => ({ x: p.x + delta, y: p.y }))
      emit()
    }))
    el.appendChild(sliderRow('Friction',       b.friction,      1, 20,  0.5, v => { b.friction      = v; emit() }))
    el.appendChild(sliderRow('Shallow mult',   b.shallowMult,   0,  1, 0.05, v => { b.shallowMult   = v; emit() }, v => v.toFixed(2)))
    el.appendChild(sliderRow('Deep mult',      b.deepMult,      0,  1, 0.05, v => { b.deepMult      = v; emit() }, v => v.toFixed(2)))
    el.appendChild(sliderRow('Deep threshold', b.deepThreshold, 50, 800, 25, v => { b.deepThreshold = v; emit() }))

    const hint = document.createElement('div')
    hint.style.cssText = 'font:11px monospace;color:#666;padding:2px 0 4px 0'
    hint.textContent = `${b.topEdge.length} rim points  (click preview to edit)`
    el.appendChild(hint)
    return el
  }

  function buildPlatformsSection() {
    const { sec, content } = mksec('Platforms')
    content.appendChild(mkBtn('+ Add Platform', () => {
      // Center the triangle in the current view.
      let cx = editCourse.worldW / 2, cy = editCourse.worldH / 2
      if (viewMode === 'game') {
        const cw = canvasWrap.clientWidth || 800, ch = canvasWrap.clientHeight || 400
        cx = gvCamX + cw / gvZoom / 2
        cy = gvCamY + ch / gvZoom / 2
      }
      const src = selectedPlatIdx !== null ? editCourse.platforms[selectedPlatIdx] : null
      const plat: Platform = {
        points: makeDefaultPlatform(cx, cy),
        zOrder: src?.zOrder ?? 'front',
        fillColor: src?.fillColor ?? PLAT_FILL_DEFAULT,
        edgeColor: src?.edgeColor ?? PLAT_EDGE_DEFAULT,
      }
      editCourse.platforms.push(plat)
      selectedPlatIdx = editCourse.platforms.length - 1
      emit(); rebuild()
    }, 'add-btn'))
    editCourse.platforms.forEach((plat, pi) => {
      content.appendChild(buildPlatformEl(plat, pi))
    })
    sidebar.appendChild(sec)
  }

  function buildPlatformEl(plat: Platform, pi: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'editor-segment' + (pi === selectedPlatIdx ? ' platform-selected' : '')
    el.style.cursor = 'pointer'
    el.addEventListener('click', () => { selectedPlatIdx = pi; rebuild() })

    const hdr = document.createElement('div'); hdr.className = 'segment-header'
    const name = document.createElement('span'); name.textContent = `Platform ${pi + 1}`
    const dup = mkBtn('Dup', () => {
      const copy: Platform = {
        points: plat.points.map(p => ({ ...p })),
        zOrder: plat.zOrder,
        fillColor: plat.fillColor,
        edgeColor: plat.edgeColor,
      }
      editCourse.platforms.splice(pi + 1, 0, copy)
      selectedPlatIdx = pi + 1
      emit(); rebuild()
    })
    const del = mkBtn('×', () => {
      editCourse.platforms.splice(pi, 1)
      if (selectedPlatIdx === pi) selectedPlatIdx = null
      else if (selectedPlatIdx !== null && selectedPlatIdx > pi) selectedPlatIdx--
      emit(); rebuild()
    }, 'del-btn')
    hdr.append(name, dup, del); el.appendChild(hdr)

    // Z-order toggle
    const zRow = document.createElement('div'); zRow.className = 'slider-row'
    const zLbl = document.createElement('span'); zLbl.className = 'slider-label'; zLbl.textContent = 'Layer'
    const frontBtn = mkBtn('Front', () => { plat.zOrder = 'front'; emit(); rebuild() })
    const backBtn  = mkBtn('Back',  () => { plat.zOrder = 'back';  emit(); rebuild() })
    frontBtn.style.cssText += ';padding:2px 10px;font-size:11px'
    backBtn.style.cssText  += ';padding:2px 10px;font-size:11px'
    frontBtn.style.opacity = plat.zOrder === 'front' ? '1' : '0.4'
    backBtn.style.opacity  = plat.zOrder === 'back'  ? '1' : '0.4'
    zRow.append(zLbl, frontBtn, backBtn); el.appendChild(zRow)

    el.appendChild(colorRow('Fill',   plat.fillColor || PLAT_FILL_DEFAULT, v => { plat.fillColor = v; emit() }))
    el.appendChild(colorRow('Edge',   plat.edgeColor || PLAT_EDGE_DEFAULT, v => { plat.edgeColor = v; emit() }))

    const ptCount = document.createElement('div')
    ptCount.style.cssText = 'font:11px monospace;color:#666;padding:2px 0 4px 0'
    ptCount.textContent = `${plat.points.length} vertices  (click preview to edit)`
    el.appendChild(ptCount)

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
      selectedBunkerIdx = null; selectedPlatIdx = null
      undoStack = []; redoStack = []
      lastEmittedCourse = structuredClone(editCourse)
      syncUndoRedoBtns()
      if (viewMode === 'game') initGameCamera()
      rebuild()
      overlay.style.display = 'flex'
    },
    hide() { overlay.style.display = 'none' },
  }
}

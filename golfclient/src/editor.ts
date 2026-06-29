import type { Course, TerrainSegment, TerrainWave } from './terrain'
import { buildSegments, terrainY } from './terrain'
import './editor.css'

export interface EditorHandle {
  show: () => void
  hide: () => void
}

export function initEditor(opts: {
  getCourse: () => Course
  onCourseChange: (c: Course) => void
}): EditorHandle {
  // ---- overlay root ----
  const overlay = document.createElement('div')
  overlay.className = 'editor-overlay'
  overlay.style.display = 'none'
  document.body.appendChild(overlay)

  // ---- toolbar ----
  const toolbar = document.createElement('div')
  toolbar.className = 'editor-toolbar'

  const backBtn = mkBtn('← Back', () => { overlay.style.display = 'none' })
  const title = document.createElement('span')
  title.className = 'editor-title'
  title.textContent = 'Map Editor'
  const saveBtn = mkBtn('Save', () => {
    localStorage.setItem('golf01_course', JSON.stringify(editCourse))
    saveBtn.textContent = 'Saved ✓'
    setTimeout(() => { saveBtn.textContent = 'Save' }, 1500)
  })
  const loadBtn = mkBtn('Load', () => {
    const raw = localStorage.getItem('golf01_course')
    if (!raw) return
    try {
      editCourse = JSON.parse(raw)
      emit()
      rebuild()
    } catch { /* ignore bad JSON */ }
  })

  toolbar.append(backBtn, title, saveBtn, loadBtn)
  overlay.appendChild(toolbar)

  // ---- body (sidebar + preview) ----
  const body = document.createElement('div')
  body.className = 'editor-body'
  overlay.appendChild(body)

  const sidebar = document.createElement('div')
  sidebar.className = 'editor-sidebar'
  body.appendChild(sidebar)

  const previewWrap = document.createElement('div')
  previewWrap.className = 'editor-preview'
  const previewCanvas = document.createElement('canvas')
  previewWrap.appendChild(previewCanvas)
  body.appendChild(previewWrap)

  // ---- working copy ----
  let editCourse: Course = structuredClone(opts.getCourse())

  // ---- helpers ----
  function mkBtn(label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'editor-btn' + (extraClass ? ' ' + extraClass : '')
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  function sliderRow(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    fmt?: (v: number) => string,
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'slider-row'

    const lbl = document.createElement('span')
    lbl.className = 'slider-label'
    lbl.textContent = label

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = String(min); slider.max = String(max); slider.step = String(step)
    slider.value = String(value)

    const numFmt = fmt ?? ((v: number) => String(Math.round(v)))
    const num = document.createElement('input')
    num.type = 'number'
    num.className = 'slider-num'
    num.min = String(min); num.max = String(max); num.step = String(step)
    num.value = numFmt(value)

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value)
      num.value = numFmt(v)
      onChange(v)
    })
    num.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, parseFloat(num.value) || 0))
      slider.value = String(v)
      num.value = numFmt(v)
      onChange(v)
    })

    row.append(lbl, slider, num)
    return row
  }

  // ---- emit / preview ----
  function emit() {
    drawPreview()
    opts.onCourseChange(structuredClone(editCourse))
  }

  function drawPreview() {
    const cw = previewWrap.clientWidth || 400
    const ch = previewWrap.clientHeight || 300
    if (previewCanvas.width !== cw) previewCanvas.width = cw
    if (previewCanvas.height !== ch) previewCanvas.height = ch

    const ctx = previewCanvas.getContext('2d')!
    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = '#0a0a14'
    ctx.fillRect(0, 0, cw, ch)

    const segs = buildSegments(editCourse)
    const ww = editCourse.worldW
    const wh = editCourse.worldH
    const pad = 20
    const sx = (cw - pad * 2) / ww
    const sy = (ch - pad * 2) / wh
    const tx = (x: number) => pad + x * sx
    const ty = (y: number) => pad + y * sy

    // world boundary
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 1
    ctx.strokeRect(pad, pad, ww * sx, wh * sy)

    // segment boundary lines
    ctx.strokeStyle = 'rgba(80,140,255,0.35)'
    ctx.setLineDash([4, 4])
    let segX = 0
    for (let i = 0; i < segs.length - 1; i++) {
      segX += segs[i].length
      ctx.beginPath()
      ctx.moveTo(tx(segX), pad)
      ctx.lineTo(tx(segX), pad + wh * sy)
      ctx.stroke()
    }
    ctx.setLineDash([])

    // terrain fill
    ctx.beginPath()
    ctx.moveTo(tx(0), ty(terrainY(0, segs)))
    for (let x = 5; x <= ww; x += 5) ctx.lineTo(tx(x), ty(terrainY(x, segs)))
    ctx.lineTo(tx(ww), ty(wh))
    ctx.lineTo(tx(0), ty(wh))
    ctx.closePath()
    ctx.fillStyle = 'rgba(35,55,20,0.85)'
    ctx.fill()

    // terrain line
    ctx.beginPath()
    ctx.moveTo(tx(0), ty(terrainY(0, segs)))
    for (let x = 5; x <= ww; x += 5) ctx.lineTo(tx(x), ty(terrainY(x, segs)))
    ctx.strokeStyle = '#7a9955'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // segment labels
    ctx.fillStyle = 'rgba(80,140,255,0.65)'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    segX = 0
    for (let i = 0; i < segs.length; i++) {
      const mid = segX + segs[i].length / 2
      ctx.fillText(`S${i + 1}`, tx(mid), pad + 12)
      segX += segs[i].length
    }
    ctx.textAlign = 'left'

    // tee markers (white rectangles)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    for (const teeX of [editCourse.teeBackX, editCourse.teeForwardX]) {
      const gY = terrainY(teeX, segs)
      ctx.fillRect(tx(teeX) - 2, ty(gY) - 6 * sy, 4, 6 * sy)
    }

    // hole flag
    const hgY = terrainY(editCourse.holeX, segs)
    ctx.strokeStyle = '#bbb'; ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(tx(editCourse.holeX), ty(hgY))
    ctx.lineTo(tx(editCourse.holeX), ty(hgY) - 14)
    ctx.stroke()
    ctx.fillStyle = '#e44'
    ctx.beginPath()
    ctx.moveTo(tx(editCourse.holeX), ty(hgY) - 14)
    ctx.lineTo(tx(editCourse.holeX) + 7, ty(hgY) - 10)
    ctx.lineTo(tx(editCourse.holeX), ty(hgY) - 6)
    ctx.closePath(); ctx.fill()

    // base ground dashed line
    ctx.strokeStyle = 'rgba(255,255,100,0.18)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 5])
    ctx.beginPath()
    ctx.moveTo(tx(0), ty(editCourse.baseGround))
    ctx.lineTo(tx(ww), ty(editCourse.baseGround))
    ctx.stroke()
    ctx.setLineDash([])
  }

  // ---- build sidebar ----
  function rebuild() {
    sidebar.innerHTML = ''
    buildWorldSection()
    buildHoleTeeSection()
    buildSegmentsSection()
    drawPreview()
  }

  function buildWorldSection() {
    const sec = mksec('World')
    sec.appendChild(sliderRow('Width', editCourse.worldW, 500, 8000, 50, v => {
      editCourse.worldW = v; emit()
    }))
    sec.appendChild(sliderRow('Height', editCourse.worldH, 400, 2000, 50, v => {
      editCourse.worldH = v; emit()
    }))
    sec.appendChild(sliderRow('Base Y', editCourse.baseGround, 50, editCourse.worldH - 50, 10, v => {
      editCourse.baseGround = v; emit()
    }))
    sidebar.appendChild(sec)
  }

  function buildHoleTeeSection() {
    const sec = mksec('Hole & Tees')
    sec.appendChild(sliderRow('Back tee X', editCourse.teeBackX, 0, editCourse.worldW, 25, v => {
      editCourse.teeBackX = v; emit()
    }))
    sec.appendChild(sliderRow('Fwd tee X', editCourse.teeForwardX, 0, editCourse.worldW, 25, v => {
      editCourse.teeForwardX = v; emit()
    }))
    sec.appendChild(sliderRow('Hole X', editCourse.holeX, 0, editCourse.worldW, 25, v => {
      editCourse.holeX = v; emit()
    }))
    sidebar.appendChild(sec)
  }

  function buildSegmentsSection() {
    const sec = mksec('Terrain Segments')

    sec.appendChild(mkBtn('+ Add Segment', () => {
      editCourse.segments.push({ length: 800, waves: [{ amplitude: 40, period: 400, phase: 0 }] })
      emit(); rebuild()
    }, 'add-btn'))

    editCourse.segments.forEach((seg, si) => sec.appendChild(buildSegmentEl(seg, si)))
    sidebar.appendChild(sec)
  }

  function buildSegmentEl(seg: TerrainSegment, si: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'editor-segment'

    const hdr = document.createElement('div')
    hdr.className = 'segment-header'
    const name = document.createElement('span')
    name.textContent = `Segment ${si + 1}`
    const del = mkBtn('×', () => {
      if (editCourse.segments.length <= 1) return
      editCourse.segments.splice(si, 1); emit(); rebuild()
    }, 'del-btn')
    hdr.append(name, del)
    el.appendChild(hdr)

    el.appendChild(sliderRow('Length', seg.length, 50, 6000, 50, v => {
      seg.length = v; emit()
    }))

    seg.waves.forEach((wave, wi) => el.appendChild(buildWaveEl(wave, si, wi)))

    el.appendChild(mkBtn('+ Wave', () => {
      seg.waves.push({ amplitude: 20, period: 200, phase: 0 }); emit(); rebuild()
    }, 'add-btn'))

    return el
  }

  function buildWaveEl(wave: TerrainWave, si: number, wi: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'editor-wave'

    const hdr = document.createElement('div')
    hdr.className = 'wave-header'
    const name = document.createElement('span')
    name.textContent = `Wave ${wi + 1}`
    const del = mkBtn('×', () => {
      const seg = editCourse.segments[si]
      if (seg.waves.length <= 1) return
      seg.waves.splice(wi, 1); emit(); rebuild()
    }, 'del-btn')
    hdr.append(name, del)
    el.appendChild(hdr)

    el.appendChild(sliderRow('Amp', wave.amplitude, 0, 300, 5,
      v => { wave.amplitude = v; emit() }))
    el.appendChild(sliderRow('Period', wave.period, 30, 3000, 25,
      v => { wave.period = v; emit() }))
    el.appendChild(sliderRow('Phase', wave.phase, -Math.PI, Math.PI, 0.05,
      v => { wave.phase = v; emit() },
      v => v.toFixed(2)))

    return el
  }

  function mksec(title: string): HTMLElement {
    const sec = document.createElement('div')
    sec.className = 'editor-section'
    const h = document.createElement('div')
    h.className = 'section-header'
    h.textContent = title
    sec.appendChild(h)
    return sec
  }

  // Resize canvas when preview area changes size
  const ro = new ResizeObserver(() => drawPreview())
  ro.observe(previewWrap)

  // ---- public API ----
  return {
    show() {
      editCourse = structuredClone(opts.getCourse())
      rebuild()
      overlay.style.display = 'flex'
    },
    hide() {
      overlay.style.display = 'none'
    },
  }
}

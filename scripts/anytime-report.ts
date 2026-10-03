import { gzipSync } from "node:zlib"
import type { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import type { SimpleRouteJson } from "../lib/types"

export interface AnytimeComparisonCheckpoint {
  effort: 1 | 2 | 5
  solveMilliseconds: number
  totalMilliseconds: number
  baselineMilliseconds?: number
  baselineReused?: boolean
  optimizationMilliseconds?: number
  optimizationIterations: number
  iterations: number
  acceptedImprovements?: number
  exhausted?: boolean
  status: string
  valid: boolean
  validation: unknown
  score: {
    objective: number
    envelopeAreaMm2: number
    skewPenalty: number
    totalLengthMm: number
    layerEnvelopeAreaMm2?: number
    laneEnvelopeAreaMm2?: number
    tuningEnvelopeAreaMm2?: number
    normalizedArea?: number
    normalizedLength?: number
    busLengths: ReturnType<typeof busLengthReports>
    pairLengths: ReturnType<typeof pairLengthReports>
  }
  output: SimpleRouteJson
}

export interface AnytimeComparisonSample {
  id: string
  title: string
  family: "AM3352" | "AM62L" | "channel"
  input: SimpleRouteJson
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  checkpoints: AnytimeComparisonCheckpoint[]
}

export interface AnytimeComparisonReport {
  generatedAt: string
  iterationsPerX: number
  samples: AnytimeComparisonSample[]
}

/** A standalone, offline review artifact containing only validated incumbents.
 * All three checkpoints use one shared physical viewport, including while
 * zooming. The embedded JSON retains full-precision native copper geometry. */
export function createAnytimeComparisonHtml(report: AnytimeComparisonReport) {
  if (!report.samples.length) throw Error("Comparison requires routed samples")
  for (const sample of report.samples) {
    if (
      sample.checkpoints.length !== 3 ||
      [1, 2, 5].some(
        (effort) =>
          sample.checkpoints.filter((c) => c.effort === effort && c.valid)
            .length !== 1,
      )
    )
      throw Error(
        `${sample.id}: comparison requires valid 1x, 2x and 5x routes`,
      )
  }
  const payload = gzipSync(JSON.stringify(report), { level: 9 }).toString(
    "base64",
  )
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bus lanes · Anytime routing comparison</title>
<style>
:root{color-scheme:dark;--bg:#0b1118;--card:#111c27;--line:#263646;--text:#e7eef7;--muted:#95a6b9;--accent:#73d5cc;--good:#8ed7ab;--font:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}main{max-width:1650px;margin:auto;padding:34px 30px 40px}header{display:flex;gap:25px;justify-content:space-between;align-items:start;margin-bottom:27px}h1{font-size:clamp(24px,3vw,38px);font-weight:650;letter-spacing:-1.2px;line-height:1.2;margin:5px 0 12px}h2{font-size:17px;font-weight:600;margin:0 0 12px}p{margin:0;color:var(--muted)}.eyebrow{color:var(--accent);font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:2px}.intro{max-width:850px}.valid-badge{color:var(--good);border:1px solid #2e5546;background:#112921;border-radius:30px;padding:7px 13px;white-space:nowrap;font-size:12px}.toolbar{display:flex;gap:18px;align-items:end;flex-wrap:wrap;padding:17px 20px;background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:18px}.field{display:grid;gap:5px}.field.sample{flex:1;min-width:230px}.label{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}select,button{font:inherit;color:var(--text);background:#152331;border:1px solid #364959;border-radius:7px;height:35px;padding:4px 10px}button{cursor:pointer}button:hover,select:hover{border-color:var(--accent)}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.effort-buttons{display:flex;gap:5px}.effort-buttons button[aria-pressed=true]{background:#244741;border-color:var(--accent);color:#befff6}.helper{font-size:12px;color:var(--muted);margin-left:auto;align-self:center}.panels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.panel{border:1px solid var(--line);background:var(--card);border-radius:12px;overflow:hidden;cursor:pointer}.panel.active{border-color:var(--accent)}.panel-header{display:flex;justify-content:space-between;align-items:center;padding:13px 15px;border-bottom:1px solid var(--line)}.panel-title{font-size:20px;font-weight:620}.panel-caption{color:var(--muted);font-size:11px}.panel-status{color:var(--good);font-size:11px}.canvas-wrap{position:relative;background:#0d151e;aspect-ratio:1.1;min-height:240px;overflow:hidden}canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}canvas:active{cursor:grabbing}.canvas-scale{position:absolute;bottom:12px;left:13px;color:#c6d4e3;font-size:10px;pointer-events:none;background:#0b1118d9;border:1px solid #263646;padding:3px 7px;border-radius:4px}.panel-footer{display:flex;justify-content:space-between;gap:6px;padding:11px 14px;font-size:11px;color:var(--muted)}.panel-footer strong{color:var(--text);font-variant-numeric:tabular-nums;font-weight:550}.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin:12px 0 23px}.legend span{display:flex;align-items:center;gap:6px}.swatch{width:14px;height:3px;background:var(--accent);display:inline-block}.swatch.pad{height:8px;background:#526172}.swatch.fixed{background:#aab5c3}.box{margin-top:18px;border:1px solid var(--line);border-radius:12px;background:var(--card);padding:20px}.box-header{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:16px}.box-header h2{margin:0}.box-header p{font-size:12px;max-width:700px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}th,td{padding:10px 12px;text-align:right;border-bottom:1px solid #22313f;font-variant-numeric:tabular-nums}th{color:var(--muted);font-weight:500}th:first-child,td:first-child{text-align:left}thead th{font-size:11px;text-transform:uppercase;letter-spacing:.5px}tbody tr:last-child td{border-bottom:0}.selected-col{background:#18352f80;color:#b4ece4}.delta{color:var(--good)}.muted{color:var(--muted)}.notes{font-size:12px;margin-top:13px;line-height:1.6}.summary-row{cursor:pointer}.summary-row:hover{background:#182838}.summary-row.current{background:#203530}.summary-title{text-align:left!important;font-weight:500;color:var(--text)}.section-tag{font-size:10px;background:#1b2c3b;border:1px solid #304657;border-radius:4px;padding:2px 5px;color:#acbbcd;margin-left:8px}.pass{color:var(--good)}.footer{display:flex;justify-content:space-between;gap:15px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin-top:22px}.pair-split td{background:#172432;color:#b7c7d6;text-align:left;font-size:11px;font-weight:550}.empty{padding:16px;color:var(--muted)}@media(max-width:1000px){main{padding:24px 18px}.panel-header{padding:11px}.panel-footer{padding:9px 11px;flex-wrap:wrap}.canvas-wrap{min-height:200px}.helper{display:none}.box-header{display:block}.box-header p{margin-top:6px}.panel-status{font-size:10px}}@media(max-width:700px){main{padding:20px 12px}header{display:block}.valid-badge{display:inline-block;margin-top:15px}.toolbar{padding:13px;gap:12px}.field.sample{flex-basis:100%}.panels{grid-template-columns:1fr}.canvas-wrap{aspect-ratio:1.25;min-height:260px}.panel-footer{font-size:12px}.box{padding:14px}.legend{gap:12px}.footer{display:block}.footer span{display:block;margin-top:6px}}
</style>
</head>
<body>
<main>
<header><div class="intro"><div class="eyebrow">Successive approximation / measured checkpoints</div><h1>More effort. Better incumbents.</h1><p>Compare the validated routes retained after 1x, 2x and 5x optimization effort. All views share a physical scale. Checkpoints come from one deterministic run per sample; extra effort may keep the same result when no improvement is found.</p></div><div class="valid-badge" id="valid-badge"></div></header>
<div class="toolbar"><label class="field sample"><span class="label">Benchmark sample</span><select id="sample" aria-label="Benchmark sample"></select></label><label class="field"><span class="label">Copper layer</span><select id="layer" aria-label="Copper layer"></select></label><div class="field"><span class="label">Inspect checkpoint</span><div class="effort-buttons" id="efforts"><button data-effort="1" aria-pressed="false">1x</button><button data-effort="2" aria-pressed="false">2x</button><button data-effort="5" aria-pressed="true">5x</button></div></div><button id="reset">Reset view</button><span class="helper">Scroll to zoom · drag to pan<br>Viewport moves across all three panels</span></div>
<div class="panels" id="panels"></div>
<div class="legend"><span><i class="swatch"></i>New interconnect</span><span><i class="swatch fixed"></i>Fixed fanout copper</span><span><i class="swatch pad"></i>Pads / obstacles</span><span id="layer-legend"></span></div>
<section class="box"><div class="box-header"><h2>Measured comparison</h2><p>Lower objective, envelope area, normalized skew penalty and copper length are better. Copper and bus skew include immutable fanouts.</p></div><div class="table-wrap"><table id="metrics"></table></div><p class="notes" id="budget-note"></p></section>
<section class="box"><div class="box-header"><h2 id="length-heading">Length matching · 5x</h2><p>Native pad-to-pad planar copper measurements. Via depth and package delay require stackup data and are excluded.</p></div><div class="table-wrap"><table id="lengths"></table></div></section>
<section class="box"><div class="box-header"><h2>Every existing sample</h2><p>Measured 1x → 5x checkpoints. Select a row to inspect its routing.</p></div><div class="table-wrap"><table id="summary"></table></div></section>
<div class="footer"><span id="generated"></span><span>Offline report · exact native wire / via geometry · no external dependencies</span></div>
</main>
<script type="application/octet-stream" id="report-data">${payload}</script>
<script>
(${comparisonBrowser.toString()})().catch((error) => {
  document.getElementById("valid-badge").textContent = "Report could not load";
  document.getElementById("panels").textContent = String(error);
});
</script>
</body>
</html>`
}

/** Kept as a function so the browser program is embedded without string-escape
 * transformations. It is self-contained and never fetches report data. */
async function comparisonBrowser() {
  const compressed = Uint8Array.from(
    atob(document.getElementById("report-data")!.textContent!.trim()),
    (character) => character.charCodeAt(0),
  )
  const decoded = await new Response(
    new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip")),
  ).text()
  const report: AnytimeComparisonReport = JSON.parse(decoded)
  const byId = <T extends HTMLElement>(id: string) =>
    document.getElementById(id)! as T
  const sampleSelect = byId<HTMLSelectElement>("sample")
  const layerSelect = byId<HTMLSelectElement>("layer")
  const layerColors: Record<string, string> = {
    top: "#ed8b86",
    inner1: "#e9c075",
    inner2: "#ac9bf3",
    bottom: "#73d5cc",
  }
  let sampleIndex = 0
  let selectedEffort: 1 | 2 | 5 = 5
  let zoom = 1
  let pan = { x: 0, y: 0 }
  let drag: { x: number; y: number } | null = null
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }
  const escape = (text: unknown) =>
    String(text).replace(/[&<>"']/g, (character) => escapes[character])
  const fmt = (value: number | null | undefined, digits = 3) =>
    value === null || value === undefined || !Number.isFinite(value)
      ? "—"
      : value.toLocaleString("en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
  const checkpoint = (effort: number) =>
    report.samples[sampleIndex].checkpoints.find((c) => c.effort === effort)!
  const improvement = (before: number, after: number) =>
    Math.abs(before) < 1e-12
      ? Math.abs(after) < 1e-12
        ? "0.0%"
        : "—"
      : `${fmt(((before - after) / Math.abs(before)) * 100, 1)}%`
  const physicalLayers = (input: SimpleRouteJson) =>
    Array.from({ length: input.layerCount }, (_, index) =>
      index === 0
        ? "top"
        : index === input.layerCount - 1
          ? "bottom"
          : `inner${index}`,
    )
  const sample = () => report.samples[sampleIndex]
  sampleSelect.innerHTML = report.samples
    .map(
      (s, index) =>
        `<option value="${index}">${escape(s.title.startsWith(s.family) ? s.title : `${s.family} · ${s.title}`)}</option>`,
    )
    .join("")
  byId("valid-badge").textContent =
    `${report.samples.length} samples · all checkpoints validated`
  byId("generated").textContent = `Generated ${report.generatedAt}`

  const canvases: HTMLCanvasElement[] = []
  byId("panels").innerHTML = [1, 2, 5]
    .map(
      (effort) => `<article class="panel" data-effort="${effort}">
        <div class="panel-header"><div><div class="panel-title">${effort}x</div><div class="panel-caption">Retained incumbent</div></div><span class="panel-status">Connectivity + DRC ✓</span></div>
        <div class="canvas-wrap"><canvas data-effort="${effort}" aria-label="${effort}x routed copper comparison"></canvas><div class="canvas-scale"></div></div>
        <div class="panel-footer" id="footer-${effort}"></div></article>`,
    )
    .join("")
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas")) {
    canvases.push(canvas)
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault()
        const previous = zoom
        zoom = Math.max(1, Math.min(30, zoom * Math.exp(-event.deltaY * 0.002)))
        const rect = canvas.getBoundingClientRect()
        const mouse = {
          x: (event.clientX - rect.left) / rect.width - 0.5,
          y: (event.clientY - rect.top) / rect.height - 0.5,
        }
        const ratio = zoom / previous
        pan = {
          x: mouse.x - (mouse.x - pan.x) * ratio,
          y: mouse.y - (mouse.y - pan.y) * ratio,
        }
        if (zoom === 1) pan = { x: 0, y: 0 }
        drawAll()
      },
      { passive: false },
    )
    canvas.addEventListener("pointerdown", (event) => {
      drag = { x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) return
      const rect = canvas.getBoundingClientRect()
      pan.x += (event.clientX - drag.x) / rect.width
      pan.y += (event.clientY - drag.y) / rect.height
      drag = { x: event.clientX, y: event.clientY }
      drawAll()
    })
    canvas.addEventListener("pointerup", () => {
      drag = null
    })
    canvas.addEventListener("pointercancel", () => {
      drag = null
    })
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-effort]"))
    if (element.tagName === "BUTTON" || element.tagName === "ARTICLE")
      element.addEventListener("click", () => {
        selectedEffort = Number(element.dataset.effort) as 1 | 2 | 5
        updateMetrics()
      })

  function drawAll() {
    const s = sample()
    const layer = layerSelect.value
    const fixedIds = new Set((s.input.traces ?? []).map((t) => t.pcb_trace_id))
    const boardLayers = physicalLayers(s.input)
    const routeViaLayers = (via: import("../lib/types").Via) => {
      if (via.layers) return via.layers
      const from = boardLayers.indexOf(via.from_layer)
      const to = boardLayers.indexOf(via.to_layer)
      return boardLayers.slice(Math.min(from, to), Math.max(from, to) + 1)
    }
    const visible = (layers: string[]) =>
      layer === "all" || layers.includes(layer)
    const color = (wireLayer: string) => layerColors[wireLayer] ?? "#73d5cc"
    for (const canvas of canvases) {
      const rect = canvas.getBoundingClientRect()
      const width = rect.width
      const height = rect.height
      if (!width || !height) continue
      const pixelRatio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(height * pixelRatio)
      const ctx = canvas.getContext("2d")!
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = "#0d151e"
      ctx.fillRect(0, 0, width, height)
      const bounds = s.bounds
      const centerX = (bounds.minX + bounds.maxX) / 2
      const centerY = (bounds.minY + bounds.maxY) / 2
      const scale =
        Math.min(
          (width - 32) / Math.max(0.01, bounds.maxX - bounds.minX),
          (height - 32) / Math.max(0.01, bounds.maxY - bounds.minY),
        ) * zoom
      const x = (coordinate: number) =>
        (coordinate - centerX) * scale + width * (0.5 + pan.x)
      const y = (coordinate: number) =>
        -(coordinate - centerY) * scale + height * (0.5 + pan.y)
      // A subtle 5 mm physical grid stays aligned across every checkpoint.
      const gridStep = zoom > 4 ? 1 : 5
      const minX = centerX - (width * (0.5 + pan.x)) / scale
      const maxX = minX + width / scale
      const maxY = centerY + (height * (0.5 + pan.y)) / scale
      const minY = maxY - height / scale
      ctx.lineWidth = 0.5
      ctx.strokeStyle = "#1c2a37"
      ctx.beginPath()
      for (
        let value = Math.ceil(minX / gridStep) * gridStep;
        value <= maxX;
        value += gridStep
      ) {
        ctx.moveTo(x(value), 0)
        ctx.lineTo(x(value), height)
      }
      for (
        let value = Math.ceil(minY / gridStep) * gridStep;
        value <= maxY;
        value += gridStep
      ) {
        ctx.moveTo(0, y(value))
        ctx.lineTo(width, y(value))
      }
      ctx.stroke()
      const outline = s.input.outline
      if (outline?.length) {
        ctx.strokeStyle = "#4c6174"
        ctx.lineWidth = 1
        ctx.beginPath()
        outline.forEach((p, index) => {
          if (index) ctx.lineTo(x(p.x), y(p.y))
          else ctx.moveTo(x(p.x), y(p.y))
        })
        ctx.closePath()
        ctx.stroke()
      }
      for (const obstacle of s.input.obstacles) {
        // AM62L input also contains conservative raster obstacles derived
        // from fixed copper. Draw the native copper and physical pads once.
        if (s.family === "AM62L" && !obstacle.componentId) continue
        if (!visible(obstacle.layers)) continue
        ctx.fillStyle = "#425061"
        ctx.save()
        ctx.translate(x(obstacle.center.x), y(obstacle.center.y))
        ctx.rotate(-((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180)
        if (obstacle.shape === "circle") {
          ctx.beginPath()
          ctx.arc(0, 0, (obstacle.width * scale) / 2, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.fillRect(
            (-obstacle.width * scale) / 2,
            (-obstacle.height * scale) / 2,
            obstacle.width * scale,
            obstacle.height * scale,
          )
        }
        ctx.restore()
      }
      const traces =
        checkpoint(Number(canvas.dataset.effort)).output.traces ?? []
      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      // Fixed copper is drawn first so the new interconnect remains legible.
      for (const fixed of [true, false]) {
        for (const trace of traces) {
          if (fixedIds.has(trace.pcb_trace_id) !== fixed) continue
          for (let index = 1; index < trace.route.length; index++) {
            const a = trace.route[index - 1]
            const b = trace.route[index]
            const wire =
              a.route_type === "wire" ? a : b.route_type === "wire" ? b : null
            if (!wire || !visible([wire.layer])) continue
            if (
              a.route_type === "wire" &&
              b.route_type === "wire" &&
              a.layer !== b.layer
            )
              continue
            ctx.strokeStyle = fixed ? "#aab5c3" : color(wire.layer)
            ctx.globalAlpha = fixed ? 0.75 : 1
            ctx.lineWidth = wire.width * scale
            ctx.beginPath()
            ctx.moveTo(x(a.x), y(a.y))
            ctx.lineTo(x(b.x), y(b.y))
            ctx.stroke()
          }
          for (const point of trace.route) {
            if (point.route_type !== "via" || !visible(routeViaLayers(point)))
              continue
            ctx.globalAlpha = fixed ? 0.8 : 1
            ctx.fillStyle = fixed
              ? "#aab5c3"
              : color(layer === "all" ? point.to_layer : layer)
            ctx.beginPath()
            ctx.arc(
              x(point.x),
              y(point.y),
              ((point.via_diameter ?? 0.3) * scale) / 2,
              0,
              Math.PI * 2,
            )
            ctx.fill()
            ctx.fillStyle = "#0d151e"
            ctx.beginPath()
            ctx.arc(
              x(point.x),
              y(point.y),
              ((point.via_hole_diameter ?? 0.15) * scale) / 2,
              0,
              Math.PI * 2,
            )
            ctx.fill()
          }
        }
      }
      ctx.globalAlpha = 1
      const scaleLabel =
        canvas.parentElement!.querySelector<HTMLElement>(".canvas-scale")!
      scaleLabel.textContent = `Grid ${gridStep} mm · ${fmt(zoom, 1)}× view`
    }
    byId("layer-legend").textContent =
      layer === "all"
        ? "All physical layers overlaid"
        : `${layer} · native copper widths`
    const swatch = document.querySelector<HTMLElement>(".legend .swatch")!
    swatch.style.background =
      layer === "all"
        ? "linear-gradient(90deg,#ed8b86,#e9c075,#ac9bf3,#73d5cc)"
        : color(layer)
  }

  function updateMetrics() {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "#efforts button",
    ))
      button.setAttribute(
        "aria-pressed",
        String(Number(button.dataset.effort) === selectedEffort),
      )
    for (const panel of document.querySelectorAll<HTMLElement>(".panel"))
      panel.classList.toggle(
        "active",
        Number(panel.dataset.effort) === selectedEffort,
      )
    const efforts = [1, 2, 5]
    const baseline = checkpoint(1)
    const final = checkpoint(5)
    const rows: Array<
      [string, (c: AnytimeComparisonCheckpoint) => number, string, number]
    > = [
      ["Objective", (c) => c.score.objective, "", 5],
      ["Interconnect envelope", (c) => c.score.envelopeAreaMm2, " mm²", 3],
      ["Normalized skew penalty", (c) => c.score.skewPenalty, "", 5],
      ["Total planar copper", (c) => c.score.totalLengthMm, " mm", 3],
    ]
    if (
      efforts.every(
        (e) => checkpoint(e).score.layerEnvelopeAreaMm2 !== undefined,
      )
    )
      rows.splice(2, 0, [
        "Sum of layer envelopes",
        (c) => c.score.layerEnvelopeAreaMm2!,
        " mm²",
        3,
      ])
    if (
      efforts.every(
        (e) => checkpoint(e).score.laneEnvelopeAreaMm2 !== undefined,
      )
    )
      rows.splice(3, 0, [
        "Sum of lane envelopes",
        (c) => c.score.laneEnvelopeAreaMm2!,
        " mm²",
        3,
      ])
    if (
      efforts.every(
        (e) => checkpoint(e).score.tuningEnvelopeAreaMm2 !== undefined,
      )
    )
      rows.splice(4, 0, [
        "Tuning bank envelopes",
        (c) => c.score.tuningEnvelopeAreaMm2!,
        " mm²",
        3,
      ])
    const comparedRows = rows.length
    rows.push(
      [
        "Initial route runtime",
        (c) => c.baselineMilliseconds ?? c.solveMilliseconds,
        " ms",
        1,
      ],
      [
        "Optimization runtime",
        (c) =>
          c.optimizationMilliseconds ??
          c.totalMilliseconds - (c.baselineMilliseconds ?? c.solveMilliseconds),
        " ms",
        1,
      ],
      ["Cumulative runtime", (c) => c.totalMilliseconds, " ms", 1],
      ["Optimization iterations", (c) => c.optimizationIterations, "", 0],
      ["Accepted improvements", (c) => c.acceptedImprovements ?? 0, "", 0],
      ["Total solver iterations", (c) => c.iterations, "", 0],
    )
    byId("metrics").innerHTML =
      `<thead><tr><th>Measurement</th>${efforts.map((e) => `<th class="${e === selectedEffort ? "selected-col" : ""}">${e}x</th>`).join("")}<th>1x → 5x reduction</th></tr></thead><tbody>${rows.map(([name, getValue, unit, digits], index) => `<tr><td>${name}</td>${efforts.map((effort) => `<td class="${effort === selectedEffort ? "selected-col" : ""}">${fmt(getValue(checkpoint(effort)), digits)}${unit}</td>`).join("")}<td class="${index < comparedRows ? "delta" : "muted"}">${index < comparedRows ? improvement(getValue(baseline), getValue(final)) : "—"}</td></tr>`).join("")}</tbody>`
    for (const effort of efforts) {
      const c = checkpoint(effort)
      byId(`footer-${effort}`).innerHTML =
        `<span>Area <strong>${fmt(c.score.envelopeAreaMm2, 2)} mm²</strong></span><span>Objective <strong>${fmt(c.score.objective, 4)}</strong></span><span>${fmt(c.totalMilliseconds / 1000, 2)} s</span>`
    }
    byId("budget-note").textContent =
      `1x = up to ${report.iterationsPerX.toLocaleString("en-US")} optimization proposals after a complete initial route. 2x and 5x extend the same run. Runtime is measured cumulative elapsed time; effort is an iteration budget, not a promise of linear wall-clock cost. Cumulative runtime includes checkpoint validation; initial and optimization rows isolate solver time.${final.baselineReused ? " This run reused a validated baseline: cumulative runtime adds its originally measured solve time to the fresh optimization time." : ""}${final.exhausted && final.optimizationIterations < 5 * report.iterationsPerX ? " This sample exhausted its proposal search before the full 5x budget." : ""}`
    const c = checkpoint(selectedEffort)
    byId("length-heading").textContent = `Length matching · ${selectedEffort}x`
    const lengthRows = (
      groups: AnytimeComparisonCheckpoint["score"]["busLengths"],
    ) =>
      groups
        .map((group) => {
          const values = group.lengths
            .map((length) => length.totalLengthMm)
            .filter((length): length is number => length !== null)
          return `<tr><td>${escape(group.busId)}</td><td>${group.lengths.length}</td><td>${values.length ? fmt(Math.min(...values)) : "—"}</td><td>${values.length ? fmt(Math.max(...values)) : "—"}</td><td>${fmt(group.skewMm)}</td><td>${fmt(group.toleranceMm)}</td><td class="${group.toleranceMm === null ? "muted" : "pass"}">${group.toleranceMm === null ? "Unconstrained" : group.matched ? "Matched ✓" : "Outside tolerance"}</td></tr>`
        })
        .join("")
    const buses = c.score.busLengths
    const pairs = c.score.pairLengths
    byId("lengths").innerHTML =
      `<thead><tr><th>Bus / pair</th><th>Signals</th><th>Shortest mm</th><th>Longest mm</th><th>Skew mm</th><th>Tolerance mm</th><th>Length status</th></tr></thead><tbody>${buses.length ? `<tr class="pair-split"><td colspan="7">Buses</td></tr>${lengthRows(buses)}` : ""}${pairs.length ? `<tr class="pair-split"><td colspan="7">Differential pairs</td></tr>${lengthRows(pairs)}` : ""}${!buses.length && !pairs.length ? '<tr><td colspan="7" class="empty">This sample declares no bus or differential-pair length constraints.</td></tr>' : ""}</tbody>`
    updateSummary()
  }

  function updateSummary() {
    const showTuning = report.samples.some((s) =>
      s.checkpoints.some((c) => c.score.tuningEnvelopeAreaMm2 !== undefined),
    )
    byId("summary").innerHTML =
      `<thead><tr><th>Sample</th><th>Objective · 1x → 5x</th>${showTuning ? "<th>Tuning banks mm² · 1x → 5x</th><th>Tuning reduction</th>" : ""}<th>Overall area mm² · 1x → 5x</th><th>Skew penalty · 1x → 5x</th><th>Copper mm · 1x → 5x</th><th>Validity</th></tr></thead><tbody>${report.samples
        .map((s, index) => {
          const a = s.checkpoints.find((c) => c.effort === 1)!
          const b = s.checkpoints.find((c) => c.effort === 5)!
          const tuning = showTuning
            ? `<td>${fmt(a.score.tuningEnvelopeAreaMm2, 2)} → ${fmt(b.score.tuningEnvelopeAreaMm2, 2)}</td><td class="delta">${a.score.tuningEnvelopeAreaMm2 !== undefined && b.score.tuningEnvelopeAreaMm2 !== undefined ? improvement(a.score.tuningEnvelopeAreaMm2, b.score.tuningEnvelopeAreaMm2) : "—"}</td>`
            : ""
          return `<tr class="summary-row${index === sampleIndex ? " current" : ""}" data-sample="${index}" tabindex="0"><td class="summary-title">${escape(s.title)}<span class="section-tag">${escape(s.family)}</span></td><td>${fmt(a.score.objective, 4)} → ${fmt(b.score.objective, 4)}</td>${tuning}<td>${fmt(a.score.envelopeAreaMm2, 2)} → ${fmt(b.score.envelopeAreaMm2, 2)}</td><td>${fmt(a.score.skewPenalty, 4)} → ${fmt(b.score.skewPenalty, 4)}</td><td>${fmt(a.score.totalLengthMm, 2)} → ${fmt(b.score.totalLengthMm, 2)}</td><td class="pass">All three ✓</td></tr>`
        })
        .join("")}</tbody>`
    for (const row of document.querySelectorAll<HTMLElement>("[data-sample]")) {
      const choose = () => {
        sampleIndex = Number(row.dataset.sample)
        sampleSelect.value = String(sampleIndex)
        updateSample()
      }
      row.addEventListener("click", choose)
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          choose()
        }
      })
    }
  }

  function updateSample() {
    zoom = 1
    pan = { x: 0, y: 0 }
    const previousLayer = layerSelect.value
    const layers = new Set(physicalLayers(sample().input))
    for (const trace of checkpoint(1).output.traces ?? [])
      for (const point of trace.route)
        if (point.route_type === "wire") layers.add(point.layer)
    layerSelect.innerHTML = `<option value="all">All layers</option>${[...layers].map((layer) => `<option value="${escape(layer)}">${escape(layer)}</option>`).join("")}`
    layerSelect.value = layers.has(previousLayer) ? previousLayer : "all"
    updateMetrics()
    drawAll()
  }
  sampleSelect.addEventListener("change", () => {
    sampleIndex = Number(sampleSelect.value)
    updateSample()
  })
  layerSelect.addEventListener("change", drawAll)
  byId("reset").addEventListener("click", () => {
    zoom = 1
    pan = { x: 0, y: 0 }
    drawAll()
  })
  new ResizeObserver(drawAll).observe(byId("panels"))
  updateSample()
}

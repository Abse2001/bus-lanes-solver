import { gzipSync } from "node:zlib"
import type { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import type { SimpleRouteJson } from "../lib/types"
import type {
  AnytimePhysicalMetrics,
  AnytimePhysicalProbe,
} from "./anytime-physical-metrics"

export type AnytimeComparisonEffort = 1 | 2 | 5 | 10

export interface AnytimeComparisonCheckpoint {
  effort: AnytimeComparisonEffort
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
  validationMilliseconds?: number
  cumulativeValidationMilliseconds?: number
  validationInputSha256?: string
  validationOutputSha256?: string
  validationTraceSha256?: string
  validationReusedFromEffort?: AnytimeComparisonEffort
  physicalMeasurementMilliseconds?: number
  physicalReusedFromEffort?: AnytimeComparisonEffort
  physical?: AnytimePhysicalMetrics
  diagnostics?: unknown
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
  physicalProbe?: AnytimePhysicalProbe
  physicalBaseline?: AnytimePhysicalMetrics
}

export interface AnytimeComparisonReport {
  generatedAt: string
  iterationsPerX: number
  concurrency?: number
  sourceFingerprint?: {
    sha256: string
    files: Record<string, string>
  }
  baselineSeeds?: Array<{
    sampleId: string
    inputSha256: string
    seedSha256: string | null
  }>
  prefixReference?: {
    sha256: string
    efforts: number[]
    matchedOutputs: number
  }
  samples: AnytimeComparisonSample[]
  /** Local UI diagnostic fixtures must never be mistaken for final results. */
  diagnosticLabel?: string
}

/** A standalone, offline review artifact containing only validated incumbents.
 * All four checkpoints use one shared physical viewport, including while
 * zooming. The embedded JSON retains full-precision native copper geometry. */
export function createAnytimeComparisonHtml(report: AnytimeComparisonReport) {
  const efforts: AnytimeComparisonEffort[] = [1, 2, 5, 10]
  if (!report.samples.length) throw Error("Comparison requires routed samples")
  for (const sample of report.samples) {
    if (
      sample.checkpoints.length !== efforts.length ||
      efforts.some(
        (effort) =>
          sample.checkpoints.filter((c) => c.effort === effort && c.valid)
            .length !== 1,
      )
    )
      throw Error(
        `${sample.id}: comparison requires valid 1x, 2x, 5x and 10x routes`,
      )
  }
  const payload = gzipSync(JSON.stringify(report), { level: 9 }).toString(
    "base64",
  )
  const diagnosticLabel = report.diagnosticLabel?.replace(
    /[&<>"']/g,
    (character) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[character],
  )
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bus lanes · Anytime routing comparison</title>
<style>
:root{color-scheme:dark;--bg:#0b1118;--card:#111c27;--line:#263646;--text:#e7eef7;--muted:#95a6b9;--accent:#73d5cc;--good:#8ed7ab;--font:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}main{max-width:1650px;margin:auto;padding:34px 30px 40px}header{display:flex;gap:25px;justify-content:space-between;align-items:start;margin-bottom:27px}h1{font-size:clamp(24px,3vw,38px);font-weight:650;letter-spacing:-1.2px;line-height:1.2;margin:5px 0 12px}h2{font-size:17px;font-weight:600;margin:0 0 12px}p{margin:0;color:var(--muted)}.eyebrow{color:var(--accent);font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:2px}.intro{max-width:850px}.valid-badge{color:var(--good);border:1px solid #2e5546;background:#112921;border-radius:30px;padding:7px 13px;white-space:nowrap;font-size:12px}.toolbar{display:flex;gap:18px;align-items:end;flex-wrap:wrap;padding:17px 20px;background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:18px}.field{display:grid;gap:5px}.field.sample{flex:1;min-width:230px}.label{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted)}select,button{font:inherit;color:var(--text);background:#152331;border:1px solid #364959;border-radius:7px;height:35px;padding:4px 10px}button{cursor:pointer}button:hover,select:hover{border-color:var(--accent)}button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.effort-buttons{display:flex;gap:5px}.effort-buttons button[aria-pressed=true]{background:#244741;border-color:var(--accent);color:#befff6}.helper{font-size:12px;color:var(--muted);margin-left:auto;align-self:center}.panels{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.panel{border:1px solid var(--line);background:var(--card);border-radius:12px;overflow:hidden;cursor:pointer}.panel.active{border-color:var(--accent)}.panel-header{display:flex;gap:10px;justify-content:space-between;align-items:center;padding:13px 15px;border-bottom:1px solid var(--line)}.panel-title{font-size:20px;font-weight:620}.panel-caption{color:var(--muted);font-size:11px}.panel-status{color:var(--good);font-size:10px;text-align:right;max-width:145px}.canvas-wrap{position:relative;background:#0d151e;aspect-ratio:1.1;min-height:240px;overflow:hidden}canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}canvas:active{cursor:grabbing}.canvas-scale{position:absolute;bottom:12px;left:13px;color:#c6d4e3;font-size:10px;pointer-events:none;background:#0b1118d9;border:1px solid #263646;padding:3px 7px;border-radius:4px}.panel-footer{display:flex;justify-content:space-between;gap:6px;padding:11px 14px;font-size:11px;color:var(--muted)}.panel-footer strong{color:var(--text);font-variant-numeric:tabular-nums;font-weight:550}.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin:12px 0 23px}.legend span{display:flex;align-items:center;gap:6px}.swatch{width:14px;height:3px;background:var(--accent);display:inline-block}.swatch.pad{height:8px;background:#526172}.swatch.fixed{background:#aab5c3}.box{margin-top:18px;border:1px solid var(--line);border-radius:12px;background:var(--card);padding:20px}.box-header{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:16px}.box-header h2{margin:0}.box-header p{font-size:12px;max-width:700px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}th,td{padding:10px 12px;text-align:right;border-bottom:1px solid #22313f;font-variant-numeric:tabular-nums}th{color:var(--muted);font-weight:500}th:first-child,td:first-child{text-align:left}thead th{font-size:11px;text-transform:uppercase;letter-spacing:.5px}tbody tr:last-child td{border-bottom:0}.selected-col{background:#18352f80;color:#b4ece4}.delta{color:var(--good)}.regression{color:#ed8b86}summary{cursor:pointer;font-weight:600}.layer-focus{background:#18352f80}.muted{color:var(--muted)}.notes{font-size:12px;margin-top:13px;line-height:1.6}.summary-row{cursor:pointer}.summary-row:hover{background:#182838}.summary-row.current{background:#203530}.summary-title{text-align:left!important;font-weight:500;color:var(--text)}.section-tag{font-size:10px;background:#1b2c3b;border:1px solid #304657;border-radius:4px;padding:2px 5px;color:#acbbcd;margin-left:8px}.pass{color:var(--good)}.footer{display:flex;justify-content:space-between;gap:15px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin-top:22px}.pair-split td{background:#172432;color:#b7c7d6;text-align:left;font-size:11px;font-weight:550}.empty{padding:16px;color:var(--muted)}.diagnostic-notice{padding:12px 16px;margin-bottom:20px;border:1px solid #956c2c;background:#352910;border-radius:8px;color:#f4d79f;font-weight:600}@media(max-width:1300px){.panels{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:1000px){main{padding:24px 18px}.panel-header{padding:11px}.panel-footer{padding:9px 11px;flex-wrap:wrap}.canvas-wrap{min-height:200px}.helper{display:none}.box-header{display:block}.box-header p{margin-top:6px}.panel-status{font-size:10px}}@media(max-width:700px){main{padding:20px 12px}header{display:block}.valid-badge{display:inline-block;margin-top:15px}.toolbar{padding:13px;gap:12px}.field.sample{flex-basis:100%}.panels{grid-template-columns:1fr}.canvas-wrap{aspect-ratio:1.25;min-height:260px}.panel-footer{font-size:12px}.box{padding:14px}.legend{gap:12px}.footer{display:block}.footer span{display:block;margin-top:6px}}
</style>
</head>
<body>
<main>
${diagnosticLabel ? `<aside class="diagnostic-notice" id="diagnostic-notice">${diagnosticLabel}</aside>` : ""}
<header><div class="intro"><div class="eyebrow">Successive approximation / measured checkpoints</div><h1>Routing by effort, measured.</h1><p>Topology search reroutes related trace groups and adjusts their lengths together before accepting a complete matching transaction. Compare the validated routes retained at 1x, 2x, 5x and 10x from one deterministic run, at a shared physical scale. Additional effort can keep the same result when no further legal improvement is found.</p></div><div class="valid-badge" id="valid-badge"></div></header>
<div class="toolbar"><label class="field sample"><span class="label">Benchmark sample</span><select id="sample" aria-label="Benchmark sample"></select></label><label class="field"><span class="label">Copper layer</span><select id="layer" aria-label="Copper layer"></select></label><div class="field"><span class="label">Inspect checkpoint</span><div class="effort-buttons" id="efforts"><button data-effort="1" aria-pressed="false">1x</button><button data-effort="2" aria-pressed="false">2x</button><button data-effort="5" aria-pressed="false">5x</button><button data-effort="10" aria-pressed="true">10x</button></div></div><button id="reset">Reset view</button><span class="helper">Scroll to zoom · drag to pan<br>Viewport moves across all four panels</span></div>
<div class="panels" id="panels"></div>
<div class="legend"><span><i class="swatch"></i>New interconnect</span><span><i class="swatch fixed"></i>Fixed fanout copper</span><span><i class="swatch pad"></i>Pads / obstacles</span><span id="layer-legend"></span></div>
<section class="box"><div class="box-header"><h2>Physical routing comparison</h2><p>Compare native copper envelopes, clearance exclusion and planar length separately from the normalized objective. Signed changes are measured from 1x to 10x; each metric can trade off while routing remains valid.</p></div><div class="table-wrap"><table id="metrics"></table></div><p class="notes" id="physical-note"></p><p class="notes" id="budget-note"></p><p class="notes" id="validation-note"></p></section>
<section class="box"><div class="box-header"><h2 id="physical-heading">Every physical layer · 10x</h2><p>Frozen layer coverage includes unused layers. Bounding rectangles describe envelopes; certified free cells describe conservative space for an unrelated probe trace.</p></div><div class="table-wrap"><table id="physical-layers"></table></div><p class="notes" id="probe-note"></p></section>
<section class="box"><div class="box-header"><h2 id="length-heading">Length matching · 10x</h2><p>Native pad-to-pad planar copper measurements. Via depth and package delay require stackup data and are excluded.</p></div><div class="table-wrap"><table id="lengths"></table></div></section>
<section class="box"><div class="box-header"><h2>Every existing sample</h2><p>Native metrics at 1x, 5x and 10x; changes compare 1x → 10x. Select a row to inspect its routing.</p></div><div class="table-wrap"><table id="summary"></table></div></section>
<details class="box"><summary>Secondary tuning-bank diagnostics</summary><p class="notes">These rectangles are sums of tagged curve-bank envelopes, not occupied copper, usable board space or released routing capacity. The current physical-envelope objective does not use curve annotations.</p><div class="table-wrap"><table id="diagnostics"></table></div></details>
<div class="footer"><span id="generated"></span><span id="prefix-reference"></span><span>Offline report · exact native wire / via geometry · no external dependencies</span></div>
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
  // This function is serialized into the report, so runtime constants belong
  // here rather than in the generator's module scope.
  const efforts = report.samples[0].checkpoints
    .map((checkpoint) => checkpoint.effort)
    .sort((a, b) => a - b)
  const firstEffort = efforts[0]
  const finalEffort = efforts[efforts.length - 1]
  const parameters = new URLSearchParams(window.location.search)
  const requestedIndex = report.samples.findIndex(
    (sample) => sample.id === parameters.get("sample"),
  )
  const defaultIndex = report.samples.findIndex(
    (sample) => sample.id === "am3352-inner-layers-above",
  )
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
  let sampleIndex =
    requestedIndex >= 0 ? requestedIndex : Math.max(0, defaultIndex)
  const requestedEffort = parameters.get("effort")?.match(/^(1|2|5|10)x?$/)?.[1]
  let selectedEffort: AnytimeComparisonEffort = efforts.includes(
    Number(requestedEffort) as AnytimeComparisonEffort,
  )
    ? (Number(requestedEffort) as AnytimeComparisonEffort)
    : finalEffort
  let zoom = 1
  // Pan is a camera offset in millimeters. Each panel shares this center and
  // one pixels-per-mm scale, even when CSS rounds panel sizes differently.
  let pan = { x: 0, y: 0 }
  let currentScale = 1
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
  sampleSelect.value = String(sampleIndex)
  byId("valid-badge").textContent = report.diagnosticLabel
    ? `UI diagnostic · ${report.samples.length} fixture samples`
    : `${report.samples.length} samples · ${report.samples.length * efforts.length} valid checkpoints`
  byId("generated").textContent = `Generated ${report.generatedAt}`
  if (report.prefixReference) {
    byId("prefix-reference").textContent =
      `${report.prefixReference.matchedOutputs} earlier outputs matched reference bytes (${report.prefixReference.efforts.map((effort) => `${effort}x`).join(", ")})`
    byId("prefix-reference").title =
      `Reference SHA-256: ${report.prefixReference.sha256}`
  }

  const canvases: HTMLCanvasElement[] = []
  byId("panels").innerHTML = efforts
    .map(
      (effort) => `<article class="panel" data-effort="${effort}">
        <div class="panel-header"><div><div class="panel-title">${effort}x</div><div class="panel-caption">Retained incumbent</div></div><span class="panel-status">Connectivity + DRC + matching ✓</span></div>
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
          x: (event.clientX - rect.left - rect.width / 2) / currentScale,
          y: -(event.clientY - rect.top - rect.height / 2) / currentScale,
        }
        const ratio = zoom / previous
        pan = {
          x: pan.x + mouse.x * (1 - 1 / ratio),
          y: pan.y + mouse.y * (1 - 1 / ratio),
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
      pan.x -= (event.clientX - drag.x) / currentScale
      pan.y += (event.clientY - drag.y) / currentScale
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
        selectedEffort = Number(
          element.dataset.effort,
        ) as AnytimeComparisonEffort
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
    const frames = canvases.map((canvas) => canvas.getBoundingClientRect())
    const bounds = s.bounds
    const centerX = (bounds.minX + bounds.maxX) / 2 + pan.x
    const centerY = (bounds.minY + bounds.maxY) / 2 + pan.y
    const widthAvailable = Math.min(...frames.map((frame) => frame.width))
    const heightAvailable = Math.min(...frames.map((frame) => frame.height))
    if (!widthAvailable || !heightAvailable) return
    const scale =
      Math.min(
        (widthAvailable - 32) / Math.max(0.01, bounds.maxX - bounds.minX),
        (heightAvailable - 32) / Math.max(0.01, bounds.maxY - bounds.minY),
      ) * zoom
    currentScale = scale
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
      canvas.dataset.pixelsPerMillimeter = String(scale)
      const x = (coordinate: number) =>
        (coordinate - centerX) * scale + width / 2
      const y = (coordinate: number) =>
        -(coordinate - centerY) * scale + height / 2
      // A subtle 5 mm physical grid stays aligned across every checkpoint.
      const gridStep = zoom > 4 ? 1 : 5
      const minX = centerX - width / 2 / scale
      const maxX = minX + width / scale
      const maxY = centerY + height / 2 / scale
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

  const maxSkew = (
    groups: AnytimeComparisonCheckpoint["score"]["busLengths"],
  ) => {
    const values = groups
      .map((group) => group.skewMm)
      .filter(
        (value): value is number => value !== null && Number.isFinite(value),
      )
    return values.length ? Math.max(...values) : null
  }
  const signedChange = (
    before: number | null | undefined,
    after: number | null | undefined,
  ) => {
    if (
      before === null ||
      before === undefined ||
      after === null ||
      after === undefined ||
      !Number.isFinite(before) ||
      !Number.isFinite(after)
    )
      return "—"
    if (Math.abs(before) < 1e-12)
      return Math.abs(after) < 1e-12 ? "0.000%" : "—"
    const percent = ((after - before) / Math.abs(before)) * 100
    const rounded = Math.abs(percent) < 0.0005 ? 0 : percent
    return `${rounded > 0 ? "+" : ""}${fmt(rounded, 3)}%`
  }
  const changeClass = (
    before: number | null | undefined,
    after: number | null | undefined,
    goal: "smaller" | "larger" | null,
  ) => {
    if (
      goal === null ||
      before === null ||
      before === undefined ||
      after === null ||
      after === undefined ||
      !Number.isFinite(before) ||
      !Number.isFinite(after) ||
      Math.abs(after - before) < 1e-9
    )
      return "muted"
    return (goal === "smaller" ? after < before : after > before)
      ? "delta"
      : "regression"
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
    const baseline = checkpoint(firstEffort)
    const final = checkpoint(finalEffort)
    const hasPhysical = efforts.every((effort) => checkpoint(effort).physical)
    type MetricRow = {
      label: string
      value: (c: AnytimeComparisonCheckpoint) => number | null | undefined
      unit: string
      digits: number
      goal: "smaller" | "larger" | null
      roi?: boolean
      note?: string
    }
    const rows: MetricRow[] = [
      {
        label: "Outer carrier envelope",
        value: (c) =>
          c.physical?.carrierEnvelopeAreaMm2 ?? c.score.envelopeAreaMm2,
        unit: " mm²",
        digits: 3,
        goal: "smaller",
        note: "Axis-aligned native copper envelope, including wire radii and via pads. Fixed input fanouts are reported separately.",
      },
      {
        label: "Mean carrier envelope / physical layer",
        value: (c) =>
          c.physical
            ? c.physical.layerEnvelopeAreaMm2 /
              Math.max(1, c.physical.layers.length)
            : c.score.layerEnvelopeAreaMm2 === undefined
              ? undefined
              : c.score.layerEnvelopeAreaMm2 /
                Math.max(1, sample().input.layerCount),
        unit: " mm²",
        digits: 3,
        goal: "smaller",
        note: "Mean over every frozen physical layer, including unused layers. Per-layer rectangles are shown below.",
      },
      {
        label: "Mean per-lane envelope",
        value: (c) =>
          c.score.laneEnvelopeAreaMm2 === undefined
            ? undefined
            : c.score.laneEnvelopeAreaMm2 /
              Math.max(1, sample().input.connections.length),
        unit: " mm²",
        digits: 3,
        goal: "smaller",
      },
    ]
    if (hasPhysical)
      rows.push(
        {
          label: "Fixed + carrier outer envelope",
          value: (c) => c.physical?.combinedEnvelope?.areaMm2,
          unit: " mm²",
          digits: 3,
          goal: "smaller",
          note: "Native trace envelope includes immutable signal fanouts and unrelated fixed power copper.",
        },
        {
          label: "Carrier-added clearance exclusion",
          value: (c) => c.physical?.candidateAddedBlockedAreaMm2,
          unit: " layer-mm²",
          digits: 3,
          goal: "smaller",
          roi: true,
          note: "Union of additionally blocked probe cells beyond immutable pads, keepouts, fixed copper and board exclusions. This is a fixed-grid estimate of exclusion footprint.",
        },
        {
          label: "Certified usable probe area",
          value: (c) => c.physical?.freeAreaMm2,
          unit: " layer-mm²",
          digits: 3,
          goal: "larger",
          roi: true,
          note: "Whole cells that clear native copper plus probe half-width, declared clearance and cell half-diagonal. A conservative certificate, not proof that another connection can be routed.",
        },
        {
          label: "Largest certified rectangles, sum",
          value: (c) =>
            c.physical?.layers.reduce(
              (sum, layer) => sum + layer.largestFreeRectangleAreaMm2,
              0,
            ),
          unit: " layer-mm²",
          digits: 3,
          goal: "larger",
          roi: true,
          note: "Sum of one largest wholly-free rectangle per physical layer. Rectangles on different layers are separate regions.",
        },
      )
    rows.push({
      label: "Pad-to-pad signal copper",
      value: (c) => c.physical?.signalPlanarLengthMm ?? c.score.totalLengthMm,
      unit: " mm",
      digits: 3,
      goal: "smaller",
      note: "Carrier copper plus associated fixed signal fanouts; excludes unrelated fixed power traces. Via depth and package delay are not inferred.",
    })
    if (hasPhysical)
      rows.push({
        label: "All physical trace copper",
        value: (c) => c.physical?.totalPlanarLengthMm,
        unit: " mm",
        digits: 3,
        goal: "smaller",
        note: "Carrier traces plus all immutable trace copper, including unrelated fixed power nets.",
      })
    rows.push(
      {
        label: "Maximum raw bus skew",
        value: (c) => maxSkew(c.score.busLengths),
        unit: " mm",
        digits: 6,
        goal: "smaller",
      },
      {
        label: "Maximum raw pair skew",
        value: (c) => maxSkew(c.score.pairLengths),
        unit: " mm",
        digits: 6,
        goal: "smaller",
      },
      {
        label: "Normalized skew penalty",
        value: (c) => c.score.skewPenalty,
        unit: "",
        digits: 6,
        goal: "smaller",
      },
      {
        label: "Normalized objective",
        value: (c) => c.score.objective,
        unit: "",
        digits: 6,
        goal: "smaller",
        note: "Weighted optimizer objective. A score change alone does not imply a corresponding board-area or length reduction.",
      },
      {
        label: "Initial route runtime",
        value: (c) => c.baselineMilliseconds ?? c.solveMilliseconds,
        unit: " ms",
        digits: 1,
        goal: null,
      },
      {
        label: "Optimization runtime",
        value: (c) =>
          c.optimizationMilliseconds ??
          c.totalMilliseconds - (c.baselineMilliseconds ?? c.solveMilliseconds),
        unit: " ms",
        digits: 1,
        goal: null,
      },
      {
        label: "Native audit computation at checkpoint",
        value: (c) => c.validationMilliseconds,
        unit: " ms",
        digits: 1,
        goal: null,
        note: "Zero when an exact input, native output and carrier-trace hash match reuses a successful earlier audit in the same frozen sample worker.",
      },
      {
        label: "Cumulative native audit time",
        value: (c) => c.cumulativeValidationMilliseconds,
        unit: " ms",
        digits: 1,
        goal: null,
      },
      {
        label: "Physical probe computation at checkpoint",
        value: (c) => c.physicalMeasurementMilliseconds,
        unit: " ms",
        digits: 1,
        goal: null,
        note: "A byte-identical input/output/carrier triple can reuse its earlier physical probe measurements on the same frozen grid.",
      },
      {
        label: "Cumulative runtime",
        value: (c) => c.totalMilliseconds,
        unit: " ms",
        digits: 1,
        goal: null,
      },
      {
        label: "Optimization iterations",
        value: (c) => c.optimizationIterations,
        unit: "",
        digits: 0,
        goal: null,
      },
      {
        label: "Accepted matching transactions",
        value: (c) => c.acceptedImprovements ?? 0,
        unit: "",
        digits: 0,
        goal: null,
      },
      {
        label: "Total solver iterations",
        value: (c) => c.iterations,
        unit: "",
        digits: 0,
        goal: null,
      },
    )
    const roiSpill = efforts.some(
      (e) => checkpoint(e).physical?.outsideProbeCopper,
    )
    byId("metrics").innerHTML =
      `<thead><tr><th>Measurement</th>${efforts.map((e) => `<th class="${e === selectedEffort ? "selected-col" : ""}">${e}x</th>`).join("")}<th title="Signed percent change relative to ${firstEffort}x; negative means smaller.">${firstEffort}x → ${finalEffort}x change</th></tr></thead><tbody>${rows
        .map((row) => {
          const before = row.value(baseline),
            after = row.value(final)
          const blocked = row.roi && roiSpill
          return `<tr><td title="${escape(row.note ?? "")}">${escape(row.label)}</td>${efforts.map((e) => `<td class="${e === selectedEffort ? "selected-col" : ""}">${fmt(row.value(checkpoint(e)), row.digits)}${row.unit}</td>`).join("")}<td class="${blocked ? "regression" : changeClass(before, after, row.goal)}">${blocked ? "ROI spill; unavailable" : row.goal === null ? "—" : signedChange(before, after)}</td></tr>`
        })
        .join("")}</tbody>`
    for (const effort of efforts) {
      const c = checkpoint(effort)
      byId(`footer-${effort}`).innerHTML =
        `<span>Envelope <strong>${fmt(c.physical?.carrierEnvelopeAreaMm2 ?? c.score.envelopeAreaMm2, 2)} mm²</strong></span><span>Signal copper <strong>${fmt(c.physical?.signalPlanarLengthMm ?? c.score.totalLengthMm, 1)} mm</strong></span><span>${fmt(c.totalMilliseconds / 1000, 2)} s</span>`
    }
    const reference = sample().physicalBaseline
    byId("physical-note").textContent = hasPhysical
      ? `Fixed pads, fanouts and terminal locations can set envelope floors; every raw measurement remains visible when it stays flat. Clearance exclusion is a union of cells within the same frozen ROI, grid and physical layers. Aggregate area uses layer-mm², not board footprint. Certified usable area and rectangle changes are resolution-dependent conservative estimates, not demonstrated additional routing capacity.${reference ? ` Pristine routed baseline: outer envelope ${fmt(reference.carrierEnvelopeAreaMm2)} mm²; carrier-added exclusion ${fmt(reference.candidateAddedBlockedAreaMm2)} layer-mm²; pad-to-pad signal copper ${fmt(reference.signalPlanarLengthMm)} mm.` : ""}${roiSpill ? " A checkpoint spills beyond the ROI; clearance-footprint release claims are suppressed." : ""}`
      : "This report has no physical probe measurements. The native envelopes and planar copper remain visible; tuning-bank rectangles are a separate secondary diagnostic."
    byId("budget-note").textContent =
      `1x = up to ${report.iterationsPerX.toLocaleString("en-US")} optimization proposals after a complete initial route. 2x, 5x and 10x extend the same run. Effort is an iteration budget, not a promise of linear wall-clock cost. Cumulative runtime includes checkpoint audits and physical measurements; initial and optimization rows isolate solver time.${final.baselineReused ? " This run reused a validated baseline: cumulative runtime retains its originally measured solve time." : ""}${final.exhausted && final.optimizationIterations < finalEffort * report.iterationsPerX ? ` This sample exhausted its proposal search before the full ${finalEffort}x budget.` : ""}`
    updatePhysicalLayers()
    const c = checkpoint(selectedEffort)
    const auditHashes = [
      ["input", c.validationInputSha256],
      ["native output", c.validationOutputSha256],
      ["carrier traces", c.validationTraceSha256],
    ]
      .filter(([, hash]) => hash)
      .map(
        ([label, hash]) =>
          `${label} <code title="${escape(hash)}">${escape(hash!.slice(0, 12))}…</code>`,
      )
      .join("; ")
    byId("validation-note").innerHTML =
      `Every displayed checkpoint has a successful native connectivity, clearance and length-matching verdict. Exact input, native-output and carrier-trace bytes may reuse an earlier successful audit within the same frozen sample worker; changed geometry requires a fresh audit. Selected ${selectedEffort}x: ${c.validationReusedFromEffort === undefined ? (c.validationOutputSha256 ? "native audit computed at this checkpoint" : "audit reuse provenance was not supplied") : `native audit reused from ${c.validationReusedFromEffort}x`}${c.physicalReusedFromEffort === undefined ? "" : `; physical probe reused from ${c.physicalReusedFromEffort}x`}.${auditHashes ? ` Audit SHA-256: ${auditHashes}.` : ""}`
    byId("length-heading").textContent = `Length matching · ${selectedEffort}x`
    const lengthRows = (
      groups: AnytimeComparisonCheckpoint["score"]["busLengths"],
    ) =>
      groups
        .map((group) => {
          const values = group.lengths
            .map((item) => item.totalLengthMm)
            .filter((value): value is number => value !== null)
          return `<tr><td>${escape(group.busId)}</td><td>${group.lengths.length}</td><td>${values.length ? fmt(Math.min(...values)) : "—"}</td><td>${values.length ? fmt(Math.max(...values)) : "—"}</td><td>${fmt(group.skewMm, 6)}</td><td>${fmt(group.toleranceMm, 6)}</td><td class="${group.toleranceMm === null ? "muted" : group.matched ? "pass" : "regression"}">${group.toleranceMm === null ? "Unconstrained" : group.matched ? "Matched ✓" : "Outside tolerance"}</td></tr>`
        })
        .join("")
    byId("lengths").innerHTML =
      `<thead><tr><th>Bus / pair</th><th>Signals</th><th>Shortest mm</th><th>Longest mm</th><th>Raw skew mm</th><th>Tolerance mm</th><th>Length status</th></tr></thead><tbody>${c.score.busLengths.length ? `<tr class="pair-split"><td colspan="7">Buses</td></tr>${lengthRows(c.score.busLengths)}` : ""}${c.score.pairLengths.length ? `<tr class="pair-split"><td colspan="7">Differential pairs</td></tr>${lengthRows(c.score.pairLengths)}` : ""}${!c.score.busLengths.length && !c.score.pairLengths.length ? '<tr><td colspan="7" class="empty">This sample declares no bus or differential-pair length constraints.</td></tr>' : ""}</tbody>`
    byId("diagnostics").innerHTML =
      `<thead><tr><th>Secondary diagnostic</th>${efforts.map((effort) => `<th>${effort}x</th>`).join("")}<th>${firstEffort}x → ${finalEffort}x change</th></tr></thead><tbody><tr><td>Tagged tuning-bank rectangle sum</td>${efforts.map((e) => `<td>${fmt(checkpoint(e).score.tuningEnvelopeAreaMm2)} mm²</td>`).join("")}<td class="muted">${signedChange(baseline.score.tuningEnvelopeAreaMm2, final.score.tuningEnvelopeAreaMm2)}</td></tr></tbody>`
    updateSummary()
    updateLocation()
  }

  function updatePhysicalLayers() {
    byId("physical-heading").textContent =
      `Every physical layer · ${selectedEffort}x`
    const physical = checkpoint(selectedEffort).physical
    if (!physical) {
      byId("physical-layers").innerHTML =
        '<tbody><tr><td class="empty">Physical clearance-probe measurements were not supplied for this checkpoint.</td></tr></tbody>'
      byId("probe-note").textContent = ""
      return
    }
    const bbox = (bounds: typeof physical.carrierEnvelope) =>
      bounds
        ? `${fmt(bounds.maxX - bounds.minX, 2)} × ${fmt(bounds.maxY - bounds.minY, 2)}`
        : "—"
    byId("physical-layers").innerHTML =
      `<thead><tr><th>Layer</th><th>Carrier traces / vias</th><th>Carrier copper mm</th><th>Fixed copper mm</th><th>Carrier box mm</th><th>Carrier envelope mm²</th><th>Immutable blocked mm²</th><th>Carrier-added exclusion mm²</th><th>Certified usable mm²</th><th>Largest rectangle mm²</th></tr></thead><tbody>${physical.layers.map((layer) => `<tr class="${layer.layer === layerSelect.value ? "layer-focus" : ""}"><td>${escape(layer.layer)}${layer.carrierTraceCount ? "" : " · unused carrier layer"}</td><td>${layer.carrierTraceCount} / ${layer.carrierViaCount}</td><td>${fmt(layer.carrierPlanarLengthMm)}</td><td>${fmt(layer.fixedPlanarLengthMm)}</td><td>${bbox(layer.carrierEnvelope)}</td><td>${fmt(layer.carrierEnvelope?.areaMm2 ?? 0)}</td><td>${fmt(layer.immutableBlockedAreaMm2)}</td><td>${fmt(layer.candidateAddedBlockedAreaMm2)}</td><td>${fmt(layer.freeAreaMm2)}</td><td>${fmt(layer.largestFreeRectangleAreaMm2)}</td></tr>`).join("")}</tbody>`
    const probe = sample().physicalProbe
    byId("probe-note").textContent = probe
      ? `Shared baseline-defined ROI: X ${fmt(probe.roi.minX, 2)}…${fmt(probe.roi.maxX, 2)} mm, Y ${fmt(probe.roi.minY, 2)}…${fmt(probe.roi.maxY, 2)} mm. Grid ${probe.columns} × ${probe.rows}; requested pitch ${fmt(probe.pitchMm)} mm, actual cell ${fmt(probe.cellWidthMm)} × ${fmt(probe.cellHeightMm)} mm. Unrelated probe trace width ${fmt(probe.probeTraceWidthMm)} mm; copper clearance ${fmt(probe.clearanceMm)} mm; board-edge clearance ${fmt(probe.boardEdgeClearanceMm)} mm. All ${probe.layers.length} physical layers remain frozen across checkpoints. Whole cells are certified using half-diagonal dilation; rotated-pad envelopes and supplied keepouts remain conservative.${physical.outsideProbeCopper ? " This checkpoint has ROI spill; its exclusion-area decrease is not a release claim." : ""}`
      : "This checkpoint includes physical measurements but no serialized probe definitions. Grid-based gains cannot be independently interpreted without ROI, pitch, trace width, clearance and frozen-layer definitions."
  }

  function updateSummary() {
    const hasPhysical = report.samples.some((s) =>
      s.checkpoints.some((c) => c.physical),
    )
    const summaryEfforts: AnytimeComparisonEffort[] = [
      firstEffort,
      5,
      finalEffort,
    ]
    const groups: {
      label: string
      value: (checkpoint: AnytimeComparisonCheckpoint) => string
    }[] = [
      {
        label: "Outer carrier envelope · mm²",
        value: (c) =>
          fmt(c.physical?.carrierEnvelopeAreaMm2 ?? c.score.envelopeAreaMm2, 2),
      },
    ]
    if (hasPhysical)
      groups.push({
        label: "Carrier exclusion · layer-mm²",
        value: (c) =>
          `${fmt(c.physical?.candidateAddedBlockedAreaMm2, 2)}${c.physical?.outsideProbeCopper ? " · ROI spill" : ""}`,
      })
    groups.push(
      {
        label: "Pad-to-pad signal copper · mm",
        value: (c) =>
          fmt(c.physical?.signalPlanarLengthMm ?? c.score.totalLengthMm, 2),
      },
      {
        label: "Maximum raw bus / pair skew · mm",
        value: (c) =>
          `${fmt(maxSkew(c.score.busLengths), 5)} / ${fmt(maxSkew(c.score.pairLengths), 5)}`,
      },
      {
        label: "Normalized objective",
        value: (c) => fmt(c.score.objective, 6),
      },
    )
    byId("summary").innerHTML =
      `<thead><tr><th rowspan="2">Sample</th>${groups.map((group) => `<th colspan="${summaryEfforts.length}">${escape(group.label)}</th>`).join("")}<th rowspan="2">Validity</th></tr><tr>${groups.map(() => summaryEfforts.map((effort) => `<th class="${effort === selectedEffort ? "selected-col" : ""}">${effort}x</th>`).join("")).join("")}</tr></thead><tbody>${report.samples
        .map((s, index) => {
          const values = groups
            .map((group) =>
              summaryEfforts
                .map(
                  (effort) =>
                    `<td class="${effort === selectedEffort ? "selected-col" : ""}">${group.value(s.checkpoints.find((c) => c.effort === effort)!)}</td>`,
                )
                .join(""),
            )
            .join("")
          return `<tr class="summary-row${index === sampleIndex ? " current" : ""}" data-sample="${index}" tabindex="0"><td class="summary-title">${escape(s.title)}<span class="section-tag">${escape(s.family)}</span></td>${values}<td class="pass">All four ✓</td></tr>`
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

  function updateLocation() {
    const url = new URL(window.location.href)
    url.searchParams.set("sample", sample().id)
    url.searchParams.set("effort", String(selectedEffort))
    if (layerSelect.value === "all") url.searchParams.delete("layer")
    else url.searchParams.set("layer", layerSelect.value)
    // Some local-file viewers disallow History API changes. The controls and
    // initial query selection remain usable in those viewers.
    try {
      window.history.replaceState(null, "", url)
    } catch {}
  }

  function updateSample(initialLayer?: string) {
    zoom = 1
    pan = { x: 0, y: 0 }
    const previousLayer = initialLayer ?? layerSelect.value
    const layers = new Set(
      sample().physicalProbe?.layers ?? physicalLayers(sample().input),
    )
    for (const current of sample().checkpoints)
      for (const trace of current.output.traces ?? [])
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
  layerSelect.addEventListener("change", () => {
    updateMetrics()
    drawAll()
  })
  byId("reset").addEventListener("click", () => {
    zoom = 1
    pan = { x: 0, y: 0 }
    drawAll()
  })
  new ResizeObserver(drawAll).observe(byId("panels"))
  updateSample(parameters.get("layer") ?? undefined)
}

import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  getPngBufferFromGraphicsObject,
  getSvgFromGraphicsObject,
  type GraphicsObject,
} from "graphics-debug"
import { BusLanesPipelineSolver, type Trace } from "../lib"
import {
  am3352Hash,
  am3352SamplePlacements,
  loadAm3352Sample,
  type Am3352SampleMetadata,
} from "./am3352-samples"
import {
  validateAm3352OutputShape,
  validateAm3352Sample,
} from "./validate-am3352-sample"

export interface Am3352SnapshotCandidate {
  solver: Pick<
    BusLanesPipelineSolver,
    "solved" | "failed" | "error" | "input" | "traces" | "getOutput"
  >
  metadata: Am3352SampleMetadata
}

/** All declared cases must pass before rendering or writing any review artifact. */
export async function validateAm3352SnapshotCandidates(
  candidates: Am3352SnapshotCandidate[],
) {
  if (
    candidates.length !== am3352SamplePlacements.length ||
    new Set(candidates.map((c) => c.metadata.name)).size !==
      am3352SamplePlacements.length ||
    am3352SamplePlacements.some(
      (p) => !candidates.some((c) => c.metadata.name === p.name),
    )
  )
    throw Error(
      "AM3352 artifacts require exactly the declared benchmark samples",
    )
  const reports = []
  for (const placement of am3352SamplePlacements) {
    const candidate = candidates.find(
      (c) => c.metadata.name === placement.name,
    )!
    const { solver, metadata } = candidate
    if (!solver.solved || solver.failed)
      throw Error(
        `${placement.name}: refusing incomplete routing: ${solver.error ?? "solver is not successfully solved"}`,
      )
    const output = solver.getOutput()
    validateAm3352OutputShape(solver.input, metadata, solver.traces, output)
    const validation = await validateAm3352Sample(
      solver.input,
      metadata,
      solver.traces,
    )
    if (
      !validation.valid ||
      !validation.complete ||
      !validation.matched ||
      !validation.fixedDrc.valid ||
      !validation.combinedDrc?.valid ||
      validation.fixedPowerTraces !== 161 ||
      validation.fixedPowerVias !== 161 ||
      validation.fixedPowerPadJoins !== 161
    )
      throw Error(
        `${placement.name}: refusing artifacts without complete connectivity, immutable power copper, DRC and pad-to-pad length matching`,
      )
    reports.push({ candidate, validation })
  }
  return reports
}

const layerColors: Record<string, string> = {
  top: "#e56b6f",
  inner1: "#f1b75d",
  inner2: "#b586ed",
  bottom: "#8cd391",
}
const carrierLayer = (trace: Trace) => {
  const firstVia = trace.route.findIndex((p) => p.route_type === "via")
  const carrier = trace.route[firstVia + 1]
  if (firstVia < 0 || carrier?.route_type !== "wire")
    throw Error("Snapshot signal is missing its validated carrier layer")
  return carrier.layer
}

/** Draw native wire and via primitives, never ratsnest or search geometry.
 * The signal-layer panels share one physical scale and viewport per board. */
export function routedGraphics(
  { solver, metadata }: Am3352SnapshotCandidate,
  labels?: { title: string; status: string; skew: string },
) {
  const allTraces = [...metadata.fixedFanoutTraces, ...solver.traces]
  const points = [
    ...allTraces.flatMap((t) => t.route),
    ...solver.input.obstacles.flatMap((p) => [
      { x: p.center.x - p.width / 2, y: p.center.y - p.height / 2 },
      { x: p.center.x + p.width / 2, y: p.center.y + p.height / 2 },
    ]),
  ]
  const bounds = {
    minX: Math.min(...points.map((p) => p.x)) - 1,
    maxX: Math.max(...points.map((p) => p.x)) + 1,
    minY: Math.min(...points.map((p) => p.y)) - 1,
    maxY: Math.max(...points.map((p) => p.y)) + 1,
  }
  const width = bounds.maxX - bounds.minX,
    height = bounds.maxY - bounds.minY
  const signalLayers = solver.input.allowedLayers
    ? [...solver.input.allowedLayers]
    : ["inner1", "inner2", "bottom"]
  if (
    !signalLayers.includes("top") &&
    solver.traces.some((trace) => carrierLayer(trace) === "top")
  )
    signalLayers.push("top")
  const graphics: GraphicsObject = {
    coordinateSystem: "cartesian",
    title: `AM3352 / RAM ${metadata.name} · 47/47 signals · DRC and matching passed`,
    lines: [],
    circles: [],
    rects: [],
    texts: [],
  }
  const addTrace = (trace: Trace, layer: string, dx: number) => {
    const color = layerColors[layer]
    for (let i = 1; i < trace.route.length; i++) {
      const a = trace.route[i - 1],
        b = trace.route[i]
      if (
        a.route_type === "wire" &&
        b.route_type === "wire" &&
        a.layer === b.layer &&
        a.layer === layer
      )
        graphics.lines!.push({
          points: [
            { x: a.x + dx, y: a.y },
            { x: b.x + dx, y: b.y },
          ],
          strokeWidth: a.width,
          strokeColor: color,
        })
    }
    for (const via of trace.route)
      if (
        via.route_type === "via" &&
        (via.layers ?? [via.from_layer, via.to_layer]).includes(layer)
      ) {
        graphics.circles!.push({
          center: { x: via.x + dx, y: via.y },
          radius: (via.via_diameter ?? 0.3) / 2,
          fill: color,
          stroke: "none",
        })
        graphics.circles!.push({
          center: { x: via.x + dx, y: via.y },
          radius: (via.via_hole_diameter ?? 0.15) / 2,
          fill: "#10151b",
          stroke: "none",
        })
      }
  }
  for (const [i, layer] of signalLayers.entries()) {
    const dx = i * (width + 3)
    graphics.rects!.push({
      center: {
        x: (bounds.minX + bounds.maxX) / 2 + dx,
        y: (bounds.minY + bounds.maxY) / 2,
      },
      width,
      height,
      // graphics-debug paints rectangles after lines. The global canvas
      // background already supplies this fill; an opaque panel hides copper.
      fill: "none",
      stroke: "#354150",
    })
    for (const pad of solver.input.obstacles)
      if (pad.shape === "circle")
        graphics.circles!.push({
          center: { x: pad.center.x + dx, y: pad.center.y },
          radius: pad.width / 2,
          fill: pad.layers.includes(layer) ? "#4c3134" : "rgba(76,49,52,0.35)",
          stroke: "none",
        })
      else
        graphics.rects!.push({
          center: { x: pad.center.x + dx, y: pad.center.y },
          width: pad.width,
          height: pad.height,
          ccwRotationDegrees: pad.ccwRotationDegrees,
          fill: pad.layers.includes(layer) ? "#4c3134" : "rgba(76,49,52,0.35)",
          stroke: "none",
        })
    for (const trace of allTraces) addTrace(trace, layer, dx)
    const signalCount = solver.traces.filter(
      (t) => carrierLayer(t) === layer,
    ).length
    graphics.texts!.push({
      x: bounds.minX + dx,
      y: bounds.maxY + 1.5,
      text: `${layer} · ${signalCount} signals`,
      fontSize: 1.2,
      color: layerColors[layer],
      anchorSide: "bottom_left",
    })
  }
  const totalWidth = signalLayers.length * width + (signalLayers.length - 1) * 3
  const title =
    labels?.title ??
    `${metadata.name} · AM3352 (0, 0) · RAM (${metadata.placement.ram.x}, ${metadata.placement.ram.y}) mm`
  const status =
    labels?.status ?? "47/47 routed · 161 fixed power dogbones · DRC passed"
  const skew =
    labels?.skew ??
    `${solver.input.buses?.length ?? 0} bus skews ≤0.635 mm · pair skew ≤0.127 mm`
  const fitFont = (text: string, maximum: number) =>
    Math.min(maximum, totalWidth / (text.length * 1.05))
  graphics.texts!.push({
    x: bounds.minX,
    y: bounds.maxY + 4,
    text: title,
    fontSize: fitFont(title, 1.4),
    color: "#ffffff",
    anchorSide: "bottom_left",
  })
  graphics.texts!.push({
    x: bounds.minX,
    y: bounds.minY - 1.5,
    text: status,
    fontSize: fitFont(status, 1.1),
    color: "#cbd5e1",
    anchorSide: "top_left",
  })
  graphics.texts!.push({
    x: bounds.minX,
    y: bounds.minY - 3,
    text: skew,
    fontSize: fitFont(skew, 1.1),
    color: "#cbd5e1",
    anchorSide: "top_left",
  })
  return {
    graphics,
    width: totalWidth,
    height: height + 10.5,
  }
}

export async function exportAm3352RoutedSnapshots(
  candidates: Am3352SnapshotCandidate[],
  directory: string,
) {
  const validated = await validateAm3352SnapshotCandidates(candidates)
  const artifacts = []
  for (const { candidate, validation } of validated) {
    const { graphics, width, height } = routedGraphics(candidate)
    const pngWidth = 2200,
      pngHeight = Math.round((pngWidth * height) / width)
    const png = await getPngBufferFromGraphicsObject(graphics, {
      includeTextLabels: false,
      backgroundColor: "#10151b",
      pngWidth,
      pngHeight,
      yFlip: true,
    })
    const svg = getSvgFromGraphicsObject(graphics, {
      includeTextLabels: false,
      backgroundColor: "#10151b",
      svgWidth: pngWidth,
      svgHeight: pngHeight,
    })
    artifacts.push({ name: candidate.metadata.name, png, svg, validation })
  }
  await mkdir(directory, { recursive: true })
  for (const artifact of artifacts) {
    await Bun.write(
      join(directory, `${artifact.name}-solved.png`),
      artifact.png,
    )
    await Bun.write(
      join(directory, `${artifact.name}-solved.svg`),
      artifact.svg,
    )
    console.log(`${artifact.name}: 47/47 routed, DRC and matching passed`)
  }
  return artifacts.map(({ name, validation }) => ({ name, validation }))
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const directory = args[0] ?? "docs/routed-am3352-placements"
  const timeoutSeconds = Number(args[1] ?? 180)
  if (
    args.length > 2 ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  )
    throw Error(
      "Usage: bun scripts/snapshot-routed-am3352.ts [directory] [timeout-seconds]",
    )
  const candidates: Am3352SnapshotCandidate[] = []
  for (const placement of am3352SamplePlacements) {
    const { input, metadata } = await loadAm3352Sample(placement.name)
    const before = am3352Hash(input)
    const solver = new BusLanesPipelineSolver(input)
    const start = performance.now()
    while (!solver.solved && !solver.failed) {
      if (performance.now() - start >= timeoutSeconds * 1000) {
        solver.tryFinalAcceptance()
        if (solver.solved) break
        throw Error(
          `${placement.name}: routing exceeded ${timeoutSeconds}s; no artifacts written`,
        )
      }
      solver.step()
    }
    if (am3352Hash(input) !== before)
      throw Error(`${placement.name}: routing mutated its original input`)
    // Retain validated route data, not each search's caches, while solving the
    // remaining samples. Otherwise the gallery accumulates eight solver heaps.
    const output = solver.getOutput()
    candidates.push({
      solver: {
        solved: solver.solved,
        failed: solver.failed,
        error: solver.error,
        input: solver.input,
        traces: solver.traces,
        getOutput: () => output,
      },
      metadata,
    })
  }
  await exportAm3352RoutedSnapshots(candidates, directory)
}

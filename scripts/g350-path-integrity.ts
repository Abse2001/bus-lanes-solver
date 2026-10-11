import type { SimpleRouteJson, Trace, Via, Wire } from "../lib"
import {
  distance,
  pointSegmentDistance,
  segmentDistance,
} from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { generatedEscapeHolesConflict } from "../lib/expanded-signal-sites"

export interface G350PathIntegrityIssue {
  code: string
  traceId?: string
  connectionName?: string
  pointIndex?: number
  message: string
}

const contactEpsilon = 1e-9
// Match the pinned routed-copper parser's handoff tolerance.
const continuityEpsilon = 1e-6
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
const record = <T>(value: T): value is T & Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Audit newly joined DDR paths. This adds no spacing or angle constraint:
 * returning copper is checked at its actual width, and sampled curves remain
 * the same straight chords consumed by the pinned DRC and snapshot renderer. */
export function validateG350PathIntegrity(
  input: SimpleRouteJson,
  traces: readonly Trace[],
) {
  const issues: G350PathIntegrityIssue[] = []
  let structurallyValid = true
  const layers = [
    "top",
    ...Array.from(
      { length: Math.max(0, input.layerCount - 2) },
      (_, i) => `inner${i + 1}`,
    ),
    ...(input.layerCount === 1 ? [] : ["bottom"]),
  ]
  const ids = new Set((input.traces ?? []).map((trace) => trace.pcb_trace_id))
  const add = (
    code: string,
    message: string,
    trace?: Trace,
    pointIndex?: number,
    malformed = false,
  ) => {
    if (malformed) structurallyValid = false
    issues.push({
      code,
      message,
      traceId: trace?.pcb_trace_id,
      connectionName: trace?.connection_name,
      pointIndex,
    })
  }
  if (!Array.isArray(traces)) {
    add(
      "malformed-traces",
      "Joined paths must be an array",
      undefined,
      undefined,
      true,
    )
    return { valid: false, structurallyValid, issues }
  }
  for (const trace of traces as readonly Trace[]) {
    if (
      !record(trace) ||
      trace.type !== "pcb_trace" ||
      typeof trace.pcb_trace_id !== "string" ||
      trace.pcb_trace_id.length === 0 ||
      !Array.isArray(trace.route)
    ) {
      add(
        "malformed-trace",
        "Expected a named pcb_trace with a route array",
        undefined,
        undefined,
        true,
      )
      continue
    }
    if (ids.has(trace.pcb_trace_id))
      add(
        "duplicate-trace-id",
        "Joined trace ID collides with another or supplied trace",
        trace,
      )
    ids.add(trace.pcb_trace_id)
    let shapeValid = true
    for (const [i, point] of trace.route.entries()) {
      if (
        !record(point) ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        !["wire", "via"].includes(point.route_type as string)
      ) {
        add(
          "malformed-point",
          "Expected a finite wire or via point",
          trace,
          i,
          true,
        )
        shapeValid = false
        continue
      }
      if (point.route_type === "wire") {
        if (!layers.includes(point.layer) || !positive(point.width)) {
          add(
            "malformed-wire",
            "Wire layer and positive width must be physical",
            trace,
            i,
            true,
          )
          shapeValid = false
        }
      } else if (
        !layers.includes(point.from_layer) ||
        !layers.includes(point.to_layer) ||
        (point.via_diameter !== undefined && !positive(point.via_diameter)) ||
        (point.via_hole_diameter !== undefined &&
          !positive(point.via_hole_diameter)) ||
        (point.layers !== undefined &&
          (!Array.isArray(point.layers) ||
            !point.layers.length ||
            point.layers.some((layer) => !layers.includes(layer)) ||
            !point.layers.includes(point.from_layer) ||
            !point.layers.includes(point.to_layer)))
      ) {
        add(
          "malformed-via",
          "Via dimensions and physical span must be valid",
          trace,
          i,
          true,
        )
        shapeValid = false
      }
    }
    if (!shapeValid) continue
    if (
      trace.route.length < 2 ||
      trace.route[0].route_type !== "wire" ||
      trace.route.at(-1)!.route_type !== "wire"
    )
      add(
        "invalid-path-ends",
        "A joined path must start and finish with wires",
        trace,
      )
    let continuous = true
    for (const [i, point] of trace.route.entries()) {
      if (point.route_type === "via") {
        const before = trace.route[i - 1]
        const after = trace.route[i + 1]
        if (
          before?.route_type !== "wire" ||
          after?.route_type !== "wire" ||
          point.from_layer === point.to_layer ||
          before.layer !== point.from_layer ||
          after.layer !== point.to_layer ||
          distance(before, point) > continuityEpsilon ||
          distance(after, point) > continuityEpsilon
        ) {
          add(
            "invalid-via-handoff",
            "Via must join colocated incoming and outgoing wires on its declared layers",
            trace,
            i,
          )
          continuous = false
        }
      } else {
        const next = trace.route[i + 1]
        if (next?.route_type === "wire" && next.layer !== point.layer) {
          add(
            "layer-jump",
            "A wire cannot change layers without a via",
            trace,
            i,
          )
          continuous = false
        }
      }
    }
    if (trace.curvedSegments !== undefined) {
      const seen = new Set<number>()
      if (
        !Array.isArray(trace.curvedSegments) ||
        trace.curvedSegments.some((index) => {
          const previous = trace.route[index - 1]
          const current = trace.route[index]
          const invalid =
            !Number.isInteger(index) ||
            seen.has(index) ||
            previous?.route_type !== "wire" ||
            current?.route_type !== "wire" ||
            previous.layer !== current.layer
          seen.add(index)
          return invalid
        })
      )
        add(
          "invalid-curve-metadata",
          "Curve annotations must name unique wire-chord ending indices",
          trace,
        )
    }
    if (!continuous) continue
    auditCopper(input, trace, layers, add)
  }
  return { valid: issues.length === 0, structurallyValid, issues }
}

function auditCopper(
  input: SimpleRouteJson,
  trace: Trace,
  physicalLayers: string[],
  add: (code: string, message: string, trace?: Trace, index?: number) => void,
) {
  type Segment = {
    a: Wire
    b: Wire
    startIndex: number
    endIndex: number
    run: number
    startDistance: number
    endDistance: number
  }
  const segments: Segment[] = []
  const runs: Wire[][] = []
  const cumulative = [0]
  let run: Wire[] | undefined
  let previousIndex = 0
  let planar = 0
  for (const [i, point] of trace.route.entries()) {
    if (point.route_type === "via") {
      run = undefined
    } else {
      if (!run) {
        run = []
        runs.push(run)
      }
      const previous = run.at(-1)
      // Zero-length handoff copies carry no copper length or bend direction.
      if (!previous || distance(previous, point) > contactEpsilon) {
        if (previous) {
          const nextDistance = planar + distance(previous, point)
          segments.push({
            a: previous,
            b: point,
            startIndex: previousIndex,
            endIndex: i,
            run: runs.length - 1,
            startDistance: planar,
            endDistance: nextDistance,
          })
          planar = nextDistance
        }
        run.push(point)
        previousIndex = i
      }
    }
    cumulative[i] = planar
  }
  for (const path of runs) {
    const width = Math.max(...path.map((point) => point.width))
    let returning = !tuningPathIsSelfClear(path, width)
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[i - 1],
        b = path[i],
        c = path[i + 1]
      const ux = b.x - a.x,
        uy = b.y - a.y
      const vx = c.x - b.x,
        vy = c.y - b.y
      const scale = Math.hypot(ux, uy) * Math.hypot(vx, vy)
      if (ux * vx + uy * vy < 0 && Math.abs(ux * vy - uy * vx) <= scale * 1e-9)
        returning = true
    }
    if (returning)
      add(
        "same-net-wire-shortcut",
        "Wire body returns onto itself and bypasses measured path length",
        trace,
      )
  }
  for (let i = 0; i < segments.length; i++)
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i],
        b = segments[j]
      if (a.run === b.run || a.a.layer !== b.a.layer) continue
      if (
        segmentDistance([a.a, a.b], [b.a, b.b]) <=
        (a.a.width + b.a.width) / 2 + contactEpsilon
      )
        add(
          "same-net-cross-run-shortcut",
          "Separate wire runs touch on the same layer",
          trace,
        )
    }
  const vias = trace.route.flatMap((point, i) =>
    point.route_type === "via" ? [{ point, i }] : [],
  )
  for (const { point, i } of vias) {
    const radius =
      (point.via_diameter ?? input.minViaPadDiameter ?? input.minTraceWidth) / 2
    const span = point.layers ?? physicalLayers
    for (const segment of segments) {
      if (!span.includes(segment.a.layer)) continue
      const reach = radius + segment.a.width / 2
      const gap = Math.max(
        segment.startDistance - cumulative[i],
        cumulative[i] - segment.endDistance,
        0,
      )
      if (gap <= reach + contactEpsilon) continue
      if (
        pointSegmentDistance(point, [segment.a, segment.b]) >
        reach + contactEpsilon
      )
        continue
      // A finely subdivided genuine approach can bend inside a via landing.
      // Exempt only the contiguous points still inside that same copper body.
      const endpointIndex =
        segment.startDistance > cumulative[i]
          ? segment.startIndex
          : segment.endIndex
      const approach = trace.route.slice(
        Math.min(i, endpointIndex),
        Math.max(i, endpointIndex) + 1,
      )
      if (approach.every((p) => distance(point, p) <= reach + contactEpsilon))
        continue
      add(
        "same-net-via-wire-shortcut",
        "Via land touches nonlocal wire copper and bypasses measured path length",
        trace,
        i,
      )
    }
  }
  for (let a = 0; a < vias.length; a++)
    for (let b = a + 1; b < vias.length; b++) {
      const first = vias[a],
        second = vias[b]
      // The existing manufactured drill rule also applies within one net;
      // electrical ownership does not allow two distinct holes to overlap.
      if (
        generatedEscapeHolesConflict(
          input,
          [{ ...trace, route: [first.point] }],
          [{ ...trace, route: [second.point] }],
        )
      )
        add(
          "same-net-via-hole-clearance",
          "Via drills violate the input's declared hole-to-hole clearance",
          trace,
          second.i,
        )
      const diameter = (via: Via) =>
        via.via_diameter ?? input.minViaPadDiameter ?? input.minTraceWidth
      const reach = (diameter(first.point) + diameter(second.point)) / 2
      if (
        !(first.point.layers ?? physicalLayers).some((layer) =>
          (second.point.layers ?? physicalLayers).includes(layer),
        )
      )
        continue
      if (cumulative[second.i] - cumulative[first.i] <= reach + contactEpsilon)
        continue
      if (distance(first.point, second.point) <= reach + contactEpsilon)
        add(
          "same-net-via-shortcut",
          "Nonlocal via lands touch and bypass the path between them",
          trace,
          second.i,
        )
    }
}

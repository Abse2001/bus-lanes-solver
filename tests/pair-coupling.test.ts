import { expect, test } from "bun:test"
import { distance, pointSegmentDistance } from "../lib/geometry"
import { pairCouplingReports } from "../lib/pair-coupling"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

// Exhaustive oracle: every sample checks every segment, without spatial pruning.
const exhaustive = (input: SimpleRouteJson, traces: Trace[]) => {
  const pair = input.differentialPairs![0]
  const segments = pair.connectionNames.map((name) =>
    [...(input.traces ?? []), ...traces]
      .filter((t) => t.connection_name === name || t.source_trace_id === name)
      .flatMap((t) =>
        t.route.slice(1).flatMap((b, i) => {
          const a = t.route[i]
          return a.route_type === "wire" &&
            b.route_type === "wire" &&
            a.layer === b.layer
            ? [{ a, b }]
            : []
        }),
      ),
  )
  const gap = pair.traceGap!,
    tolerance = Math.max(0.002, gap * 0.1)
  return segments.map((route, side) => {
    let total = 0,
      uncoupled = 0
    for (const { a, b } of route) {
      const length = distance(a, b),
        count = Math.max(1, Math.ceil(length / (tolerance / 2)))
      total += length
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count,
          p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        const gapAtPoint = Math.min(
          ...segments[1 - side]
            .filter((s) => s.a.layer === a.layer)
            .map(
              (s) =>
                pointSegmentDistance(p, [s.a, s.b]) - (a.width + s.a.width) / 2,
            ),
        )
        if (Math.abs(gapAtPoint - gap) + length / (2 * count) > tolerance)
          uncoupled += length / count
      }
    }
    return {
      name: pair.connectionNames[side],
      totalLengthMm: total,
      uncoupledLengthMm: uncoupled,
      coupledFraction: total ? 1 - uncoupled / total : 0,
    }
  })
}

test("indexed pair measurements exactly match exhaustive sampling across widths, layers and fixed fanouts", () => {
  let seed = 23
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const make = (name: string, side: number): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    coupledSection: [0, 119],
    route: Array.from(
      { length: 120 },
      (_, i): Wire => ({
        route_type: "wire",
        x: i / 10,
        y: side * 0.22 + Math.sin(i / 10) * 0.1,
        width: i < 30 ? 0.1 : 0.05 + random() * 0.3,
        layer: i < 70 ? "top" : side && i > 100 ? "inner1" : "bottom",
      }),
    ),
  })
  const traces = [make("P", 0), make("N", 1)]
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    connections: [],
    obstacles: [],
    bounds: { minX: -20, minY: -20, maxX: 20, maxY: 20 },
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.1, traceGap: 0.12 },
    ],
    traces: traces.map((t) => ({
      ...t,
      connection_name: undefined,
      source_trace_id: t.connection_name,
      route: t.route.slice(0, 2),
    })),
  }
  expect(pairCouplingReports(input, traces)[0].conductors).toEqual(
    exhaustive(input, traces),
  )
  // Overlapping, zero-length and missing mate segments must remain uncoupled.
  traces[1].route = traces[0].route.slice(0, 60)
  traces[1].route.splice(3, 0, traces[1].route[3])
  expect(pairCouplingReports(input, traces)[0].conductors).toEqual(
    exhaustive(input, traces),
  )
  traces[1].route = []
  input.traces = []
  expect(pairCouplingReports(input, traces)[0].conductors).toEqual(
    exhaustive(input, traces),
  )
})

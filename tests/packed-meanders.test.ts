import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { expect, test } from "bun:test"
import { tuneCoupledLengths } from "../lib/tune-coupled-lengths"
import { tuneSmoothLengths } from "../lib/smooth-length-tuning"
import {
  busLengthReports,
  minimumLengthTargets,
  pairLengthReports,
} from "../lib/route-lengths"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function fixture(paired: boolean) {
  const traces: Trace[] = (paired ? [-0.11, 0.11, 4] : [0, 4]).map(
    (y, i, all) => ({
      type: "pcb_trace",
      pcb_trace_id: `t${i}`,
      connection_name: `D${i}`,
      coupledSection: paired && i < 2 ? [0, 1] : undefined,
      route: [0, i === all.length - 1 ? 20 : 10].map((x) => ({
        x,
        y,
        route_type: "wire",
        layer: "top",
        width: 0.1,
      })),
    }),
  )
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -1, maxX: 22, minY: -15, maxY: 15 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: t.route as Wire[],
    })),
    buses: [
      {
        busId: "data",
        connectionNames: traces.map((t) => t.connection_name!),
        maxLengthSkew: 0.2,
      },
    ],
    differentialPairs: paired
      ? [
          {
            connectionNames: ["D0", "D1"],
            traceGap: 0.12,
            lengthTolerance: 0.1,
          },
        ]
      : [],
  }
  return { input, traces }
}
const height = (trace: Trace) =>
  Math.max(...trace.route.map((p) => p.y)) -
  Math.min(...trace.route.map((p) => p.y))
function validate(input: SimpleRouteJson, before: Trace[], after: Trace[]) {
  expect(busLengthReports(input, after).every((r) => r.matched)).toBe(true)
  expect(pairLengthReports(input, after).every((r) => r.matched)).toBe(true)
  expect(sharedPairSpacingReports(input, after).every((r) => r.matched)).toBe(
    true,
  )
  expect(routeAnglesAreConventional(after)).toBe(true)
  const copper = [...fixedCopper(input), ...after.flatMap(routeCopper)]
  for (const [i, t] of after.entries()) {
    expect(t.route[0]).toEqual(before[i].route[0])
    expect(t.route.at(-1)).toEqual(before[i].route.at(-1))
    expect(
      new VectorScene(input, input.connections[i], 0.1, copper).pathVisible(
        t.route,
      ),
    ).toBe(true)
    expect(tuningPathIsSelfClear(t.route, 0.2)).toBe(true)
  }
}

test("packed single-lane meanders use the available run to reduce transverse height", () => {
  const { input, traces } = fixture(false),
    original = structuredClone(traces)
  const targets = minimumLengthTargets(input, traces)
  const wide = tuneSmoothLengths(input, traces, targets)
  const packed = tuneSmoothLengths(input, traces, targets, {
    packMeanders: true,
  })
  expect(height(packed[0])).toBeLessThan(height(wide[0]) * 0.7)
  validate(input, traces, packed)
  expect(traces).toEqual(original)
})

test("packed differential meanders fill a compact bank with shared tangent curves", () => {
  const { input, traces } = fixture(true),
    original = structuredClone(traces)
  const wide = tuneCoupledLengths(input, traces)
  const packed = tuneCoupledLengths(input, traces, { packMeanders: true })
  expect(height(packed[0])).toBeLessThan(height(wide[0]) * 0.4)
  validate(input, traces, packed)
  expect(traces).toEqual(original)
})

test("the integrated matcher packs clear shared corridors before growing their bounds", () => {
  const { input, traces } = fixture(true)
  const solver = BusLanesSolver.forRefinement(input, traces, {
    smoothTuning: true,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(height(solver.traces[0])).toBeLessThan(1.5)
  validate(input, traces, solver.traces)
})

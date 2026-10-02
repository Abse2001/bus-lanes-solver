import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { bevelPairApproaches } from "../lib/bevel-pair-approaches"
import { chamferPairApproaches } from "../lib/chamfer-pair-approaches"
import { distance, length } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import type { SimpleRouteJson, Trace } from "../lib/types"

function pairFixture() {
  const traces: Trace[] = [
    [
      [0, 10],
      [0, 5],
      [0, 0],
      [3, 3],
      [5, 3],
    ],
    [
      [-0.22, 10],
      [-0.22, 5],
      [-0.22, -1],
      [-2.22, -3],
    ],
  ].map((points, index) => ({
    type: "pcb_trace",
    pcb_trace_id: `rail_${index}`,
    connection_name: `D${index}`,
    coupledSection: [0, 2],
    route: points.map(([x, y]) => ({
      route_type: "wire",
      x,
      y,
      width: 0.1,
      layer: "bottom",
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 6, minY: -4, maxY: 11 },
    obstacles: [],
    connections: traces.map((trace) => ({
      name: trace.connection_name!,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!].map((point) => ({
        x: point.x,
        y: point.y,
        layer: "bottom",
      })),
    })),
    differentialPairs: [
      { connectionNames: ["D0", "D1"], traceGap: 0.12, lengthTolerance: 0.127 },
    ],
  }
  return { input, traces }
}

test("compact acute pair bevels preserve shared interiors and reduce matching corrections", () => {
  const { input, traces } = pairFixture()
  const before = structuredClone({ input, traces })
  const compact = bevelPairApproaches(input, traces, [], 2.75)
  const wide = bevelPairApproaches(input, traces, [], 6)
  expect(compact[0].route.length).toBe(traces[0].route.length + 2)
  expect(length(compact[0].route)).toBeGreaterThan(length(wide[0].route))
  expect(length(compact[0].route)).toBeLessThan(length(traces[0].route))
  for (let rail = 0; rail < 2; rail++) {
    expect(compact[rail].route[0]).toEqual(traces[rail].route[0])
    expect(compact[rail].route.at(-1)).toEqual(traces[rail].route.at(-1))
    expect(compact[rail].route[1]).toEqual(traces[rail].route[1])
    expect(tuningPathIsSelfClear(compact[rail].route, 0.2)).toBe(true)
    for (let i = 1; i < compact[rail].route.length - 1; i++) {
      const [a, b, c] = compact[rail].route.slice(i - 1, i + 2)
      const dot =
        ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
        (distance(a, b) * distance(b, c))
      expect(dot).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-8)
    }
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: compact },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).issues,
  ).toEqual([])
  expect(
    chamferPairApproaches(input, input.connections, traces, [], 0.1, 0.1),
  ).toEqual(wide)
  expect({ input, traces }).toEqual(before)
})

test("acute bevel insertion remaps later curves without changing their geometry", () => {
  const { input, traces } = pairFixture()
  traces[0].route.push({
    route_type: "wire",
    x: 5.5,
    y: 3.2,
    layer: "bottom",
    width: 0.1,
  })
  traces[0].curvedSegments = [5]
  input.connections[0].pointsToConnect[1] = { x: 5.5, y: 3.2, layer: "bottom" }
  const next = bevelPairApproaches(input, traces, [], 2.75)
  expect(next[0].curvedSegments).toEqual([7])
  expect(next[0].route.slice(6)).toEqual(traces[0].route.slice(4))
  expect(traces[0].curvedSegments).toEqual([5])
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => bevelPairApproaches(input, traces, [], invalid)).toThrow(
      "positive finite number",
    )
  }
})

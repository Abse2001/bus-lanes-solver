import { expect, test } from "bun:test"
import { alignCoupledSectionBoundaries } from "../lib/align-coupled-section-boundaries"
import { distance, length } from "../lib/geometry"
import type { SimpleRouteJson, Trace } from "../lib/types"

const fixture = () => {
  const traces: Trace[] = [
    [
      [0, 0],
      [1, 0],
      [3, 0],
      [5, 0],
      [6, 0.2],
    ],
    [
      [-1, -0.22],
      [0, -0.22],
      [4, -0.22],
      [6, -0.22],
      [7, 0.2],
    ],
  ].map((points, side) => ({
    type: "pcb_trace",
    pcb_trace_id: `D${side}`,
    connection_name: `D${side}`,
    coupledSection: [1, 3],
    curvedSegments: [4],
    route: points.map(([x, y]) => ({
      route_type: "wire",
      x,
      y,
      layer: "bottom",
      width: 0.1,
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 8, minY: -2, maxY: 2 },
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

test("shared boundary labels cover only the common parallel copper and remap later curves", () => {
  const { input, traces } = fixture()
  const before = structuredClone({ input, traces })
  const next = alignCoupledSectionBoundaries(input, traces)
  expect(next[0].route).toEqual(traces[0].route)
  expect(next[1].route.map((point) => point.x)).toEqual([-1, 0, 1, 4, 5, 6, 7])
  expect(next[1].coupledSection).toEqual([2, 4])
  expect(next[1].curvedSegments).toEqual([6])
  for (const side of [0, 1]) {
    const trace = next[side],
      section = trace.coupledSection!
    expect(trace.route[section[0]].x).toBeCloseTo(1, 12)
    expect(trace.route[section[1]].x).toBeCloseTo(5, 12)
    expect(trace.route[0]).toEqual(traces[side].route[0])
    expect(trace.route.at(-1)).toEqual(traces[side].route.at(-1))
    expect(length(trace.route)).toBeCloseTo(length(traces[side].route), 12)
    expect(trace.route.at(-2)).toEqual(traces[side].route.at(-2))
    expect(distance(trace.route.at(-2)!, trace.route.at(-1)!)).toBeCloseTo(
      distance(traces[side].route.at(-2)!, traces[side].route.at(-1)!),
      12,
    )
  }
  expect(
    distance(
      next[0].route[next[0].coupledSection![0]],
      next[1].route[next[1].coupledSection![0]],
    ) - 0.1,
  ).toBeCloseTo(0.12, 12)
  expect({ input, traces }).toEqual(before)
})

test("curved boundary legs and unrelated headings are never relabeled as straight shared copper", () => {
  const { input, traces } = fixture()
  traces[0].curvedSegments = [2, 3, 4]
  traces[1].curvedSegments = [2, 3, 4]
  expect(alignCoupledSectionBoundaries(input, traces)).toEqual(traces)
  for (const trace of traces) trace.curvedSegments = []
  traces[1].route[2].y = -0.1
  expect(alignCoupledSectionBoundaries(input, traces)).toEqual(traces)
})

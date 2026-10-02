import { expect, test } from "bun:test"
import { length } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { tuneSmoothLengths } from "../lib/smooth-length-tuning"
import { fixedCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

function narrowChannel(): { input: SimpleRouteJson; trace: Trace } {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -1, maxX: 4, minY: -1, maxY: 1 },
    obstacles: [-1, 1].map((sign) => ({
      type: "rect",
      center: { x: 1.5, y: sign * 0.525 },
      width: 5,
      height: 0.49,
      layers: ["top"],
      connectedTo: [],
    })),
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
    ],
  }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "lane_D",
    connection_name: "D",
    route: [0, 1, 2, 3].map((x) => ({
      x,
      y: 0,
      route_type: "wire",
      layer: "top",
      width: 0.1,
    })),
  }
  return { input, trace }
}

test("smooth tuning distributes a correction across narrow ordinary approach runs", () => {
  const { input, trace } = narrowChannel()
  // Leave the middle run coupled: each of the two remaining 1 mm runs can
  // fit only part of the correction inside the 0.26 mm centerline corridor.
  trace.coupledSection = [1, 2]
  input.traces = [
    [-0.5, 0],
    [3, 3.5],
  ].map((coordinates, index) => ({
    type: "pcb_trace",
    pcb_trace_id: `fixed_approach_${index}`,
    connection_name: "D",
    route: coordinates.map((x) => ({
      x,
      y: 0,
      route_type: "wire",
      layer: "top",
      width: 0.1,
    })),
  }))
  const before = structuredClone({ input, trace })
  const [tuned] = tuneSmoothLengths(input, [trace], new Map([["D", 4.06]]))
  expect(length(tuned.route)).toBeCloseTo(3.06, 8)
  expect(tuned.route[0]).toEqual(trace.route[0])
  expect(tuned.route.at(-1)).toEqual(trace.route.at(-1))
  const [start, end] = tuned.coupledSection!
  expect(tuned.route.slice(start, end + 1)).toEqual(trace.route.slice(1, 3))
  expect(tuned.curvedSegments!.some((index) => index < start)).toBe(true)
  expect(tuned.curvedSegments!.some((index) => index > end)).toBe(true)
  expect(tuningPathIsSelfClear(tuned.route, 0.2)).toBe(true)
  const scene = new VectorScene(
    input,
    input.connections[0],
    0.1,
    fixedCopper(input),
  )
  expect(scene.pathVisible(tuned.route)).toBe(true)
  expect(
    tuned.route.every(
      (point) =>
        point.route_type === "wire" &&
        point.layer === "top" &&
        point.width === 0.1,
    ),
  ).toBe(true)
  expect({ input, trace }).toEqual(before)
})

test("distributed tuning cannot alter a fully coupled route to hide an infeasible correction", () => {
  const { input, trace } = narrowChannel()
  trace.coupledSection = [0, trace.route.length - 1]
  const before = structuredClone(trace)
  expect(() =>
    tuneSmoothLengths(input, [trace], new Map([["D", 3.06]])),
  ).toThrow("Insufficient tuning clearance for D")
  expect(trace).toEqual(before)
})

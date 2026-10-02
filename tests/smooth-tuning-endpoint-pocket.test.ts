import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { length } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { tuneSmoothLengths } from "../lib/smooth-length-tuning"
import { fixedCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("a compact smooth bank uses a terminal pocket when the remaining approach has no tuning clearance", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -1, maxX: 7, minY: -1, maxY: 1 },
    obstacles: [-1, 1].map((sign) => ({
      type: "rect",
      center: { x: 3.9, y: sign * 0.575 },
      width: 6.2,
      height: 0.85,
      layers: ["top"],
      connectedTo: [],
    })),
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 6, y: 0, layer: "top" },
        ],
      },
    ],
  }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "D",
    connection_name: "D",
    route: [0, 6].map((x) => ({
      route_type: "wire",
      x,
      y: 0,
      width: 0.1,
      layer: "top",
    })),
  }
  const before = structuredClone({ input, trace })
  const [tuned] = tuneSmoothLengths(input, [trace], new Map([["D", 6.3]]))
  expect(length(tuned.route)).toBeCloseTo(6.3, 8)
  expect(tuned.route[0]).toEqual(trace.route[0])
  expect(tuned.route.at(-1)).toEqual(trace.route.at(-1))
  // The only usable pocket is before the two rails begin at x=0.8.
  expect(tuned.curvedSegments!.length).toBeGreaterThan(0)
  const curvedPoints = tuned.curvedSegments!.flatMap((index) =>
    tuned.route.slice(index - 1, index + 1),
  )
  expect(Math.max(...curvedPoints.map((point) => point.x))).toBeLessThan(0.8)
  expect(tuningPathIsSelfClear(tuned.route, 0.2)).toBe(true)
  expect(
    new VectorScene(
      input,
      input.connections[0],
      0.1,
      fixedCopper(input),
    ).pathVisible(tuned.route),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [tuned] },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).issues,
  ).toEqual([])
  expect({ input, trace }).toEqual(before)
})

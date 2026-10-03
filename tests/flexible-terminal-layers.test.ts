import { expect, test } from "bun:test"
import { BusLanesSolver, type SimpleRouteJson } from "../lib"

const input: SimpleRouteJson = {
  bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
  layerCount: 4,
  allowedLayers: ["inner1", "inner2"],
  minTraceWidth: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  obstacles: [
    {
      center: { x: 0, y: 0 },
      width: 0.3,
      height: 5,
      layers: ["inner1"],
      connectedTo: [],
    },
  ],
  connections: [
    {
      name: "control",
      pointsToConnect: [
        { x: -1, y: 0, layer: "inner1" },
        { x: 1, y: 0, layer: "inner1" },
      ],
    },
  ],
}

test("a small remainder can use another reachable terminal layer", () => {
  const before = structuredClone(input)
  const solver = new BusLanesSolver(
    input,
    { denseSearch: true },
    new Map([["control", ["inner1", "inner2"]]]),
  )
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toHaveLength(1)
  expect(
    solver.traces[0].route.every(
      (point) => point.route_type === "wire" && point.layer === "inner2",
    ),
  ).toBe(true)
  expect(input).toEqual(before)
})

test("a small remainder cannot leave its sole permitted terminal layer", () => {
  const solver = new BusLanesSolver(
    input,
    { denseSearch: true },
    new Map([["control", ["inner1"]]]),
  )
  solver.solve()
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.traces).toHaveLength(0)
})

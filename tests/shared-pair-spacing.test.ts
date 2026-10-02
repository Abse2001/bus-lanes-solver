import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { offsetPath } from "../lib/coupled-pair-routing"
import { pairCouplingReports } from "../lib/pair-coupling"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

const input: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
  connections: [],
  obstacles: [],
  differentialPairs: [
    { connectionNames: ["P", "N"], lengthTolerance: 0.127, traceGap: 0.12 },
  ],
}
const trace = (name: string, path: Point[]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  coupledSection: [0, path.length - 1],
  route: path.map((p) => ({
    ...p,
    route_type: "wire",
    width: 0.1,
    layer: "top",
  })),
})

test("45-degree offset pair corners retain coupling", () => {
  const center = [
    { x: -4, y: 0 },
    { x: 0, y: 0 },
    { x: 4, y: 4 },
  ]
  const rails = [
    trace("P", offsetPath(center, 0.11)),
    trace("N", offsetPath(center, -0.11)),
  ]
  expect(sharedPairSpacingReports(input, rails)[0].matched).toBe(true)
  expect(pairCouplingReports(input, rails)[0].matched).toBe(true)
})

test("a rail cannot leave its mate in the middle of a shared section", () => {
  const rails = [
    trace("P", [
      { x: -4, y: 0 },
      { x: 4, y: 0 },
    ]),
    trace("N", [
      { x: -4, y: 0.22 },
      { x: -2, y: 0.22 },
      { x: -1, y: 1.22 },
      { x: 1, y: 1.22 },
      { x: 2, y: 0.22 },
      { x: 4, y: 0.22 },
    ]),
  ]
  expect(sharedPairSpacingReports(input, rails)[0].matched).toBe(false)
  expect(pairCouplingReports(input, rails)[0].matched).toBe(false)
})

test("independent equal-length rails cannot pass without a shared corridor", () => {
  const rails = [
    trace("P", [
      { x: -4, y: 0 },
      { x: 4, y: 0 },
    ]),
    trace("N", [
      { x: -4, y: 2 },
      { x: 4, y: 2 },
    ]),
  ]
  expect(pairCouplingReports(input, rails)[0].matched).toBe(false)
  delete rails[0].coupledSection
  delete rails[1].coupledSection
  expect(pairCouplingReports(input, rails)[0].matched).toBe(false)
})

test("unequal handoff indices do not falsely flag parallel copper", () => {
  const rails = [
    trace("P", [
      { x: -4, y: 0 },
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ]),
    trace("N", [
      { x: -4, y: 0.22 },
      { x: 0, y: 0.22 },
      { x: 4, y: 0.22 },
    ]),
  ]
  rails[1].coupledSection = [1, 2]
  expect(sharedPairSpacingReports(input, rails)[0].matched).toBe(true)
  rails[1].route[0] = {
    ...rails[1].route[0],
    route_type: "wire",
    layer: "bottom",
    width: 0.1,
  }
  expect(sharedPairSpacingReports(input, rails)[0].matched).toBe(false)
})

test("solver success rejects separated equal-length paired output", () => {
  const rails = [
    trace("P", [
      { x: -4, y: 0 },
      { x: 4, y: 0 },
    ]),
    trace("N", [
      { x: -4, y: 2 },
      { x: 4, y: 2 },
    ]),
  ]
  const solver = new BusLanesSolver({
    ...input,
    connections: rails.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        x: p.x,
        y: p.y,
        layer: "top",
      })),
    })),
  })
  solver.step()
  solver.traces = rails
  solver.phase = "validate_output"
  solver.step()
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.error).toContain("pair spacing")
})

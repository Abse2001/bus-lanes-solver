import { expect, test } from "bun:test"
import { routeCoupledPair } from "../lib/coupled-pair-routing"
import { pairLengthReports } from "../lib/route-lengths"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { length } from "../lib/geometry"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

function blockedPair(): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 12, minY: -3, maxY: 3 },
    obstacles: [
      {
        type: "rect",
        shape: "circle",
        center: { x: 5, y: 0 },
        width: 1,
        height: 1,
        layers: ["top"],
        connectedTo: ["POWER"],
      },
    ],
    connections: [-0.11, 0.11].map((y, i) => ({
      name: i ? "N" : "P",
      pointsToConnect: [
        { x: 0, y, layer: "top" },
        { x: 10, y, layer: "top" },
      ],
    })),
    differentialPairs: [
      {
        connectionNames: ["P", "N"],
        traceGap: 0.12,
        lengthTolerance: 0.127,
      },
    ],
  }
}
function solvePair(
  input: SimpleRouteJson,
  penalty = 0,
  fixed = fixedCopper(input),
) {
  const generator = routeCoupledPair(
    input,
    input.differentialPairs![0],
    fixed,
    {
      copper: [],
      penalty,
    },
  )
  let step = generator.next(),
    iterations = 0
  for (; !step.done && iterations < 8000; iterations++) step = generator.next()
  expect(step.done).toBe(true)
  expect(step.value).not.toBeNull()
  const traces = step.value as Trace[]
  for (const [i, trace] of traces.entries())
    expect(
      new VectorScene(input, input.connections[i], 0.1, [
        ...fixed,
        ...traces.flatMap(routeCopper),
      ]).pathVisible(trace.route),
    ).toBe(true)
  return { traces, iterations }
}

test("computed pair alternatives are reused without sharing mutable trace output", () => {
  const input = blockedPair()
  const first = solvePair(input)
  expect(first.iterations).toBeGreaterThan(0)
  const expected = structuredClone(first.traces)
  first.traces[0].route[0].x = 999
  const repeated = solvePair(input)
  expect(repeated.iterations).toBe(0)
  expect(repeated.traces).toEqual(expected)
})

test("a changed physical obstacle invalidates computed pair alternatives", () => {
  const input = blockedPair()
  const first = solvePair(input)
  input.obstacles[0].center.y = 0.2
  const changed = solvePair(input)
  expect(changed.iterations).toBeGreaterThan(0)
  expect(changed.traces).not.toEqual(first.traces)
})

test("congestion searches compute their own pair alternatives", () => {
  const input = blockedPair()
  solvePair(input)
  const withPenalty = solvePair(input, 1)
  expect(withPenalty.iterations).toBeGreaterThan(0)
})

test("warm retries preserve compact matched candidates and final checks include fixed copper", () => {
  const input: SimpleRouteJson = {
    ...blockedPair(),
    bounds: { minX: -3, maxX: 13, minY: -4, maxY: 4 },
    obstacles: [],
    connections: [-1, 1].map((sign, i) => ({
      name: i ? "N" : "P",
      pointsToConnect: [
        { x: 0, y: sign * 0.4, layer: "top" },
        { x: 10 + sign * 0.025, y: sign * 0.4, layer: "top" },
      ],
    })),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "existing_P_prefix",
        connection_name: "P",
        route: [
          { route_type: "wire", x: -0.2, y: -0.4, layer: "top", width: 0.1 },
          { route_type: "wire", x: 0, y: -0.4, layer: "top", width: 0.1 },
        ],
      },
    ],
  }
  const first = solvePair(input)
  // Package approaches can now be tuned within the compact candidate.
  expect(pairLengthReports(input, first.traces)[0].matched).toBe(true)
  expect(
    first.traces.reduce((sum, trace) => sum + length(trace.route), 0),
  ).toBeLessThan(
    1.25 *
      input.connections.reduce(
        (sum, connection) => sum + length(connection.pointsToConnect),
        0,
      ),
  )
  const repeated = solvePair(input)
  expect(repeated.iterations).toBe(0)
  expect(repeated.traces).toEqual(first.traces)
  expect(pairLengthReports(input, repeated.traces)[0].matched).toBe(true)
  // A search stopping condition must never replace final full-copper checks.
  const validationInput = blockedPair()
  validationInput.obstacles = []
  validationInput.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed_P_prefix",
      connection_name: "P",
      route: [
        { route_type: "wire", x: -1, y: -0.11, layer: "bottom", width: 0.1 },
        { route_type: "wire", x: 0, y: -0.11, layer: "bottom", width: 0.1 },
      ],
    },
  ]
  const carriers: Trace[] = validationInput.connections.map((connection) => ({
    type: "pcb_trace",
    pcb_trace_id: connection.name,
    connection_name: connection.name,
    route: connection.pointsToConnect.map((point) => ({
      ...point,
      route_type: "wire",
      width: 0.1,
    })),
  }))
  expect(pairLengthReports(validationInput, carriers)[0].matched).toBe(false)
  const solver = new BusLanesSolver(validationInput)
  solver.step()
  solver.traces = carriers
  solver.phase = "validate_output"
  solver.step()
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.error).toContain("Final bus length skew violation")
})

test("a changed fixed copper scene invalidates computed alternatives", () => {
  const input = blockedPair()
  const fixed = [
    {
      a: { x: 5, y: 0 },
      b: { x: 5, y: 0 },
      radius: 0.75,
      layer: "top",
      owners: ["POWER"],
    },
  ]
  const first = solvePair(input, 0, fixed)
  fixed[0].radius = 1
  const changed = solvePair(input, 0, fixed)
  expect(changed.iterations).toBeGreaterThan(0)
  expect(changed.traces).not.toEqual(first.traces)
})

test("member layer changes on the same request never reuse traces on the old layer", () => {
  const input = blockedPair()
  const first = solvePair(input)
  for (const connection of input.connections)
    for (const point of connection.pointsToConnect) point.layer = "bottom"
  input.obstacles[0].layers = ["bottom"]
  const changed = solvePair(input)
  expect(changed.iterations).toBeGreaterThan(0)
  expect(changed.traces).not.toEqual(first.traces)
  expect(
    changed.traces.every((trace) =>
      trace.route.every(
        (point) => point.route_type === "wire" && point.layer === "bottom",
      ),
    ),
  ).toBe(true)
})

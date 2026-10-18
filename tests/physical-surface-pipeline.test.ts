import { expect, test } from "bun:test"
import { BusLanesPipelineSolver } from "../lib"
import type { SimpleRouteJson } from "../lib/types"

function freshNativeBus(): SimpleRouteJson {
  const connections = Array.from({ length: 4 }, (_, index) => ({
    name: `D${index}`,
    pointsToConnect: [
      { x: index % 2 ? -3 : -4, y: index, layer: "top" },
      { x: index % 2 ? 3 : 4, y: index, layer: "top" },
    ],
  }))
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.15,
    bounds: { minX: -8, maxX: 8, minY: -2, maxY: 6 },
    connections,
    obstacles: connections.flatMap((connection) =>
      connection.pointsToConnect.map((point, end) => ({
        componentId: end ? "receiver" : "driver",
        shape: "circle" as const,
        center: { x: point.x, y: point.y },
        width: 0.18,
        height: 0.18,
        layers: ["top"],
        connectedTo: [connection.name],
      })),
    ),
    traces: [],
    differentialPairs: [],
    buses: [0, 1].map((index) => ({
      busId: `B${index}`,
      connectionNames: [`D${index * 2}`, `D${index * 2 + 1}`],
      maxLengthSkew: 0.15,
      // No geometry can satisfy both bus bounds. Physical routing remains useful.
      minLength: 12,
      maxLength: 3,
    })),
  }
}

test("physical goal freshly routes native Top/Bottom pads and reports impossible bus timing separately", () => {
  const input = freshNativeBus()
  const before = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input, {
    goal: "physical",
    maxSearchIterations: 10000,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.error).toBeNull()
  expect(input).toEqual(before)
  const output = solver.getOutput()
  expect(output.traces).toHaveLength(4)
  expect({ ...output, traces: undefined }).toEqual({
    ...before,
    traces: undefined,
  })
  const report = solver.getAcceptanceReport()!
  expect(report.physicalRoutingAccepted).toBe(true)
  expect(report.ddrTimingAccepted).toBe(false)
  expect(report.connectedSignals).toBe(4)
  expect(Object.values(report.gates).every(Boolean)).toBe(true)
  expect(
    solver
      .getLengthReports()
      .buses.every(
        (bus) =>
          !bus.matched && !bus.withinLengthLimit && !bus.aboveMinimumLength,
      ),
  ).toBe(true)
  expect(report.nativeDrc.valid).toBe(true)
  expect(report.nativeDrc.issues).toHaveLength(0)
  expect(solver.getLengthTuningReport()?.timingSolved).toBe(false)
  expect(
    solver.getLengthTuningReport()?.portfolio.failures.length,
  ).toBeGreaterThan(0)
})

test("default matched goal retains the impossible native bus bounds", () => {
  const solver = new BusLanesPipelineSolver(freshNativeBus(), {
    maxSearchIterations: 500,
  })
  solver.solve()
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.getAcceptanceReport()).toBeNull()
  expect(() => solver.getOutput()).toThrow()
})

test("physical goal rejects unsupported topology explicitly", () => {
  expect(
    () =>
      new BusLanesPipelineSolver(freshNativeBus(), {
        goal: "physical",
        fanout: "none",
      }),
  ).toThrow("automatic fanout")
  expect(
    () =>
      new BusLanesPipelineSolver(
        { ...freshNativeBus(), allowedLayers: ["inner1"] },
        { goal: "physical" },
      ),
  ).toThrow("Top/Bottom")
})

test("stopping the post-route stage retains its complete physical checkpoint", () => {
  const input = freshNativeBus()
  for (const bus of input.buses!) {
    delete bus.minLength
    delete bus.maxLength
  }
  const solver = new BusLanesPipelineSolver(input, {
    goal: "physical",
    postRoutingLengthTuning: {
      proposalFactories: [
        function* () {
          while (true) yield undefined
        },
      ],
    },
  })
  for (
    let step = 0;
    step < 20000 && solver.phase !== "post_route_length_tuning";
    step++
  )
    solver.step()
  expect(solver.phase).toBe("post_route_length_tuning")
  solver.step()
  solver.tryFinalAcceptance()
  expect(solver.solved).toBe(true)
  expect(solver.getOutput().traces).toHaveLength(4)
  expect(solver.getAcceptanceReport()?.physicalRoutingAccepted).toBe(true)
  expect(solver.getLengthTuningReport()?.reason).toBe("interrupted")
  expect(solver.getLengthTuningReport()?.timingSolved).toBe(false)
})

test("the physical-only option can skip post-route length tuning", () => {
  const solver = new BusLanesPipelineSolver(freshNativeBus(), {
    goal: "physical",
    postRoutingLengthTuning: false,
  })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.getAcceptanceReport()?.physicalRoutingAccepted).toBe(true)
  expect(solver.getLengthTuningReport()).toBeNull()
})

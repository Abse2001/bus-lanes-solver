import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  SingleLayerConnectivitySolver,
  BusLanesPipelineSolver,
  busLengthReports,
  pairLengthReports,
  type Connection,
  type SimpleRouteJson,
} from "../lib"
import { loadAm3352Sample } from "../scripts/am3352-samples"

function smallNativeInput() {
  const connections: Connection[] = [
    {
      name: "P",
      source_trace_id: "source_P",
      pointsToConnect: [
        { x: -3, y: 0, layer: "top", pcb_port_id: "P_start" },
        { x: 3, y: 0, layer: "top", pcb_port_id: "P_end" },
      ],
    },
    {
      name: "N",
      source_trace_id: "source_N",
      pointsToConnect: [
        { x: -2, y: 1, layer: "top", pcb_port_id: "N_start" },
        { x: 2, y: 1, layer: "top", pcb_port_id: "N_end" },
      ],
    },
  ]
  const power: Connection = {
    name: "POWER",
    source_trace_id: "source_POWER",
    pointsToConnect: [
      { x: -3, y: 3, layer: "top", pcb_port_id: "POWER_start" },
      { x: -2, y: 3, layer: "inner1", pcb_port_id: "POWER_end" },
    ],
  }
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["inner1"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    bounds: { minX: -5, maxX: 5, minY: -2, maxY: 5 },
    connections,
    obstacles: [...connections, power].flatMap((connection) =>
      connection.pointsToConnect.map((point, side) => ({
        type: "rect" as const,
        shape: "circle" as const,
        componentId: `package_${side}`,
        center: { x: point.x, y: point.y },
        width: 0.3,
        height: 0.3,
        layers: [point.layer],
        connectedTo: [connection.name, point.pcb_port_id!],
      })),
    ),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed_power",
        connection_name: power.name,
        source_trace_id: power.source_trace_id,
        route: [
          { route_type: "wire", x: -3, y: 3, layer: "top", width: 0.1 },
          { route_type: "wire", x: -2.5, y: 3, layer: "top", width: 0.1 },
          {
            route_type: "via",
            x: -2.5,
            y: 3,
            from_layer: "top",
            to_layer: "inner1",
            layers: ["top", "inner1", "inner2", "bottom"],
            via_diameter: 0.3,
            via_hole_diameter: 0.15,
          },
          { route_type: "wire", x: -2.5, y: 3, layer: "inner1", width: 0.1 },
          { route_type: "wire", x: -2, y: 3, layer: "inner1", width: 0.1 },
        ],
      },
    ],
    buses: [
      { busId: "DATA", connectionNames: ["P", "N"], maxLengthSkew: 0.01 },
    ],
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.01, traceGap: 0.1 },
    ],
  }
  return { input, power }
}

test("native connectivity preserves fixed copper and exposes unmatched timing and routed graphics", () => {
  const { input, power } = smallNativeInput()
  const before = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input, {
    goal: "connectivity",
    connectivity: { fixedConnections: [power] },
  })
  expect(() => solver.getOutput()).toThrow("not solved")
  solver.solve()
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(input).toEqual(before)
  const output = solver.getOutput()
  expect(output.traces).toHaveLength(3)
  expect(output.traces[0]).toEqual(before.traces![0])
  expect(output.buses).toEqual(before.buses)
  expect(output.differentialPairs).toEqual(before.differentialPairs)
  for (const connection of input.connections) {
    const trace = solver.traces.find(
      (trace) => trace.connection_name === connection.name,
    )!
    expect(trace.source_trace_id).toBe(connection.source_trace_id)
    expect(trace.route[0]).toMatchObject({
      ...connection.pointsToConnect[0],
      route_type: "wire",
    })
    expect(trace.route.at(-1)).toMatchObject({
      ...connection.pointsToConnect[1],
      route_type: "wire",
    })
    const viaIndices = trace.route.flatMap((point, index) =>
      point.route_type === "via" ? [index] : [],
    )
    expect(viaIndices).toHaveLength(2)
    for (const [index, point] of trace.route.entries()) {
      if (point.route_type === "wire") {
        expect(point.layer).toBe(
          index > viaIndices[0] && index < viaIndices[1] ? "inner1" : "top",
        )
      } else {
        expect(point.layers).toEqual(["top", "inner1", "inner2", "bottom"])
        for (const terminal of connection.pointsToConnect)
          expect(
            Math.hypot(point.x - terminal.x, point.y - terminal.y),
          ).toBeGreaterThan(1e-8)
      }
    }
  }
  const validationInput = {
    ...input,
    connections: [...input.connections, power],
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: validationInput,
    routedSrj: { ...output, connections: validationInput.connections },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.issues).toEqual([])
  expect(drc.valid).toBe(true)
  expect(
    busLengthReports(input, solver.traces).some((bus) => !bus.matched),
  ).toBe(true)
  expect(
    pairLengthReports(input, solver.traces).some((pair) => !pair.matched),
  ).toBe(true)
  expect(solver.stats.matchingEnforced).toBe(false)
  expect(
    solver.visualize().lines?.some((line) => line.layer === "inner1"),
  ).toBe(true)
})

test("exhausted negotiation never publishes provisional routes", async () => {
  const { input, metadata } = await loadAm3352Sample("control")
  input.allowedLayers = ["inner1"]
  const solver = new SingleLayerConnectivitySolver(input, {
    fixedConnections: metadata.powerConnections,
    maxPasses: 0,
  })
  solver.solve()
  expect(solver.solved).toBe(false)
  expect(solver.failed).toBe(true)
  expect(solver.traces).toEqual([])
  expect(() => solver.getOutput()).toThrow("pass budget")
})

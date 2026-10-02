import { expect, spyOn, test } from "bun:test"
import { BusLanesPipelineSolver, BusLanesSolver } from "../lib"
import type { SimpleRouteJson } from "../lib"
import { loadAm3352Sample } from "../scripts/am3352-samples"

/** Isolate layer negotiation from the child router's search. A failed child
 * is the trigger for a retry; each captured input is actual pipeline output. */
function failedRoutingAttempts(input: SimpleRouteJson) {
  const attempts: SimpleRouteJson[] = []
  const childStep = spyOn(BusLanesSolver.prototype, "_step").mockImplementation(
    function (this: BusLanesSolver) {
      attempts.push(structuredClone(this.input))
      this.failed = true
      this.error = "No planar route on the assigned layers"
    },
  )
  try {
    const solver = new BusLanesPipelineSolver(input)
    solver.solve()
    expect(solver.failed).toBe(true)
    return attempts
  } finally {
    childStep.mockRestore()
  }
}

test("layer retries retain balanced buses and every immutable power dogbone", async () => {
  const { input } = await loadAm3352Sample("control")
  const before = structuredClone(input)
  const attempts = failedRoutingAttempts(input)
  expect(attempts).toHaveLength(input.layerCount)
  const assignments: string[][] = []
  for (const attempt of attempts) {
    expect(attempt.traces!.slice(0, input.traces!.length)).toEqual(
      input.traces!,
    )
    const dogbones = attempt.traces!.slice(input.traces!.length)
    expect(dogbones).toHaveLength(input.connections.length * 2)
    for (const connection of input.connections) {
      const escapes = dogbones.filter(
        (trace) => trace.connection_name === connection.name,
      )
      expect(escapes).toHaveLength(2)
      for (const terminal of connection.pointsToConnect) {
        const escape = escapes.find(
          (trace) =>
            trace.route[0].x === terminal.x && trace.route[0].y === terminal.y,
        )!
        expect(escape).toBeDefined()
        expect(
          escape.route.filter((point) => point.route_type === "via"),
        ).toHaveLength(1)
      }
    }
    const assigned = (attempt.buses ?? []).map((bus) => {
      const layers = new Set(
        attempt.connections
          .filter((connection) => bus.connectionNames.includes(connection.name))
          .flatMap((connection) =>
            connection.pointsToConnect.map((point) => point.layer),
          ),
      )
      expect(layers.size).toBe(1)
      return [...layers][0]
    })
    expect(new Set(assigned).size).toBe(2)
    assignments.push(assigned)
  }
  for (const busIndex of [0, 1])
    expect(new Set(assignments.map((layers) => layers[busIndex]))).toEqual(
      new Set(["inner1", "inner2", "bottom"]),
    )
  expect(
    new Set(assignments.slice(0, 3).map((layers) => layers.join(","))).size,
  ).toBe(3)
  for (const busIndex of [0, 1])
    expect(
      new Set(assignments.slice(0, 3).map((layers) => layers[busIndex])).size,
    ).toBe(3)
  expect(input).toEqual(before)
})

test("layer retries keep explicit bus preferences and allowed layers", async () => {
  const { input } = await loadAm3352Sample("control")
  input.buses![0].preferredLayer = "bottom"
  input.buses![0].allowedLayers = ["inner1", "bottom"]
  input.buses![1].preferredLayer = "inner2"
  input.buses![1].allowedLayers = ["inner2"]
  const attempts = failedRoutingAttempts(input)
  expect(attempts).toHaveLength(input.layerCount)
  for (const attempt of attempts)
    for (const [index, layer] of ["bottom", "inner2"].entries()) {
      const names = attempt.buses![index].connectionNames
      expect(
        attempt.connections
          .filter((connection) => names.includes(connection.name))
          .every((connection) =>
            connection.pointsToConnect.every((point) => point.layer === layer),
          ),
      ).toBe(true)
    }
})

test("global carrier layers constrain every generated escape on every retry, including clock and controls", async () => {
  const { input } = await loadAm3352Sample("inner-layers")
  input.buses![0].preferredLayer = "bottom"
  const attempts = failedRoutingAttempts(input)
  expect(attempts).toHaveLength(input.layerCount)
  for (const attempt of attempts) {
    expect(attempt.allowedLayers).toEqual(["inner1", "inner2"])
    expect(
      attempt.connections.every((c) =>
        c.pointsToConnect.every((p) => input.allowedLayers!.includes(p.layer)),
      ),
    ).toBe(true)
    const escapes = attempt.traces!.slice(input.traces!.length)
    expect(escapes).toHaveLength(94)
    for (const escape of escapes) {
      const via = escape.route.find((p) => p.route_type === "via")!
      expect(input.allowedLayers).toContain(via.to_layer)
      expect(via.layers).toEqual(["top", "inner1", "inner2", "bottom"])
    }
    expect(attempt.traces!.slice(0, 161)).toEqual(input.traces!)
  }
})

test("global carrier layers cannot move a bus or existing handoff onto an excluded layer", () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    allowedLayers: ["inner1", "inner2"],
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: 0, y: 2, layer: "bottom" },
          { x: 0, y: -2, layer: "bottom" },
        ],
      },
    ],
  }
  for (const options of [{}, { fanout: "none" as const }]) {
    const solver = new BusLanesPipelineSolver(input, options)
    solver.solve()
    expect(solver.failed).toBe(true)
    expect(solver.traces).toEqual([])
  }
  const conflicting = new BusLanesPipelineSolver({
    ...input,
    buses: [{ busId: "D", connectionNames: ["D"], allowedLayers: ["bottom"] }],
  })
  conflicting.solve()
  expect(conflicting.failed).toBe(true)
  expect(conflicting.traces).toEqual([])
})

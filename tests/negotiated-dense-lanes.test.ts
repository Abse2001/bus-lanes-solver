import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { routeCopper, VectorScene } from "../lib/vector-scene"

test("dense lane negotiation completes staggered lanes without overlapping copper", () => {
  const input = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -1, maxX: 11, minY: -1, maxY: 9 },
    obstacles: [],
    connections: Array.from({ length: 13 }, (_, i) => ({
      name: `D${i}`,
      pointsToConnect: [
        { x: 0, y: i * 0.2, layer: "top" },
        { x: 10, y: i * 0.2 + 2, layer: "top" },
      ],
    })),
  }
  const solver = new BusLanesSolver(input, { denseSearch: true })
  solver.solve()
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toHaveLength(13)
  const copper = solver.traces.flatMap(routeCopper)
  for (const connection of input.connections) {
    const trace = solver.traces.find(
      (t) => t.connection_name === connection.name,
    )!
    expect(
      new VectorScene(input, connection, 0.1, copper).pathVisible(trace.route),
    ).toBe(true)
    expect(trace.route[0]).toMatchObject(connection.pointsToConnect[0])
    expect(trace.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
  }
})

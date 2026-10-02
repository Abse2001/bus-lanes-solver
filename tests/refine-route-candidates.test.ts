import { expect, test } from "bun:test"
import { refineRouteCandidates } from "../lib/refine-route-candidates"
import { RouteCandidatePool } from "../lib/select-route-candidates"
import { VectorScene, routeCopper } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("conditional searches replace incompatible shortest-path alternatives", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    obstacles: [],
    connections: [
      {
        name: "horizontal",
        pointsToConnect: [
          { x: -1, y: 0, layer: "bottom" },
          { x: 1, y: 0, layer: "bottom" },
        ],
      },
      {
        name: "vertical",
        pointsToConnect: [
          { x: 0, y: -1, layer: "bottom" },
          { x: 0, y: 1, layer: "bottom" },
        ],
      },
    ],
  }
  const pool = new RouteCandidatePool(0.1)
  for (const connection of input.connections) {
    pool.add(connection.name, [
      {
        type: "pcb_trace",
        pcb_trace_id: connection.name,
        connection_name: connection.name,
        route: connection.pointsToConnect.map((p) => ({
          ...p,
          route_type: "wire",
          width: 0.1,
        })),
      },
    ])
  }
  const names = input.connections.map((c) => c.name)
  expect(pool.select(names)).toBeNull()
  const generator = refineRouteCandidates(
    input,
    [],
    new Map(names.map((n) => [n, 0.1])),
    pool,
    names,
    [],
    new Map(),
  )
  let step = generator.next()
  while (!step.done) step = generator.next()
  const routes = step.value as Trace[]
  expect(routes).toHaveLength(2)
  for (const connection of input.connections) {
    const route = routes.find((t) => t.connection_name === connection.name)!
    const scene = new VectorScene(
      input,
      connection,
      0.1,
      routes.flatMap(routeCopper),
    )
    expect(scene.pathVisible(route.route)).toBe(true)
    expect(route.route[0]).toMatchObject(connection.pointsToConnect[0])
    expect(route.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
  }
})

import { expect, test } from "bun:test"
import { RouteHypergraph } from "../lib/route-hypergraph"
import { HypergraphBusLanesSolver } from "../lib"
import type { Trace } from "../lib"
const trace = (name: string, points: number[][], layer = "top"): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  route: points.map(([x, y]) => ({
    route_type: "wire",
    x,
    y,
    width: 0.1,
    layer,
  })),
})

test("exact cover replaces a shorter crossing with compatible hyperedges", () => {
  const g = new RouteHypergraph(0.1)
  g.add("a", [
    trace("a", [
      [0, 0],
      [2, 0],
    ]),
  ])
  g.add("a", [
    trace("a", [
      [0, 0],
      [0, -2],
      [2, -2],
      [2, 0],
    ]),
  ])
  g.add("b", [
    trace("b", [
      [1, -1],
      [1, 1],
    ]),
  ])
  const result = g.select(["a", "b"])!
  expect(result).toHaveLength(2)
  expect(result.find((t) => t.connection_name === "a")!.route).toHaveLength(4)
  expect(g.select(["a", "b", "missing"])).toBeNull()
})
test("a differential pair is an atomic multi-demand hyperedge", () => {
  const g = new RouteHypergraph(0.1, [["p", "n"]])
  g.add("p", [
    trace("p", [
      [0, 0],
      [2, 0],
    ]),
  ])
  expect(g.select(["p", "n"])).toBeNull()
  g.add("n", [
    trace("n", [
      [0, 0.4],
      [2, 0.4],
    ]),
  ])
  expect(g.edges).toHaveLength(1)
  expect(g.edges[0].vertices).toEqual(["p", "n"])
  expect(g.select(["p", "n"])).toHaveLength(2)
  g.add("block", [
    trace("block", [
      [1, -1],
      [1, 1],
    ]),
  ])
  expect(g.select(["p", "n", "block"])).toBeNull()
})
test("separate layers can occupy the same XY corridor", () => {
  const g = new RouteHypergraph(0.1)
  g.add("a", [
    trace("a", [
      [0, 0],
      [2, 0],
    ]),
  ])
  g.add("b", [
    trace(
      "b",
      [
        [1, -1],
        [1, 1],
      ],
      "bottom",
    ),
  ])
  expect(g.select(["a", "b"])).toHaveLength(2)
})
test("the variant routes and validates a small fixed-layer input", () => {
  const solver = new HypergraphBusLanesSolver(
    {
      layerCount: 1,
      minTraceWidth: 0.1,
      bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
      obstacles: [],
      connections: [
        {
          name: "a",
          pointsToConnect: [
            { x: -2, y: 0, layer: "top" },
            { x: 2, y: 0, layer: "top" },
          ],
        },
      ],
    },
    { fanout: "none" },
  )
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toHaveLength(1)
})

test("fine refinement admits a continuously clear diagonal between blocked neighbors", async () => {
  const { GridVisibilitySearch } = await import("../lib/grid-visibility")
  const { VectorScene, fixedCopper } = await import("../lib/vector-scene")
  const input = {
    layerCount: 1,
    minTraceWidth: 0.02,
    minTraceToPadEdgeClearance: 0.02,
    bounds: { minX: 0, maxX: 0.14, minY: 0, maxY: 0.14 },
    connections: [
      {
        name: "a",
        pointsToConnect: [
          { x: 0.02, y: 0.02, layer: "top" },
          { x: 0.12, y: 0.12, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        shape: "circle" as const,
        center: { x: 0.02, y: 0.12 },
        width: 0.04,
        height: 0.04,
        layers: ["top"],
        connectedTo: [],
      },
      {
        shape: "circle" as const,
        center: { x: 0.12, y: 0.02 },
        width: 0.04,
        height: 0.04,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
  const c = input.connections[0],
    scene = new VectorScene(input, c, 0.02, fixedCopper(input))
  const grid = {
    step: 0.1,
    bounds: { minX: 0.02, maxX: 0.12, minY: 0.02, maxY: 0.12 },
    allowDiagonalPassages: true,
  }
  const search = new GridVisibilitySearch(
    scene,
    c.pointsToConnect[0],
    c.pointsToConnect[1],
    [],
    0,
    undefined,
    grid,
  )
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
  expect(scene.pathVisible(search.result)).toBe(true)
})

test("corridor expansion retains octilinear joins to diagonal approaches", async () => {
  const { spreadHypergraphCorridors } = await import(
    "../lib/spread-hypergraph-corridors"
  )
  const names = ["a", "b", "c"]
  const traces = names.map((name, i) =>
    trace(name, [
      [-10, i],
      [-6, i + 4],
      [10, i + 4],
    ]),
  )
  const input = {
    layerCount: 1,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -15, maxX: 15, minY: -10, maxY: 15 },
    connections: names.map((name, i) => ({
      name,
      pointsToConnect: [
        { x: -10, y: i, layer: "top" },
        { x: 10, y: i + 4, layer: "top" },
      ],
    })),
    buses: [{ busId: "bus", connectionNames: names, maxLengthSkew: 0.1 }],
    obstacles: names.flatMap((name, i) => [
      {
        componentId: "cpu",
        center: { x: -10, y: i },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: [name],
      },
      {
        componentId: "ram",
        center: { x: 10, y: i + 4 },
        width: 0.2,
        height: 0.2,
        layers: ["top"],
        connectedTo: [name],
      },
    ]),
  }
  const result = spreadHypergraphCorridors(input, traces, 0.7)
  expect(result).not.toBeNull()
  for (const t of result!)
    for (let i = 1; i < t.route.length; i++) {
      const dx = Math.abs(t.route[i].x - t.route[i - 1].x),
        dy = Math.abs(t.route[i].y - t.route[i - 1].y)
      expect(Math.min(dx, dy) < 1e-8 || Math.abs(dx - dy) < 1e-8).toBe(true)
    }
})

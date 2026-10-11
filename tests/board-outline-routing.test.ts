import { expect, test } from "bun:test"
import {
  BoardOutline,
  boardOutlineViolations,
  getBoardOutline,
} from "../lib/board-outline"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, fixedCopper } from "../lib/vector-scene"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

// The central slot opens through the top perimeter. Its two arms are connected
// only below y=4, despite both routing endpoints lying inside the same bounds.
const concave = (): Point[] => [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 6, y: 10 },
  { x: 6, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 10 },
  { x: 0, y: 10 },
]
const input = (): SimpleRouteJson => ({
  layerCount: 4,
  minTraceWidth: 0.2,
  minBoardEdgeClearance: 0.2,
  bounds: { minX: -1, maxX: 11, minY: -1, maxY: 11 },
  outline: concave(),
  obstacles: [],
  connections: [
    {
      name: "D",
      pointsToConnect: [
        { x: 2, y: 8, layer: "top" },
        { x: 8, y: 8, layer: "top" },
      ],
    },
  ],
})
const trace = (points: Point[], width = 0.2): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: "D",
  connection_name: "D",
  route: points.map((p) => ({ ...p, route_type: "wire", layer: "top", width })),
})

test("sparse visibility routing detours around a concave outline and preserves input", () => {
  const j = input()
  // An explicitly repeated closing vertex is retained in output, even though
  // the polygon implementation internally uses implicit closure.
  j.outline!.push({ ...j.outline![0] })
  j.traces = [
    trace([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]),
  ]
  j.traces[0].connection_name = "fixed"
  const before = JSON.stringify(j)
  const s = new BusLanesSolver(j)
  s.solve()
  expect(s.solved).toBe(true)
  expect(s.error).toBeNull()
  expect(s.traces[0].route.some((p) => p.y < 4)).toBe(true)
  expect(boardOutlineViolations(j, s.getOutput().traces)).toEqual([])
  expect(s.getOutput().outline).toEqual(j.outline)
  expect(s.getOutput().traces[0]).toEqual(j.traces[0])
  expect(JSON.stringify(j)).toBe(before)
})

test("continuous visibility rejects a cutout crossing even when both endpoints are inside", () => {
  const j = input(),
    c = j.connections[0]
  const scene = new VectorScene(j, c, j.minTraceWidth, fixedCopper(j))
  expect(scene.visible(c.pointsToConnect[0], c.pointsToConnect[0])).toBe(true)
  expect(scene.visible(c.pointsToConnect[1], c.pointsToConnect[1])).toBe(true)
  expect(scene.visible(c.pointsToConnect[0], c.pointsToConnect[1])).toBe(false)
  expect(boardOutlineViolations(j, [trace(c.pointsToConnect)])).not.toEqual([])
  const forced = BusLanesSolver.forValidation(j, [trace(c.pointsToConnect)])
  forced.solve()
  expect(forced.failed).toBe(true)
  expect(forced.error).toContain("board outline clearance")
  expect(() => forced.getOutput()).toThrow()
})

test("grid occupancy and search honor the real polygon rather than its larger rectangular bounds", () => {
  const j = input(),
    c = j.connections[0]
  const scene = new VectorScene(j, c, j.minTraceWidth, [])
  const search = new GridVisibilitySearch(
    scene,
    c.pointsToConnect[0],
    c.pointsToConnect[1],
  )
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
  expect(search.result.some((p) => p.y < 4)).toBe(true)
  expect(scene.pathVisible(search.result)).toBe(true)
  expect(boardOutlineViolations(j, [trace(search.result)])).toEqual([])
})

test("hard edges reject a thin cutout between unblocked grid vertices", () => {
  const j = input()
  j.outline![3].x = j.outline![4].x = 5.1
  j.outline![5].x = j.outline![6].x = 4.9
  j.connections[0].pointsToConnect = [
    { x: 4, y: 6, layer: "top" },
    { x: 6, y: 6, layer: "top" },
  ]
  const c = j.connections[0],
    scene = new VectorScene(j, c, 0.2, [])
  const search = new GridVisibilitySearch(
    scene,
    c.pointsToConnect[0],
    c.pointsToConnect[1],
    [],
    4,
    undefined,
    { step: 2, bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } },
  )
  const access = search.getRoutingAccess()
  const id = 2 + 3 * access.nx
  const right = access.neighbors.find((n) => n.dx === 1 && n.dy === 0)!
  expect(access.isBlocked(id)).toBe(false)
  expect(access.isBlocked(id + right.offset)).toBe(false)
  expect(access.hardEdgeIsClear(id, right)).toBe(false)
  expect(
    access.softEdgeIsClear(access.point(id), access.point(id + right.offset)),
  ).toBe(false)
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
  expect(scene.pathVisible(search.result)).toBe(true)
})

test("wire width and edge clearance are enforced at straight and concave boundaries", () => {
  const polygon = new BoardOutline(concave())
  expect(polygon.capsuleIsClear({ x: 2, y: 3.7 }, { x: 8, y: 3.7 }, 0.3)).toBe(
    true,
  )
  expect(
    polygon.capsuleIsClear({ x: 2, y: 3.7001 }, { x: 8, y: 3.7001 }, 0.3),
  ).toBe(false)
  expect(polygon.pointIsClear({ x: 4, y: 4 }, 0.3)).toBe(false)
  expect(polygon.capsuleIsClear({ x: 0.3, y: 1 }, { x: 0.3, y: 3 }, 0.3)).toBe(
    true,
  )
  expect(
    polygon.capsuleIsClear({ x: 0.2999, y: 1 }, { x: 0.2999, y: 3 }, 0.3),
  ).toBe(false)
  const j = input()
  expect(
    boardOutlineViolations(j, [
      trace(
        [
          { x: 2, y: 3.7 },
          { x: 8, y: 3.7 },
        ],
        0.4,
      ),
    ]),
  ).not.toEqual([])
  expect(polygon.capsuleIsClear({ x: 2, y: 8 }, { x: 8, y: 8 }, 0)).toBe(false)
})

test("via land radius, rather than drill radius or trace width, sets edge clearance", () => {
  const j = input()
  const via = (x: number): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: "fixed-via",
    route: [
      {
        route_type: "via",
        x,
        y: 2,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.8,
        via_hole_diameter: 0.2,
        layers: ["top", "inner1", "inner2", "bottom"],
      },
    ],
  })
  expect(boardOutlineViolations(j, [via(0.6)])).toEqual([])
  expect(boardOutlineViolations(j, [via(0.5999)])).toEqual([
    { pcbTraceId: "fixed-via", routeIndex: 0, kind: "via" },
  ])
  j.traces = [via(0.4)]
  const before = JSON.stringify(j)
  const s = new BusLanesSolver(j)
  s.solve()
  expect(s.failureCode).toBe("board_outline_clearance")
  expect(() => s.getOutput()).toThrow()
  expect(JSON.stringify(j)).toBe(before)
})

test("fixed wire/via connector chords cannot cross an outline cutout", () => {
  const j = input(),
    t = trace([{ x: 2, y: 8 }])
  t.route.push({
    route_type: "via",
    x: 8,
    y: 8,
    from_layer: "top",
    to_layer: "bottom",
    via_diameter: 0.4,
  })
  expect(boardOutlineViolations(j, [t])).toEqual([
    { pcbTraceId: "D", routeIndex: 0, kind: "wire" },
  ])
})

test("clockwise outlines and interior grid rectangles use the same continuous clearance", () => {
  const j = input()
  j.outline!.reverse()
  j.connections[0].pointsToConnect = [
    { x: 1, y: 1, layer: "top" },
    { x: 3, y: 1, layer: "top" },
  ]
  const c = j.connections[0]
  const scene = new VectorScene(j, c, 0.2, [])
  const search = new GridVisibilitySearch(
    scene,
    c.pointsToConnect[0],
    c.pointsToConnect[1],
    [],
    4,
    undefined,
    { step: 0.2, bounds: { minX: 0.5, maxX: 3.5, minY: 0.5, maxY: 3.5 } },
  )
  // A proved-clear grid rectangle is a safe fast path, but callers of the
  // shared edge interface may still ask about chords outside that rectangle.
  const access = search.getRoutingAccess()
  expect(access.softEdgeIsClear({ x: 2, y: 8 }, { x: 8, y: 8 })).toBe(false)
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
  expect(scene.pathVisible(search.result)).toBe(true)
})

test("malformed, self-intersecting and degenerate outlines fail explicitly", () => {
  const invalid: Point[][] = [
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ],
    [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    ],
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 10 },
    ],
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ],
    [
      { x: 0, y: 0 },
      { x: NaN, y: 0 },
      { x: 0, y: 10 },
    ],
    [
      { x: 0, y: 0 },
      { x: Infinity, y: 0 },
      { x: 0, y: 10 },
    ],
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 5, y: 0 },
      { x: 0, y: 10 },
    ],
  ]
  for (const outline of invalid) {
    const j = input()
    j.outline = outline
    const s = new BusLanesSolver(j)
    s.solve()
    expect(s.failureCode).toBe("invalid_outline")
    expect(s.solved).toBe(false)
    expect(() => s.getOutput()).toThrow()
  }
})

test("outline mutation invalidates cached polygon and grid geometry", () => {
  const j = input(),
    c = j.connections[0]
  expect(getBoardOutline(j)!.containsPoint({ x: 5, y: 8 })).toBe(false)
  const oldScene = new VectorScene(j, c, 0.2, [])
  const oldSearch = new GridVisibilitySearch(
    oldScene,
    c.pointsToConnect[0],
    c.pointsToConnect[1],
  )
  while (!oldSearch.solved && !oldSearch.failed) oldSearch.step()
  for (const index of [4, 5]) j.outline![index].y = 9
  expect(getBoardOutline(j)!.containsPoint({ x: 5, y: 8 })).toBe(true)
  // A retained scene still owns its original polygon snapshot. Searching it
  // after external mutation must not store old occupancy under the new shape.
  const retainedSceneSearch = new GridVisibilitySearch(
    oldScene,
    c.pointsToConnect[0],
    c.pointsToConnect[1],
  )
  while (!retainedSceneSearch.solved && !retainedSceneSearch.failed)
    retainedSceneSearch.step()
  expect(retainedSceneSearch.result.some((p) => p.y < 4)).toBe(true)
  const newScene = new VectorScene(j, c, 0.2, [])
  const newSearch = new GridVisibilitySearch(
    newScene,
    c.pointsToConnect[0],
    c.pointsToConnect[1],
  )
  while (!newSearch.solved && !newSearch.failed) newSearch.step()
  expect(newSearch.solved).toBe(true)
  expect(newSearch.result).toEqual(c.pointsToConnect)
  expect(newScene.pathVisible(newSearch.result)).toBe(true)
})

test("omitting or supplying an empty outline preserves ordinary rectangular routing", () => {
  const j = input()
  delete j.outline
  expect(
    boardOutlineViolations(j, [trace(j.connections[0].pointsToConnect)]),
  ).toEqual([])
  const s = new BusLanesSolver(j)
  s.solve()
  expect(s.solved).toBe(true)
  expect(s.traces[0].route).toEqual(
    trace(j.connections[0].pointsToConnect).route,
  )
  const empty = structuredClone(j)
  empty.outline = []
  const emptySolver = new BusLanesSolver(empty)
  emptySolver.solve()
  expect(getBoardOutline(empty)).toBeUndefined()
  expect(emptySolver.solved).toBe(true)
  expect(emptySolver.getOutput().outline).toEqual([])
  expect(emptySolver.traces).toEqual(s.traces)
})

import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { negotiateLanes } from "../lib/negotiate-lanes"
import { routeViaWaypoint } from "../lib/route-via-waypoint"
import { length } from "../lib/geometry"
import { VectorScene, type Copper } from "../lib/vector-scene"
import type { Connection, SimpleRouteJson } from "../lib/types"

function denseInput(): SimpleRouteJson {
  return {
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    minTraceWidth: 0.1,
    layerCount: 1,
    obstacles: [],
    connections: Array.from({ length: 13 }, (_, i) => ({
      name: `D${i}`,
      pointsToConnect: [
        { x: -4, y: -2.4 + i * 0.4, layer: "top" },
        { x: 4, y: -2.4 + i * 0.4, layer: "top" },
      ],
    })),
  }
}

function negotiation(input: SimpleRouteJson) {
  return negotiateLanes(
    input,
    input.connections,
    [],
    [],
    new Map(input.connections.map((c) => [c.name, input.minTraceWidth])),
  )
}

function expectReleased(search: GridVisibilitySearch) {
  const canceled = search as any
  expect(search.failed).toBe(true)
  const next = new GridVisibilitySearch(
    search.scene,
    search.scene.connection.pointsToConnect[0],
    search.scene.connection.pointsToConnect[1],
  ) as any
  expect(next.heap).toBe(canceled.heap)
  expect(next.softEdgeKnown).toBe(canceled.softEdgeKnown)
  // An obsolete cancellation must not clear the scratch buffers' new owner.
  const pending = next.heap.length
  expect(pending).toBeGreaterThan(0)
  search.cancel()
  expect(next.heap.length).toBe(pending)
  next.cancel()
}

test("returning lane negotiation releases its active grid search", () => {
  let active: GridVisibilitySearch | undefined
  const originalStep = GridVisibilitySearch.prototype.step
  GridVisibilitySearch.prototype.step = function () {
    active = this
  }
  try {
    const generator = negotiation(denseInput())
    expect(generator.next().done).toBe(false)
    expect(active).toBeDefined()
    expect(active!.failed).toBe(false)
    expect(generator.return(null).done).toBe(true)
    expectReleased(active!)
  } finally {
    GridVisibilitySearch.prototype.step = originalStep
  }
})

test("returning lane negotiation also closes a nested coupled-pair search", () => {
  const input = denseInput()
  for (const [i, y] of [-0.11, 0.11].entries()) {
    input.connections[i].pointsToConnect[0].y = y
    input.connections[i].pointsToConnect[1].y = y
  }
  input.differentialPairs = [
    {
      connectionNames: ["D0", "D1"],
      lengthTolerance: 0.127,
      traceGap: 0.12,
      maxUncoupledLength: 0.01,
    },
  ]
  let active: GridVisibilitySearch | undefined
  const originalStep = GridVisibilitySearch.prototype.step
  const originalVisible = VectorScene.prototype.pathVisible
  // Force a corridor search, while retaining short endpoint attachments.
  VectorScene.prototype.pathVisible = function (path) {
    return length(path) <= 1 && originalVisible.call(this, path)
  }
  GridVisibilitySearch.prototype.step = function () {
    active = this
  }
  try {
    const generator = negotiation(input)
    expect(generator.next().done).toBe(false)
    expect(active).toBeDefined()
    expect(active!.scene.connection.name).toBe("pair_corridor")
    expect(active!.failed).toBe(false)
    expect(generator.return(null).done).toBe(true)
    expectReleased(active!)
  } finally {
    GridVisibilitySearch.prototype.step = originalStep
    VectorScene.prototype.pathVisible = originalVisible
  }
})

test("solver budget failure closes negotiation and releases the unused initial lane search", () => {
  let active: GridVisibilitySearch | undefined
  const originalStep = GridVisibilitySearch.prototype.step
  GridVisibilitySearch.prototype.step = function () {
    active = this
  }
  try {
    const solver = new BusLanesSolver(denseInput(), { denseSearch: true })
    solver.step()
    const initial = (solver as any).search as GridVisibilitySearch
    expect(initial.failed).toBe(false)
    solver.step()
    expect(active).toBeDefined()
    expect(initial.failed).toBe(true)
    expect((active as any).heap).toBe((initial as any).heap)
    expect(active!.failed).toBe(false)
    solver.tryFinalAcceptance()
    expect(solver.failureCode).toBe("search_budget_exhausted")
    expect(solver.failed).toBe(true)
    expectReleased(active!)
    solver.tryFinalAcceptance()
    expect(solver.failureCode).toBe("search_budget_exhausted")
  } finally {
    GridVisibilitySearch.prototype.step = originalStep
  }
})

test("returning a waypoint generator releases its active grid search", () => {
  const connection: Connection = {
    name: "waypoint",
    pointsToConnect: [
      { x: -4, y: -4, layer: "top" },
      { x: 4, y: 4, layer: "top" },
    ],
  }
  const input: SimpleRouteJson = {
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    minTraceWidth: 0.1,
    layerCount: 1,
    obstacles: [],
    connections: [connection],
  }
  const scene = new VectorScene(input, connection, input.minTraceWidth, [])
  const soft: Copper[] = [
    {
      a: { x: -5, y: 0 },
      b: { x: 5, y: 0 },
      radius: 1,
      layer: "top",
      owners: [],
    },
  ]
  let active: GridVisibilitySearch | undefined
  const originalStep = GridVisibilitySearch.prototype.step
  GridVisibilitySearch.prototype.step = function () {
    active = this
    originalStep.call(this)
  }
  try {
    const generator = routeViaWaypoint(
      scene,
      { x: 4, y: 2 },
      soft,
      100,
      undefined,
      30,
    )
    expect(generator.next().done).toBe(false)
    expect(active).toBeDefined()
    const search = active as any
    expect(search.solved).toBe(false)
    expect(search.failed).toBe(false)
    expect(search.softMemoLease.active).toBe(true)
    expect(generator.return(null).done).toBe(true)
    expect(search.failed).toBe(true)
    expect(search.softMemoLease.active).toBe(false)
    const next = new GridVisibilitySearch(
      scene,
      connection.pointsToConnect[0],
      connection.pointsToConnect[1],
      soft,
    ) as any
    expect(next.softEdgeKnown).toBe(search.softEdgeKnown)
    next.cancel()
  } finally {
    GridVisibilitySearch.prototype.step = originalStep
  }
})

import { expect, test } from "bun:test"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { length } from "../lib/geometry"
import { MinHeap } from "../lib/min-heap"
import { routeSurfaceBridge } from "../lib/route-surface-bridge"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import type { SimpleRouteJson } from "../lib/types"

test("an optional heap tie-break preserves priority and stable residual ties", () => {
  const stable = new MinHeap<{ f: number; g: number; name: string }>(),
    directed = new MinHeap<{ f: number; g: number; name: string }>(
      (a, b) => b.g - a.g,
    )
  const entries = [
    { f: 5, g: 1, name: "first" },
    { f: 5, g: 4, name: "farther" },
    { f: 3, g: 0, name: "lower" },
    { f: 5, g: 4, name: "same" },
  ]
  for (const entry of entries) {
    stable.push(entry)
    directed.push(entry)
  }
  expect(Array.from({ length: 4 }, () => stable.pop().name)).toEqual([
    "lower",
    "first",
    "farther",
    "same",
  ])
  expect(Array.from({ length: 4 }, () => directed.pop().name)).toEqual([
    "lower",
    "farther",
    "same",
    "first",
  ])
})

test("octile and length bounds retain a shortest route with fractional endpoints", () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    bounds: { minX: -10, maxX: 10, minY: -8, maxY: 8 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -8.03, y: -4.97, layer: "top" },
          { x: 8.01, y: 5.03, layer: "top" },
        ],
      },
    ],
  }
  const dx = 16.04,
    dy = 10,
    shortest = Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
  for (const heuristicWeight of [1, 4]) {
    const search = routeSurfaceBridge(input, input.connections[0], {
      gridStep: 0.05,
      maxExpansions: 20000,
      maxLength: shortest + 1e-8,
      heuristicWeight,
    })
    let step = search.next(),
      yields = 0
    while (!step.done && yields++ < 1000) step = search.next()
    expect(step.done).toBe(true)
    if (!step.done || !step.value)
      throw Error("Expected the bounded shortest route")
    const result = step.value,
      joined = joinSignalEscapes(result.carrier, result.escapes)
    expect(length(joined.route)).toBeCloseTo(shortest, 7)
    expect(
      joined.route.every(
        (point) => point.route_type === "wire" && point.layer === "top",
      ),
    ).toBe(true)
    const validator = BusLanesSolver.forValidation(input, [joined])
    validator.solve()
    expect(validator.solved).toBe(true)
  }
  for (const heuristicWeight of [0, -1, NaN, Infinity])
    expect(
      routeSurfaceBridge(input, input.connections[0], {
        heuristicWeight,
      }).next(),
    ).toEqual({
      done: true,
      value: null,
    })
})

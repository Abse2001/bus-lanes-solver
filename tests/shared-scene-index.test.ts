import { expect, test } from "bun:test"
import { CopperIndex } from "../lib/copper-index"
import { VectorScene, type Copper } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

test("a shared immutable scene index retains exact layer, source alias, and net-owner exclusions", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    minBoardEdgeClearance: 0.02,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    obstacles: [],
    connections: [
      {
        name: "a",
        source_trace_id: "a-source",
        pointsToConnect: [
          { x: -8, y: 0, layer: "top", pcb_port_id: "a-port" },
          { x: 8, y: 0, layer: "top" },
        ],
      },
      {
        name: "b",
        pointsToConnect: [
          { x: -8, y: 0, layer: "bottom" },
          { x: 8, y: 0, layer: "bottom" },
        ],
      },
    ],
  }
  let seed = 123
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  const copper: Copper[] = Array.from({ length: 160 }, (_, i) => {
      const x = random() * 16 - 8,
        y = random() * 16 - 8
      return {
        a: { x, y },
        b: { x: x + random(), y: y + random() },
        radius: 0.02 + random() * 0.2,
        layer: i % 2 ? "top" : "bottom",
        owners: [["a"], ["a-source"], ["a-port"], ["b"], ["other"]][i % 5],
        ...(i % 7 === 0
          ? { rect: { minX: x, maxX: x + 0.4, minY: y, maxY: y + 0.6 } }
          : {}),
      }
    }),
    before = structuredClone(copper),
    index = new CopperIndex(copper)
  for (const connection of input.connections) {
    const ordinary = new VectorScene(input, connection, 0.1, copper),
      shared = new VectorScene(input, connection, 0.1, copper, index)
    expect(shared.copper).toEqual(ordinary.copper)
    for (let i = 0; i < 1000; i++) {
      const a = { x: random() * 22 - 11, y: random() * 22 - 11 },
        b = { x: random() * 22 - 11, y: random() * 22 - 11 }
      expect(shared.visible(a, b)).toBe(ordinary.visible(a, b))
    }
  }
  expect(copper).toEqual(before)
})

test("scene index reuse is request local, with fresh geometry for a later copper batch", () => {
  const input: SimpleRouteJson = {
      layerCount: 2,
      minTraceWidth: 0.1,
      bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
      obstacles: [],
      connections: [
        {
          name: "signal",
          pointsToConnect: [
            { x: -1, y: 0, layer: "top" },
            { x: 1, y: 0, layer: "top" },
          ],
        },
      ],
    },
    before: Copper[] = [
      {
        a: { x: 0, y: 2 },
        b: { x: 0, y: 3 },
        radius: 0.1,
        layer: "top",
        owners: [],
      },
    ],
    after = [{ ...before[0], a: { x: 0, y: -1 }, b: { x: 0, y: 1 } }],
    first = new VectorScene(
      input,
      input.connections[0],
      0.1,
      before,
      new CopperIndex(before),
    ),
    next = new VectorScene(
      input,
      input.connections[0],
      0.1,
      after,
      new CopperIndex(after),
    ),
    path = [
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ]
  expect(first.pathVisible(path)).toBe(true)
  expect(next.pathVisible(path)).toBe(false)
  expect(first.pathVisible(path)).toBe(true)
})

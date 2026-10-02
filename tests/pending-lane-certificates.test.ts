import { expect, test } from "bun:test"
import { pendingLaneCertificates } from "../lib/pending-lane-certificates"
import { VectorScene } from "../lib/vector-scene"
import type { Copper } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"
import { length } from "../lib/geometry"

function fixture() {
  const input: SimpleRouteJson = {
    bounds: { minX: -5, maxX: 5, minY: -4, maxY: 4 },
    layerCount: 4,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    obstacles: [-3, 3].map((x, index) => ({
      type: "rect",
      componentId: `component_${index}`,
      center: { x, y: 0 },
      width: 2,
      height: 2,
      layers: ["top"],
      connectedTo: [],
    })),
    connections: [
      {
        name: "lane",
        pointsToConnect: [
          { x: -3, y: -0.5, layer: "inner1" },
          { x: 3, y: 0.5, layer: "inner1" },
        ],
      },
    ],
  }
  const fixed: Copper[] = [
    {
      a: { x: 0, y: 0 },
      b: { x: 0, y: 0 },
      radius: 0.8,
      layer: "inner1",
      owners: ["power"],
    },
  ]
  const widths = new Map([["lane", 0.1]])
  return { input, fixed, widths }
}

function collect(
  input: SimpleRouteJson,
  fixed: Copper[],
  widths: Map<string, number>,
) {
  const generator = pendingLaneCertificates(
    input,
    input.connections,
    fixed,
    widths,
  )
  let step = generator.next(),
    yields = 0
  while (!step.done) {
    yields++
    step = generator.next()
  }
  return { traces: step.value, yields }
}

test("pending certificates cache only the current hard geometry and terminal layer", () => {
  const { input, fixed, widths } = fixture()
  const before = structuredClone({ input, fixed })
  const first = collect(input, fixed, widths)
  expect(first.yields).toBeGreaterThan(0)
  expect(first.traces).toHaveLength(1)
  const scene = new VectorScene(input, input.connections[0], 0.1, fixed)
  expect(scene.pathVisible(first.traces[0].route)).toBe(true)
  expect(first.traces[0].route[0]).toMatchObject(
    input.connections[0].pointsToConnect[0],
  )
  expect(first.traces[0].route.at(-1)).toMatchObject(
    input.connections[0].pointsToConnect[1],
  )
  const cached = collect(input, structuredClone(fixed), widths)
  expect(cached.yields).toBe(0)
  expect(cached.traces).not.toBe(first.traces)
  expect(cached.traces).toEqual(first.traces)
  cached.traces[0].route[0].x = 100
  expect(collect(input, fixed, widths).traces).toEqual(first.traces)

  const moved = structuredClone(fixed)
  moved[0].a.y = moved[0].b.y = 3
  const changed = collect(input, moved, widths)
  expect(changed.yields).toBeGreaterThan(0)
  expect(changed.traces).not.toBe(first.traces)
  expect(length(changed.traces[0].route)).toBeLessThan(
    length(first.traces[0].route),
  )
  expect({ input, fixed }).toEqual(before)

  input.connections[0].source_trace_id = "power"
  const owned = collect(input, fixed, widths)
  expect(owned.yields).toBeGreaterThan(0)
  expect(length(owned.traces[0].route)).toBeLessThan(
    length(first.traces[0].route),
  )
  delete input.connections[0].source_trace_id

  for (const point of input.connections[0].pointsToConnect)
    point.layer = "bottom"
  const otherLayer = collect(input, fixed, widths)
  expect(otherLayer.yields).toBeGreaterThan(0)
  expect(otherLayer.traces).not.toBe(first.traces)
  expect(
    otherLayer.traces[0].route.every(
      (p) => p.route_type === "wire" && p.layer === "bottom",
    ),
  ).toBe(true)
})

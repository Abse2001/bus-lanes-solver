import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { fixedCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

function viaCorridor(closed = false) {
  const offset = closed ? 0.22 : 0.25
  const power: Trace[] = [
    {
      name: "VCC",
      points: [
        [offset, -0.2],
        [0.45, -0.65 + offset],
        [0.45, -0.45],
      ],
    },
    {
      name: "GND",
      points: [
        [-0.2, offset],
        [-0.65 + offset, 0.45],
        [-0.45, 0.45],
      ],
    },
  ].map(({ name, points }) => ({
    type: "pcb_trace",
    pcb_trace_id: `fixed_${name}`,
    connection_name: name,
    route: [
      {
        route_type: "wire",
        x: points[0][0],
        y: points[0][1],
        layer: "top",
        width: 0.1,
      },
      {
        route_type: "via",
        x: points[0][0],
        y: points[0][1],
        from_layer: "top",
        to_layer: "bottom",
        layers: ["top", "bottom"],
        via_diameter: 0.3,
        via_hole_diameter: 0.15,
      },
      ...points.map(([x, y]) => ({
        route_type: "wire" as const,
        x,
        y,
        layer: "bottom",
        width: 0.1,
      })),
    ],
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minBoardEdgeClearance: 0,
    bounds: { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5 },
    obstacles: [],
    traces: power,
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -0.2, y: -0.2, layer: "bottom" },
          { x: 0.25, y: 0.25, layer: "bottom" },
        ],
      },
      { name: "VCC", pointsToConnect: [] },
      { name: "GND", pointsToConnect: [] },
    ],
  }
  const connection = input.connections[0]
  const scene = new VectorScene(input, connection, 0.1, fixedCopper(input))
  return { input, scene, connection }
}

test("a continuously clear diagonal between circular vias does not require both orthogonal neighbor cells to be clear", () => {
  const { input, scene, connection } = viaCorridor()
  const a = { x: 0, y: 0 },
    b = { x: 0.05, y: 0.05 }
  expect(scene.visible(a, a)).toBe(true)
  expect(scene.visible(b, b)).toBe(true)
  expect(scene.visible({ x: 0.05, y: 0 }, { x: 0.05, y: 0 })).toBe(false)
  expect(scene.visible({ x: 0, y: 0.05 }, { x: 0, y: 0.05 })).toBe(false)
  expect(scene.visible(a, b)).toBe(true)
  // Establish an independently DRC-valid complete witness before searching.
  const witness: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "witness_D",
    connection_name: "D",
    route: connection.pointsToConnect.map((point) => ({
      ...point,
      route_type: "wire",
      width: 0.1,
    })),
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [...input.traces!, witness] },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).issues,
  ).toEqual([])
  const search = new GridVisibilitySearch(
    scene,
    connection.pointsToConnect[0],
    connection.pointsToConnect[1],
    [],
    0,
    undefined,
    { step: 0.05 },
  )
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
  expect(scene.pathVisible(search.result)).toBe(true)
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "D",
    connection_name: "D",
    route: search.result.map((point) => ({
      ...point,
      route_type: "wire",
      layer: "bottom",
      width: 0.1,
    })),
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [...input.traces!, trace] },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).issues,
  ).toEqual([])
  search.cancel()
})

test("a diagonal still fails when the continuous via-clearance envelopes close the corridor", () => {
  const { scene, connection } = viaCorridor(true)
  expect(
    scene.visible(connection.pointsToConnect[0], connection.pointsToConnect[0]),
  ).toBe(true)
  expect(
    scene.visible(connection.pointsToConnect[1], connection.pointsToConnect[1]),
  ).toBe(true)
  expect(scene.visible({ x: 0, y: 0 }, { x: 0.05, y: 0.05 })).toBe(false)
  const search = new GridVisibilitySearch(
    scene,
    connection.pointsToConnect[0],
    connection.pointsToConnect[1],
    [],
    0,
    undefined,
    { step: 0.05 },
  )
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(false)
  expect(search.failed).toBe(true)
  search.cancel()
})

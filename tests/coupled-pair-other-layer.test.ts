import { expect, test } from "bun:test"
import { routeCoupledPair } from "../lib/coupled-pair-routing"
import { length } from "../lib/geometry"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("a pair may pass over terminals on another copper layer", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -3, maxY: 3 },
    obstacles: [],
    connections: [
      ...[-0.11, 0.11].map((y, i) => ({
        name: i ? "N" : "P",
        pointsToConnect: [-4, 4].map((x) => ({ x, y, layer: "top" })),
      })),
      {
        name: "OTHER_LAYER",
        pointsToConnect: [
          { x: -1, y: 0, layer: "bottom" },
          { x: 1, y: 0, layer: "bottom" },
        ],
      },
    ],
    differentialPairs: [
      {
        connectionNames: ["P", "N"],
        lengthTolerance: 0.127,
        traceGap: 0.12,
      },
    ],
  }
  const fixed = fixedCopper(input)
  const generator = routeCoupledPair(
    input,
    input.differentialPairs![0],
    fixed,
    {
      copper: [],
      penalty: 0,
    },
  )
  let step = generator.next()
  for (let i = 0; !step.done && i < 8000; i++) step = generator.next()
  expect(step.done).toBe(true)
  expect(step.value).not.toBeNull()
  const traces = step.value as Trace[]
  for (const [i, trace] of traces.entries()) {
    expect(length(trace.route)).toBeCloseTo(8, 8)
    expect(trace.route[0]).toMatchObject(
      input.connections[i].pointsToConnect[0],
    )
    expect(trace.route.at(-1)).toMatchObject(
      input.connections[i].pointsToConnect[1],
    )
    expect(
      new VectorScene(input, input.connections[i], 0.1, [
        ...fixed,
        ...traces.flatMap(routeCopper),
      ]).pathVisible(trace.route),
    ).toBe(true)
  }
})

test("a completed plane via may sit inside separated pair approaches", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -3, maxY: 3 },
    obstacles: [],
    connections: [-1, 1].map((y, i) => ({
      name: i ? "N" : "P",
      pointsToConnect: [-4, 4].map((x) => ({ x, y, layer: "top" })),
    })),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "completed_power",
        connection_name: "POWER",
        route: [
          { route_type: "wire", x: -3.9, y: 0, layer: "top", width: 0.1 },
          {
            route_type: "via",
            x: -3.9,
            y: 0,
            from_layer: "top",
            to_layer: "bottom",
            via_diameter: 0.1,
            via_hole_diameter: 0.05,
          },
          { route_type: "wire", x: -3.9, y: 0, layer: "bottom", width: 0.1 },
        ],
      },
    ],
    differentialPairs: [
      {
        connectionNames: ["P", "N"],
        lengthTolerance: 0.127,
        traceGap: 0.12,
      },
    ],
  }
  const original = structuredClone(input)
  const fixed = fixedCopper(input)
  const generator = routeCoupledPair(
    input,
    input.differentialPairs![0],
    fixed,
    {
      copper: [],
      penalty: 0,
    },
  )
  let step = generator.next()
  for (let i = 0; !step.done && i < 8000; i++) step = generator.next()
  expect(step.done).toBe(true)
  expect(step.value).not.toBeNull()
  expect(input).toEqual(original)
  const traces = step.value as Trace[]
  expect(traces.every((trace) => length(trace.route) < 10)).toBe(true)
  expect(traces.every((trace) => trace.coupledSection)).toBe(true)
  for (const [i, trace] of traces.entries())
    expect(
      new VectorScene(input, input.connections[i], 0.1, [
        ...fixed,
        ...traces.flatMap(routeCopper),
      ]).pathVisible(trace.route),
    ).toBe(true)
})

test("a same-layer lane can leave through the opening between pair terminals", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -3, maxY: 3 },
    obstacles: [-0.4, 0.4].map((y, i) => ({
      type: "rect" as const,
      shape: "circle" as const,
      center: { x: -4, y },
      width: 0.3,
      height: 0.3,
      layers: ["top"],
      connectedTo: [i ? "N" : "P"],
    })),
    connections: [-1, 1].map((sign, i) => ({
      name: i ? "N" : "P",
      pointsToConnect: [
        { x: -4, y: sign * 0.4, layer: "top" },
        { x: 4, y: sign * 0.11, layer: "top" },
      ],
    })),
    differentialPairs: [
      {
        connectionNames: ["P", "N"],
        traceGap: 0.12,
        lengthTolerance: 0.127,
      },
    ],
  }
  const other = {
    name: "BETWEEN_TERMINALS",
    pointsToConnect: [
      { x: -3.9, y: 0, layer: "top" },
      { x: -5, y: 0, layer: "top" },
    ],
  }
  input.connections.push(other)
  const fixed = fixedCopper(input)
  const generator = routeCoupledPair(
    input,
    input.differentialPairs![0],
    fixed,
    {
      copper: [],
      penalty: 0,
    },
  )
  let step = generator.next()
  for (let i = 0; !step.done && i < 8000; i++) step = generator.next()
  expect(step.done).toBe(true)
  expect(step.value).not.toBeNull()
  const traces = step.value as Trace[]
  expect(traces.every((trace) => length(trace.route) < 8.25)).toBe(true)
  const scene = new VectorScene(input, other, 0.1, [
    ...fixed,
    ...traces.flatMap(routeCopper),
  ])
  expect(scene.pathVisible(other.pointsToConnect)).toBe(true)
})

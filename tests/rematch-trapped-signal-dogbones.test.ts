import { expect, spyOn, test } from "bun:test"
import {
  routeLocalSignalDogbones,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { BusLanesPipelineSolver } from "../lib/bus-lanes-pipeline-solver"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { rematchTrappedSignalDogbones } from "../lib/rematch-trapped-signal-dogbones"
import type { SimpleRouteJson, Trace } from "../lib/types"
import { fixedCopper, VectorScene } from "../lib/vector-scene"

function fixture() {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.08,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.11,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.11,
    bounds: { minX: -5, maxX: 5, minY: -3, maxY: 3 },
    connections: [
      {
        name: "DATA",
        nominalTraceWidth: 0.12,
        pointsToConnect: [
          { x: -2.4, y: 0, layer: "top" },
          { x: 2.4, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [],
  }
  for (const [componentId, x] of [
    ["U1", -2.4],
    ["U2", 2.4],
  ] as const)
    for (let i = 0; i < 4; i++)
      input.obstacles.push({
        componentId,
        shape: "circle",
        center: { x: x + (i % 2) * 0.8, y: Math.floor(i / 2) * 0.8 },
        width: 0.4,
        height: 0.4,
        layers: ["top"],
        connectedTo: i === 0 ? ["DATA"] : [],
      })
  const power: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "fixed_power",
    connection_name: "POWER",
    route: [
      { route_type: "wire", x: -1.6, y: 0.8, layer: "top", width: 0.12 },
      { route_type: "wire", x: -1.2, y: 1.2, layer: "top", width: 0.12 },
      {
        route_type: "via",
        x: -1.2,
        y: 1.2,
        from_layer: "top",
        to_layer: "bottom",
        layers: ["top", "inner1", "inner2", "bottom"],
        via_diameter: 0.3,
        via_hole_diameter: 0.15,
      },
      { route_type: "wire", x: -1.2, y: 1.2, layer: "bottom", width: 0.12 },
    ],
  }
  input.obstacles.find(
    (o) => Math.abs(o.center.x + 1.6) < 1e-8 && o.center.y === 0.8,
  )!.connectedTo = ["POWER"]
  input.traces = [power]
  const prepared = routeLocalSignalDogbones(
    input as Parameters<typeof routeLocalSignalDogbones>[0],
    {
      targetLayers: new Map([["DATA", "bottom"]]),
      viaDiameter: 0.3,
      viaHoleDiameter: 0.15,
      traceWidth: 0.12,
      clearance: 0.11,
    },
  )
  // Completing other copper can surround a fresh site without touching its
  // barrel. An alternate local interstice lies outside this continuous loop.
  const completed: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "completed_copper",
      connection_name: "SHIELD",
      route: [
        [2.4, -0.8],
        [3.2, -0.8],
        [3.2, 0],
        [2.4, 0],
        [2.4, -0.8],
      ].map(([x, y]) => ({
        route_type: "wire",
        x,
        y,
        width: 0.12,
        layer: "bottom",
      })),
    },
  ]
  const escapes = prepared.traces as Trace[]
  const pending: SimpleRouteJson = {
    ...input,
    connections: prepared.connections as SimpleRouteJson["connections"],
    traces: [...input.traces, ...escapes, ...completed],
  }
  return { input, pending, completed, escapes }
}

function finish<T>(generator: Generator<void, T>) {
  let result = generator.next()
  let steps = 0
  while (!result.done && steps++ < 10000) result = generator.next()
  expect(result.done).toBe(true)
  if (!result.done) throw Error("Unbounded local-site retry")
  return result.value
}

test("only the trapped fresh endpoint is rematched, with native widths and immutable copper", () => {
  const { input, pending, completed, escapes } = fixture()
  const before = structuredClone({ input, pending, completed, escapes })
  const result = finish(
    rematchTrappedSignalDogbones(
      input,
      pending,
      completed,
      escapes,
      new Map([["DATA", ["bottom"]]]),
    ),
  )
  expect(result.connections[0].pointsToConnect[0]).toEqual(
    pending.connections[0].pointsToConnect[0],
  )
  expect(result.connections[0].pointsToConnect[1]).not.toEqual(
    pending.connections[0].pointsToConnect[1],
  )
  expect(result.escapes).toHaveLength(2)
  expect(
    result.escapes.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    ),
  ).toHaveLength(2)
  expect(
    result.escapes
      .flatMap((trace) => trace.route)
      .filter((point) => point.route_type === "wire")
      .every((point) => point.width === 0.12),
  ).toBe(true)
  expect({ input, pending, completed, escapes }).toEqual(before)
  const sceneInput = {
    ...input,
    connections: result.connections,
    traces: [...input.traces!, ...completed, ...result.escapes],
  }
  const connection = result.connections[0]
  const search = new GridVisibilitySearch(
    new VectorScene(sceneInput, connection, 0.12, fixedCopper(sceneInput)),
    ...(connection.pointsToConnect as [
      (typeof connection.pointsToConnect)[0],
      (typeof connection.pointsToConnect)[0],
    ]),
    [],
    0,
  )
  while (!search.solved && !search.failed) search.step()
  expect(search.solved).toBe(true)
  const carrier: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "carrier",
    connection_name: "DATA",
    route: search.result.map((point) => ({
      ...point,
      route_type: "wire",
      width: 0.12,
      layer: "bottom",
    })),
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: {
      ...input,
      connections: [
        ...input.connections,
        { name: "POWER", pointsToConnect: [{ x: -1.6, y: 0.8, layer: "top" }] },
        {
          name: "SHIELD",
          pointsToConnect: [{ x: 2.4, y: -0.8, layer: "bottom" }],
        },
      ],
    },
    routedSrj: {
      ...sceneInput,
      connections: input.connections,
      traces: [...sceneInput.traces, carrier],
    },
    clearance: 0.11,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.issues).toEqual([])
  expect(drc.valid).toBe(true)
  expect(sceneInput.obstacles).toEqual(input.obstacles)
})

test("supplied connected pad copper is never redogboned", () => {
  const { input, pending, completed, escapes } = fixture()
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "supplied_DATA_prefix",
    connection_name: "DATA",
    route: [
      { route_type: "wire", x: 2.4, y: 0, layer: "top", width: 0.12 },
      { route_type: "wire", x: 2.4, y: -0.2, layer: "top", width: 0.12 },
    ],
  })
  const generator = rematchTrappedSignalDogbones(
    input,
    pending,
    completed,
    escapes,
    new Map([["DATA", ["bottom"]]]),
  )
  const result = generator.next()
  expect(result.done).toBe(true)
  expect(result.value).toEqual({ connections: pending.connections, escapes })
})

test("interrupting a local-site search releases its grid lease", () => {
  const { input, pending, completed, escapes } = fixture()
  const cancel = spyOn(GridVisibilitySearch.prototype, "cancel")
  try {
    const generator = rematchTrappedSignalDogbones(
      input,
      pending,
      completed,
      escapes,
      new Map([["DATA", ["bottom"]]]),
    )
    expect(generator.next().done).toBe(false)
    generator.return({ connections: [], escapes: [] })
    expect(cancel).toHaveBeenCalledTimes(1)
  } finally {
    cancel.mockRestore()
  }
})

test("pipeline budget exhaustion closes the site retry without exposing partial copper", () => {
  const { input } = fixture()
  const pipeline = new BusLanesPipelineSolver(input)
  let closed = false
  const retry = function* () {
    try {
      while (true) yield
    } finally {
      closed = true
    }
    return { connections: [], escapes: [] }
  }
  Object.assign(pipeline, { siteRematch: retry(), MAX_ITERATIONS: 2 })
  pipeline.solve()
  expect(closed).toBe(true)
  expect(pipeline.failed).toBe(true)
  expect(pipeline.failureCode).toBe("search_budget_exhausted")
  expect(pipeline.traces).toEqual([])
  expect(() => pipeline.getOutput()).toThrow()
})

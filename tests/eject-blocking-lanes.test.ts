import { expect, test } from "bun:test"
import { ejectBlockingLanes } from "../lib/eject-blocking-lanes"
import { routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

function fixture() {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -2, maxX: 2, minY: -1.85, maxY: 1.85 },
    obstacles: [],
    connections: [
      {
        name: "horizontal",
        pointsToConnect: [
          { x: -1.9, y: 0, layer: "top" },
          { x: 1.9, y: 0, layer: "top" },
        ],
      },
      {
        name: "vertical",
        pointsToConnect: [
          { x: 0, y: -1.8, layer: "top" },
          { x: 0, y: 1.8, layer: "top" },
        ],
      },
    ],
  }
  const initial: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "vertical",
      connection_name: "vertical",
      route: input.connections[1].pointsToConnect.map((p) => ({
        ...p,
        route_type: "wire",
        width: 0.1,
      })),
    },
  ]
  const widths = new Map(input.connections.map((c) => [c.name, 0.1])),
    layers = new Map([["vertical", ["top", "bottom"]]])
  return { input, initial, widths, layers }
}
function drain<T>(g: Generator<void, T>) {
  let r = g.next(),
    steps = 0
  while (!r.done && steps++ < 10000) r = g.next()
  expect(r.done).toBe(true)
  return r.value as T
}

test("a bounded displacement moves an eligible lane to free the missing connection", () => {
  const { input, initial, widths, layers } = fixture(),
    before = structuredClone({ input, initial })
  const result = drain(
    ejectBlockingLanes(input, initial, [], widths, layers, {
      requireSelfClear: true,
    }),
  )!
  expect(result).toHaveLength(2)
  expect(
    result.find((t) => t.connection_name === "vertical")!.route[0],
  ).toMatchObject({ layer: "bottom" })
  for (const trace of result) {
    const connection = input.connections.find(
      (c) => c.name === trace.connection_name,
    )!
    const layer = (trace.route[0] as { layer: string }).layer
    expect(
      new VectorScene(
        input,
        {
          ...connection,
          pointsToConnect: connection.pointsToConnect.map((p) => ({
            ...p,
            layer,
          })),
        },
        0.1,
        result.flatMap(routeCopper),
      ).pathVisible(trace.route),
    ).toBe(true)
  }
  expect({ input, initial }).toEqual(before)
})

test("fixed copper and coupled rails cannot be displaced", () => {
  const { input, initial, widths, layers } = fixture()
  expect(
    drain(
      ejectBlockingLanes(
        input,
        initial,
        routeCopper(initial[0]),
        widths,
        layers,
      ),
    ),
  ).toBeNull()
  initial[0].coupledSection = [0, 1]
  expect(
    drain(ejectBlockingLanes(input, initial, [], widths, layers)),
  ).toBeNull()
})

test("exhausted search budgets return no partial solution", () => {
  const { input, initial, widths, layers } = fixture()
  expect(
    drain(
      ejectBlockingLanes(input, initial, [], widths, layers, {
        maxSearches: 1,
      }),
    ),
  ).toBeNull()
})

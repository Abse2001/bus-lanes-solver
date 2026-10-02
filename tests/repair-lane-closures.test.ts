import { expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { repairLaneClosures, repairOrders } from "../lib/repair-lane-closures"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

function fixture() {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.2,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
    obstacles: [
      {
        type: "rect",
        center: { x: -1.2, y: 0 },
        width: 0.1,
        height: 2.4,
        layers: ["bottom"],
        connectedTo: ["wall"],
      },
      {
        type: "rect",
        center: { x: 1.2, y: 0 },
        width: 0.1,
        height: 2.4,
        layers: ["bottom"],
        connectedTo: ["wall"],
      },
      {
        type: "rect",
        center: { x: 0, y: -1.2 },
        width: 2.4,
        height: 0.1,
        layers: ["bottom"],
        connectedTo: ["wall"],
      },
      ...[
        [0, 0, "inside"],
        [0, 2.5, "inside"],
        [-0.8, 0.8, "bridge"],
        [0.8, 0.8, "bridge"],
      ].map(([x, y, name]) => ({
        type: "rect" as const,
        shape: "circle" as const,
        center: { x: Number(x), y: Number(y) },
        width: 0.3,
        height: 0.3,
        layers: ["bottom"],
        connectedTo: [String(name)],
      })),
    ],
    connections: [
      {
        name: "inside",
        pointsToConnect: [
          { x: 0, y: 0, layer: "bottom" },
          { x: 0, y: 2.5, layer: "bottom" },
        ],
      },
      {
        name: "bridge",
        pointsToConnect: [
          { x: -0.8, y: 0.8, layer: "bottom" },
          { x: 0.8, y: 0.8, layer: "bottom" },
        ],
      },
    ],
  }
  const bridge: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "existing_bridge",
    connection_name: "bridge",
    route: input.connections[1].pointsToConnect.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.2,
    })),
  }
  return {
    input,
    current: [bridge],
    fixed: fixedCopper(input),
    widths: new Map(input.connections.map((c) => [c.name, 0.2])),
  }
}
function drain<T>(generator: Generator<void, T>) {
  let next = generator.next()
  while (!next.done) next = generator.next()
  return next.value
}

test("bounded five-lane routing orders explore every first lane", () => {
  const names = ["a", "b", "c", "d", "e"]
  const orders = [...repairOrders(names)]
  expect(orders).toHaveLength(24)
  expect(new Set(orders.map((order) => JSON.stringify(order))).size).toBe(24)
  expect(new Set(orders.map((order) => order[0]))).toEqual(new Set(names))
  expect(orders.every((order) => new Set(order).size === names.length)).toBe(
    true,
  )
  const smaller = [...repairOrders(names.slice(0, 4))]
  expect(smaller).toHaveLength(24)
  expect(new Set(smaller.map((order) => JSON.stringify(order))).size).toBe(24)
})

test("an extra single-removal witness stays fixed when the four-lane subset can be repaired", () => {
  const connection = (
    name: string,
    start: [number, number],
    end: [number, number],
  ) => ({
    name,
    pointsToConnect: [start, end].map(([x, y]) => ({ x, y, layer: "bottom" })),
  })
  const connections = [
    connection("lane_a", [-0.4, -2], [-0.4, 2.5]),
    connection("lane_b", [0.4, -2], [0.4, 2.5]),
    ...[-2.5, 0, 2.5].map((x, i) =>
      connection(`gate_${i}`, [x - 0.7, 0], [x + 0.7, 0]),
    ),
  ]
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.2,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -4.5, maxX: 4.5, minY: -4, maxY: 4 },
    connections,
    obstacles: [
      ...[
        [-4.5, -3.45],
        [-1.55, -0.95],
        [0.95, 1.55],
        [3.45, 4.5],
      ].map(([a, b]) => ({
        type: "rect" as const,
        center: { x: (a + b) / 2, y: 0 },
        width: b - a,
        height: 1.4,
        layers: ["bottom"],
        connectedTo: ["wall"],
      })),
      ...connections.flatMap((c) =>
        c.pointsToConnect.map((p) => ({
          type: "rect" as const,
          shape: "circle" as const,
          center: p,
          width: 0.3,
          height: 0.3,
          layers: ["bottom"],
          connectedTo: [c.name],
        })),
      ),
    ],
  }
  const current: Trace[] = connections.slice(2).map((c) => ({
    type: "pcb_trace",
    pcb_trace_id: c.name,
    connection_name: c.name,
    route: c.pointsToConnect.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.2,
    })),
  }))
  const subsets: string[][] = []
  const result = drain(
    repairLaneClosures(
      input,
      connections,
      fixedCopper(input),
      current,
      new Map(connections.map((c) => [c.name, 0.2])),
      {
        maxSubsetSize: 5,
        onProgress: (p) => subsets.push(p.subset),
      },
    ),
  )!
  expect(result).toHaveLength(5)
  expect(subsets.every((subset) => subset.length <= 4)).toBe(true)
  expect(result.find((t) => t.connection_name === "gate_2")).toEqual(current[2])
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: result },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
})

test("a hard conditional replacement opens a sealed pocket without moving terminals or fixed copper", () => {
  const { input, current, fixed, widths } = fixture()
  const before = structuredClone({ input, current, fixed })
  const inside = input.connections[0]
  const blocked = new GridVisibilitySearch(
    new VectorScene(input, inside, 0.2, [
      ...fixed,
      ...current.flatMap(routeCopper),
    ]),
    inside.pointsToConnect[0],
    inside.pointsToConnect[1],
  )
  while (!blocked.solved && !blocked.failed) blocked.step()
  expect(blocked.failed).toBe(true)
  blocked.cancel()
  const result = drain(
    repairLaneClosures(input, input.connections, fixed, current, widths),
  )!
  expect(result).toHaveLength(2)
  expect(new Set(result.map((t) => t.connection_name))).toEqual(
    new Set(["inside", "bridge"]),
  )
  for (const trace of result) {
    const c = input.connections.find((c) => c.name === trace.connection_name)!
    expect(trace.route[0]).toMatchObject(c.pointsToConnect[0])
    expect(trace.route.at(-1)).toMatchObject(c.pointsToConnect[1])
    expect(
      trace.route.every((p) => p.route_type === "wire" && p.width === 0.2),
    ).toBe(true)
    expect(tuningPathIsSelfClear(trace.route, 0.3)).toBe(true)
    expect(
      new VectorScene(input, c, 0.2, [
        ...fixed,
        ...result.filter((t) => t !== trace).flatMap(routeCopper),
      ]).pathVisible(trace.route),
    ).toBe(true)
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: result },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.valid).toBe(true)
  expect({ input, current, fixed }).toEqual(before)
})

test("paired copper is never withdrawn to repair an ordinary lane closure", () => {
  const { input, current, fixed, widths } = fixture()
  current[0].coupledSection = [0, 1]
  const before = structuredClone(current)
  expect(
    drain(
      repairLaneClosures(input, input.connections, fixed, current, widths, {
        maxSearches: 16,
      }),
    ),
  ).toBeNull()
  expect(current).toEqual(before)
})

test("zero search budget preserves all inputs and does not accept incomplete copper", () => {
  const { input, current, fixed, widths } = fixture()
  const before = structuredClone({ input, current, fixed })
  expect(
    drain(
      repairLaneClosures(input, input.connections, fixed, current, widths, {
        maxSearches: 0,
      }),
    ),
  ).toBeNull()
  expect({ input, current, fixed }).toEqual(before)
})

test("closing a repair generator releases every active grid scratch lease", () => {
  const { input, current, fixed, widths } = fixture()
  const cancel = spyOn(GridVisibilitySearch.prototype, "cancel")
  let searches = 0
  const generator = repairLaneClosures(
    input,
    input.connections,
    fixed,
    current,
    widths,
    {
      onProgress: (p) => {
        searches = p.searches
      },
    },
  )
  try {
    while (!searches) expect(generator.next().done).toBe(false)
    generator.return(null)
    expect(cancel).toHaveBeenCalled()
    const repaired = drain(
      repairLaneClosures(input, input.connections, fixed, current, widths),
    )
    expect(repaired).toHaveLength(2)
  } finally {
    generator.return(null)
    cancel.mockRestore()
  }
})

function threeLayerFixture() {
  const base = fixture()
  const layers = ["inner1", "inner2", "bottom"]
  const input: SimpleRouteJson = {
    ...base.input,
    layerCount: 4,
    obstacles: layers.flatMap((layer, index) =>
      base.input.obstacles.map((o) => ({
        ...o,
        layers: [layer],
        connectedTo: o.connectedTo.map((n) => `${n}_${index}`),
      })),
    ),
    connections: layers.flatMap((layer, index) =>
      base.input.connections.map((c) => ({
        ...c,
        name: `${c.name}_${index}`,
        pointsToConnect: c.pointsToConnect.map((p) => ({ ...p, layer })),
      })),
    ),
  }
  const current = layers.map((layer, index) => ({
    ...base.current[0],
    pcb_trace_id: `existing_bridge_${index}`,
    connection_name: `bridge_${index}`,
    route: base.current[0].route.map((p) => ({
      ...p,
      route_type: "wire" as const,
      layer,
      width: 0.2,
    })),
  }))
  return {
    input,
    current,
    fixed: fixedCopper(input),
    widths: new Map(input.connections.map((c) => [c.name, 0.2])),
  }
}

test("three missing lanes on separate layers are repaired without changing their terminal layers", () => {
  const { input, current, fixed, widths } = threeLayerFixture()
  const before = structuredClone({ input, current, fixed })
  const result = drain(
    repairLaneClosures(input, input.connections, fixed, current, widths),
  )!
  expect(result).toHaveLength(6)
  for (const trace of result) {
    const c = input.connections.find((c) => c.name === trace.connection_name)!
    expect(
      trace.route.every(
        (p) =>
          p.route_type === "wire" && p.layer === c.pointsToConnect[0].layer,
      ),
    ).toBe(true)
    expect(
      new VectorScene(input, c, 0.2, [
        ...fixed,
        ...result.filter((t) => t !== trace).flatMap(routeCopper),
      ]).pathVisible(trace.route),
    ).toBe(true)
  }
  expect({ input, current, fixed }).toEqual(before)
})

test("independent layer repairs share one search budget and never return a partial solution", () => {
  const { input, current, fixed, widths } = threeLayerFixture()
  let searches = 0
  const result = drain(
    repairLaneClosures(input, input.connections, fixed, current, widths, {
      maxSearches: 3,
      onProgress: (p) => {
        searches = p.searches
      },
    }),
  )
  expect(result).toBeNull()
  expect(searches).toBe(3)
})

test("malformed existing copper cannot bypass continuous checks with non-finite coordinates or a narrower width", () => {
  for (const mutation of [
    (t: Trace) => {
      t.route[0].x = Number.NaN
    },
    (t: Trace) => {
      if (t.route[0].route_type === "wire") t.route[0].width = 0.19
    },
  ]) {
    const { input, current, fixed, widths } = fixture()
    mutation(current[0])
    expect(
      drain(
        repairLaneClosures(input, input.connections, fixed, current, widths),
      ),
    ).toBeNull()
  }
})

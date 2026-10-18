import { expect, test } from "bun:test"
import { SoftCopperCostIndex } from "../lib/soft-copper-cost"
import { routeSurfaceBridge } from "../lib/route-surface-bridge"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import type { SimpleRouteJson, Trace } from "../lib"
import { fixedCopper } from "../lib/vector-scene"

function board(): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minBoardEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    bounds: { minX: -4, maxX: 4, minY: -3, maxY: 3 },
    obstacles: [],
    connections: [
      {
        name: "target",
        pointsToConnect: [
          { x: -3, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
    ],
  }
}
function trace(
  name: string,
  x: number,
  bottom = -2,
  top = 2,
  layer = "top",
): Trace {
  return {
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    route: [
      { route_type: "wire", x, y: bottom, layer, width: 0.1 },
      { route_type: "wire", x, y: top, layer, width: 0.1 },
    ],
  }
}

test("indexed costs count independent nets, not subdivisions, repeated copper or another plane", () => {
  const input = board()
  const one = trace("one", 0)
  const index = new SoftCopperCostIndex(input, input.connections[0], [
    one,
    { ...one, pcb_trace_id: "one-copy" },
    trace("two", 0.05),
    trace("opposite", 0, -2, 2, "bottom"),
    trace("target", 0),
    trace("far", 3),
  ])
  expect(
    index.edgeCost({ x: -0.2, y: 0 }, { x: 0.2, y: 0 }, "top", 0.05, 0.05),
  ).toBe(2)
  expect(
    index.edgeCost(
      { x: -0.2, y: 0 },
      { x: 0.2, y: 0 },
      "top",
      0.05,
      0.05,
      true,
    ),
  ).toBe(1)
  expect(
    index.edgeCost({ x: -0.2, y: 0 }, { x: 0.2, y: 0 }, "bottom", 0.05, 0.05),
  ).toBe(1)
  expect(
    index.edgeCost({ x: -2, y: 0 }, { x: -1.5, y: 0 }, "top", 0.05, 0.05),
  ).toBe(0)
})

test("landing costs union through-via lands and drill conflicts by net across physical planes", () => {
  const input = board()
  const via: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "via",
    connection_name: "via-net",
    route: [
      {
        route_type: "via",
        x: 0,
        y: 0,
        from_layer: "top",
        to_layer: "bottom",
        layers: ["top", "inner1", "inner2", "bottom"],
        via_diameter: 0.3,
        via_hole_diameter: 0.2,
      },
    ],
  }
  const index = new SoftCopperCostIndex(input, input.connections[0], [
    via,
    trace("wire", 0),
    trace("bottom-wire", 0, -2, 2, "bottom"),
  ])
  expect(index.landingCost({ x: 0, y: 0 }, 0.15, 0.05, 0.1, 0.25)).toBe(3)
  // Land copper is clear here; only the stricter drill spacing reaches the via.
  expect(index.landingCost({ x: 0.4, y: 0 }, 0.15, 0.05, 0.1, 0.25)).toBe(1)
})

test("per-net weights affect cost without changing exact clearance or charging same-net chunks twice", () => {
  const input = board()
  const one = trace("one", 0)
  const index = new SoftCopperCostIndex(
    input,
    input.connections[0],
    [one, { ...one, pcb_trace_id: "duplicate" }, trace("two", 0)],
    { one: 5, two: 2 },
  )
  expect(
    index.edgeCost({ x: -0.2, y: 0 }, { x: 0.2, y: 0 }, "top", 0.05, 0.05),
  ).toBe(7)
  expect(
    index.edgeCost(
      { x: -0.2, y: 0 },
      { x: 0.2, y: 0 },
      "top",
      0.05,
      0.05,
      true,
    ),
  ).toBe(1)
  expect(
    () =>
      new SoftCopperCostIndex(input, input.connections[0], [one], { one: -1 }),
  ).toThrow()
})

test("surface routing favors a single-net opening over a coincident five-net bundle", () => {
  const input = board()
  // Every top-layer crossing must choose the short lower bundle or the
  // slightly higher single-net window. A hard bottom plane prevents bypassing
  // the comparison through vias; both choices retain the same hard geometry.
  input.obstacles.push({
    center: { x: 0, y: 0 },
    width: 8,
    height: 6,
    layers: ["bottom"],
    connectedTo: [],
  })
  const soft = [
    ...Array.from({ length: 5 }, (_, i) => trace(`bundle-${i}`, 0, -2.95, 0.1)),
    trace("single", 0, 0.35, 2.95),
  ]
  const finish = (binary: boolean) => {
    const search = routeSurfaceBridge(input, input.connections[0], {
      gridStep: 0.1,
      softTraces: soft,
      softPenalty: 10,
      viaPenalty: 100,
      softConflictCost: binary ? "binary" : "per-net",
      maxExpansions: 200000,
    })
    let step = search.next(),
      count = 0
    while (!step.done && count++ < 10000) step = search.next()
    expect(step.done).toBe(true)
    expect(step.value).toBeTruthy()
    const result = step.value!
    const joined = joinSignalEscapes(result.carrier, result.escapes)
    const actual = fixedCopper({ ...input, obstacles: [], traces: [joined] })
    const conflicts = new CopperConflictIndex()
    return soft
      .filter((other) =>
        conflicts.firstConflict(
          actual,
          fixedCopper({ ...input, obstacles: [], traces: [other] }),
          0.05 - 1e-8,
        ),
      )
      .map((other) => other.connection_name)
  }
  expect(finish(true)).toHaveLength(5)
  expect(finish(false)).toEqual(["single"])
})

test("fractional soft-weight scaling preserves costs in the bridge edge cache", () => {
  const input = board()
  input.minTraceWidth = 0.02
  input.minTraceToPadEdgeClearance = 0.01
  input.minViaPadDiameter = 0.1
  input.minViaHoleDiameter = 0.05
  input.bounds = { minX: -1, maxX: 1, minY: -0.6, maxY: 0.6 }
  input.connections[0].pointsToConnect = [
    { x: -0.8, y: 0, layer: "top" },
    { x: 0.8, y: 0, layer: "top" },
  ]
  const wall = trace("wall", 0, -0.2, 0.2)
  wall.route = wall.route.map((point) => ({ ...point, width: 0.02 }))
  const before = structuredClone(input),
    conflicts = new CopperConflictIndex(),
    wallCopper = fixedCopper({ ...input, obstacles: [], traces: [wall] })
  // The product penalty*weight is always 100. Tiny fractional weights must
  // survive caching: adding a sentinel of one rounds them away in Float32,
  // and even in Float64 for the last case.
  for (const [softPenalty, weight] of [
    [100, 1],
    [1e10, 1e-8],
    [1e22, 1e-20],
  ]) {
    const search = routeSurfaceBridge(input, input.connections[0], {
      gridStep: 0.1,
      maxExpansions: 20000,
      maxLength: 3,
      softTraces: [wall],
      softPenalty,
      softNetWeights: { wall: weight },
      viaPenalty: 100,
    })
    let step = search.next(),
      yields = 0
    while (!step.done && yields++ < 10000) step = search.next()
    expect(step.done).toBe(true)
    expect(step.value).toBeTruthy()
    if (!step.done || !step.value) throw Error("Expected a soft-copper detour")
    const joined = joinSignalEscapes(step.value.carrier, step.value.escapes)
    expect(
      conflicts.firstConflict(
        fixedCopper({ ...input, obstacles: [], traces: [joined] }),
        wallCopper,
        0.01 - 1e-8,
      ),
    ).toBeUndefined()
    expect(joined.route.every((point) => point.route_type === "wire")).toBe(
      true,
    )
  }
  expect(input).toEqual(before)
})

import { expect, test } from "bun:test"
import { routePairedNetwork } from "../lib/route-paired-network"
import { preparePairedNetwork } from "../lib/paired-network"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Wire } from "../lib/types"

function fixture(): SimpleRouteJson {
  const layers = ["inner1", "inner2", "bottom"]
  return {
    layerCount: 4,
    minTraceWidth: 0.12,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 16, minY: -5, maxY: 5 },
    obstacles: [],
    connections: [
      ...layers.flatMap((layer, i) =>
        [-0.12, 0.12].map((y, side) => ({
          name: `pair${i}_${side}`,
          pointsToConnect: [
            { x: 0, y, layer },
            { x: 12, y, layer },
          ],
        })),
      ),
      {
        name: "control",
        pointsToConnect: [
          { x: 0, y: 3, layer: "bottom" },
          { x: 12, y: 3, layer: "bottom" },
        ],
      },
    ],
    buses: [0, 1].map((i) => ({
      busId: `bus${i}`,
      connectionNames: [`pair${i}_0`, `pair${i}_1`],
      maxLengthSkew: 0.5,
    })),
    differentialPairs: layers.map((_, i) => ({
      connectionNames: [`pair${i}_0`, `pair${i}_1`] as [string, string],
      traceGap: 0.12,
      lengthTolerance: 0.127,
    })),
  }
}

test("wide handoff clearance is reserved without obstructing its own rails", () => {
  const input = fixture()
  const original = structuredClone(input)
  const g = preparePairedNetwork(input, new Map())
  let state = g.next()
  while (!state.done) state = g.next()
  const network = state.value!
  const t = network.transforms[0]
  const p = t.connection.pointsToConnect[0]
  const start = t.center[0]
  const span = Math.hypot(p.x - start.x, p.y - start.y)
  const probe = {
    ...p,
    x: p.x + ((p.x - start.x) / span) * 0.3,
    y: p.y + ((p.y - start.y) / span) * 0.3,
  }
  const foreign = {
    name: "unrelated_lane",
    pointsToConnect: [probe, probe],
  }
  const unreserved = fixedCopper({
    ...network.local,
    obstacles: input.obstacles,
  })
  // Two separated round rail caps leave a legal narrow passage that cannot
  // accommodate the wide corridor's own terminal clearance.
  expect(
    new VectorScene(network.local, foreign, 0.12, unreserved).visible(
      probe,
      probe,
    ),
  ).toBe(true)
  expect(
    new VectorScene(network.local, foreign, 0.12, network.copper).visible(
      probe,
      probe,
    ),
  ).toBe(false)
  const approach = t.approaches[0]
  const own = new VectorScene(network.local, approach, 0.12, network.copper)
  expect(own.copper.some((c) => c.owners.includes(t.connection.name))).toBe(
    true,
  )
  expect(
    own.copper.some((c) => c.owners.includes(approach.source_trace_id!)),
  ).toBe(false)
  expect(input).toEqual(original)
})

test("joint network returns native coupled rails without synthetic connections or extra vias", () => {
  const input = fixture(),
    g = routePairedNetwork(input, new Map()),
    original = structuredClone(input)
  let state = g.next(),
    steps = 0
  while (!state.done && steps++ < 10000) state = g.next()
  expect(state.done).toBe(true)
  const traces = state.value!
  expect(traces).toHaveLength(input.connections.length)
  expect(new Set(traces.map((t) => t.connection_name))).toEqual(
    new Set(input.connections.map((c) => c.name)),
  )
  expect(sharedPairSpacingReports(input, traces).every((p) => p.matched)).toBe(
    true,
  )
  const copper = [...fixedCopper(input), ...traces.flatMap(routeCopper)]
  for (const trace of traces) {
    expect(trace.route.every((p) => p.route_type === "wire")).toBe(true)
    expect(
      new VectorScene(
        input,
        input.connections.find((c) => c.name === trace.connection_name)!,
        (trace.route[0] as Wire).width,
        copper,
      ).pathVisible(trace.route),
    ).toBe(true)
  }
  expect(input.traces).toEqual(original.traces)
  expect(input.obstacles).toEqual(original.obstacles)
})

test("cancelling a joint network permits a fresh run", () => {
  const g = routePairedNetwork(fixture(), new Map())
  g.next()
  expect(g.return(null).done).toBe(true)
  const next = routePairedNetwork(fixture(), new Map())
  let state = next.next(),
    steps = 0
  while (!state.done && steps++ < 10000) state = next.next()
  expect(state.done).toBe(true)
  expect(state.value).toHaveLength(7)
})

test("native bus width overrides are retained by the virtual network", () => {
  const input = fixture()
  input.buses![0].traceWidth = 0.16
  for (const c of input.connections.filter((c) =>
    input.buses![0].connectionNames.includes(c.name),
  )) {
    c.nominalTraceWidth = 0.12
    for (const p of c.pointsToConnect) p.y = Math.sign(p.y) * 0.14
  }
  const g = routePairedNetwork(input, new Map())
  let state = g.next(),
    steps = 0
  while (!state.done && steps++ < 10000) state = g.next()
  expect(state.done).toBe(true)
  expect(state.value).toHaveLength(7)
  for (const trace of state.value!.filter((t) =>
    input.buses![0].connectionNames.includes(t.connection_name!),
  ))
    expect(
      trace.route.every((p) => p.route_type === "wire" && p.width === 0.16),
    ).toBe(true)
})

test("bus and standalone pairs sharing a carrier remain distinct wide demands", () => {
  const input = fixture()
  input.allowedLayers = ["inner1", "inner2"]
  for (const c of input.connections)
    if (c.pointsToConnect[0].layer === "bottom")
      for (const p of c.pointsToConnect) {
        p.layer = "inner1"
        if (c.name !== "control") p.y += 2
      }
  const before = structuredClone(input)
  const generator = routePairedNetwork(input, new Map())
  let state = generator.next(),
    steps = 0
  while (!state.done && steps++ < 10000) state = generator.next()
  expect(state.done).toBe(true)
  expect(state.value).toHaveLength(7)
  const copper = [...fixedCopper(input), ...state.value!.flatMap(routeCopper)]
  for (const trace of state.value!) {
    expect(
      trace.route.every(
        (p) =>
          p.route_type === "wire" && input.allowedLayers!.includes(p.layer),
      ),
    ).toBe(true)
    expect(
      new VectorScene(
        input,
        input.connections.find((c) => c.name === trace.connection_name)!,
        0.12,
        copper,
      ).pathVisible(trace.route),
    ).toBe(true)
  }
  expect(
    sharedPairSpacingReports(input, state.value!).every((r) => r.matched),
  ).toBe(true)
  expect(input).toEqual(before)
})

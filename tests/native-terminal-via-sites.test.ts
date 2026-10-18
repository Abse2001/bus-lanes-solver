import { expect, test } from "bun:test"
import {
  getCopperLayerNames,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { expandedSignalSites } from "../lib/expanded-signal-sites"
import { distance } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeSurfaceBridge } from "../lib/route-surface-bridge"
import type { SimpleRouteJson, Via } from "../lib/types"

function finish<T>(search: Generator<void, T>): T {
  let result = search.next(),
    steps = 0
  while (!result.done && steps++ < 100000) result = search.next()
  if (!result.done) throw Error("Bounded native-site fixture did not finish")
  return result.value
}

function fixture(): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1016,
    minTraceToPadEdgeClearance: 0.1016,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    bounds: { minX: -0.8, maxX: 4.8, minY: -0.8, maxY: 0.8 },
    connections: [
      {
        name: "route",
        source_trace_id: "native-source",
        pointsToConnect: [0, 4].map((x) => ({ x, y: 0, layer: "top" })),
      },
    ],
    buses: [
      { busId: "data", connectionNames: ["route"], preferredLayer: "bottom" },
    ],
    obstacles: [0, 4].map((x) => ({
      componentId: `package_${x}`,
      shape: "circle",
      center: { x, y: 0 },
      width: 0.4,
      height: 0.4,
      layers: ["top"],
      connectedTo: x ? ["native-source", "route"] : ["native-source"],
    })),
  }
}

test("public surface routing permits legal offcentre own-pad land overlap with full-stack barrels", () => {
  const input = fixture(),
    before = structuredClone(input)
  const result = finish(
    routeSurfaceBridge(input, input.connections[0], {
      gridStep: 0.4,
      viaPenalty: 0,
      maxLength: 4.000001,
    }),
  )
  expect(result).toBeTruthy()
  const joined = joinSignalEscapes(result!.carrier, result!.escapes)
  const vias = joined.route.filter(
    (point): point is Via => point.route_type === "via",
  )
  expect(vias).toHaveLength(2)
  for (const [index, via] of vias.entries()) {
    expect(
      distance(via, input.connections[0].pointsToConnect[index]),
    ).toBeCloseTo(0.4, 7)
    expect(
      distance(via, input.connections[0].pointsToConnect[index]) -
        0.2 -
        via.via_diameter! / 2,
    ).toBeLessThan(0)
    expect(via.layers).toEqual(getCopperLayerNames(4))
    expect(
      input.connections
        .flatMap((connection) => connection.pointsToConnect)
        .every((point) => distance(point, via) > 1e-6),
    ).toBe(true)
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [joined] },
      clearance: 0.1016,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect(input).toEqual(before)
})

test("expanded sites protect every queued native terminal, including a different connection without a pad obstacle", () => {
  const input = fixture()
  input.bounds = { minX: -3, maxX: 7, minY: -3, maxY: 3 }
  for (const x of [0, 4])
    input.obstacles.push({
      componentId: `package_${x}`,
      shape: "circle",
      center: { x, y: 0.8 },
      width: 0.4,
      height: 0.4,
      layers: ["top"],
      connectedTo: [`other_${x}`],
    })
  const queued = { x: -0.4, y: 0, layer: "top" }
  input.connections.push({
    name: "queued",
    pointsToConnect: [queued, { x: 6, y: 2, layer: "top" }],
  })
  const before = structuredClone(input),
    [start, end] = finish(
      expandedSignalSites(input, input.connections[0], "bottom"),
    )
  expect(start.length).toBeGreaterThan(0)
  expect(end.length).toBeGreaterThan(0)
  const vias = [...start, ...end].flatMap((site) =>
    site.escape.route.filter(
      (point): point is Via => point.route_type === "via",
    ),
  )
  expect(vias.every((via) => distance(via, queued) > 1e-6)).toBe(true)
  expect(
    vias.every((via) =>
      input.connections
        .flatMap((connection) => connection.pointsToConnect)
        .every((point) => distance(via, point) > 1e-6),
    ),
  ).toBe(true)
  expect(
    vias.every((via) => via.layers?.join() === getCopperLayerNames(4).join()),
  ).toBe(true)
  expect(input).toEqual(before)
})

test("foreign-pad copper remains a hard constraint on offcentre manufactured sites", () => {
  const input = fixture()
  input.obstacles.push({
    shape: "circle",
    center: { x: 0.4, y: 0 },
    width: 0.2,
    height: 0.2,
    layers: ["inner1"],
    connectedTo: ["foreign"],
  })
  const result = finish(
    routeSurfaceBridge(input, input.connections[0], {
      gridStep: 0.4,
      viaPenalty: 0,
      maxLength: 4.000001,
    }),
  )
  expect(result).toBeTruthy()
  const joined = joinSignalEscapes(result!.carrier, result!.escapes)
  expect(
    joined.route
      .filter((point) => point.route_type === "via")
      .every((via) => distance(via, { x: 0.4, y: 0 }) > 0.4),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [joined] },
      clearance: 0.1016,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
})

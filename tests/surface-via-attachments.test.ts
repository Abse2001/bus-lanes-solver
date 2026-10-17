import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { criticalSurfaceGridOrigins } from "../lib/critical-surface-grid-origins"
import { distance, length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import {
  routeSurfaceBridge,
  surfaceBridgeSelfShorts,
} from "../lib/route-surface-bridge"
import { routeSurfaceViaAttachments } from "../lib/route-surface-via-attachments"
import type { SimpleRouteJson, Trace, Via } from "../lib/types"

function finish<T>(search: Generator<void, T>): T {
  let result = search.next(),
    count = 0
  while (!result.done && count++ < 10000) result = search.next()
  if (!result.done) throw Error("Endpoint handoff search exceeded its bound")
  return result.value
}

function incompatibleChannels(offset = 0): SimpleRouteJson {
  const traces: Trace[] = [-1.4, -0.638, 0.6238, 1.3858].map((x, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `rail-${i}`,
    connection_name: `rail-${i}`,
    route: [-1.4492, 1.4492].map((y) => ({
      x: x + offset,
      y: y + offset,
      route_type: "wire",
      layer: "top",
      width: 0.1016,
    })),
  }))
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1016,
    minTraceToPadEdgeClearance: 0.1016,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
    bounds: {
      minX: -3 + offset,
      maxX: 3 + offset,
      minY: -1.5 + offset,
      maxY: 1.5 + offset,
    },
    obstacles: [],
    connections: [
      {
        name: "signal",
        source_trace_id: "source-signal",
        pointsToConnect: [-1, 1.02].map((x, i) => ({
          x: x + offset,
          y: offset,
          layer: "top",
          pcb_port_id: `original-pad-${i}`,
        })),
      },
      ...traces.map((trace) => ({
        name: trace.connection_name!,
        pointsToConnect: trace.route.map((point) => ({
          x: point.x,
          y: point.y,
          layer: "top",
        })),
      })),
    ],
    traces,
  }
}

test("independent endpoint phases route two exact-clearance channels no single raster phase can join", () => {
  for (const offset of [0, 0.013719]) {
    const input = incompatibleChannels(offset),
      connection = input.connections[0],
      before = JSON.stringify(input),
      options = { gridStep: 0.1, maxVias: 4, maxExpansions: 12000 }
    // Legal centers differ by 2.0238 mm: both cannot belong to one .1 lattice.
    for (const gridOrigin of [
      undefined,
      ...criticalSurfaceGridOrigins(input, connection, 0.1),
    ])
      expect(
        finish(
          routeSurfaceBridge(input, connection, { ...options, gridOrigin }),
        ),
      ).toBeNull()
    const result = finish(
      routeSurfaceViaAttachments(input, connection, options),
    )
    expect(result).toBeTruthy()
    expect(
      result!.carrier.route.every(
        (point) => point.route_type === "wire" && point.layer === "bottom",
      ),
    ).toBe(true)
    expect(result!.escapes).toHaveLength(2)
    const joined = joinSignalEscapes(result!.carrier, result!.escapes),
      vias = joined.route.filter(
        (point): point is Via => point.route_type === "via",
      )
    expect(vias).toHaveLength(2)
    expect(vias[0].x - offset).toBeCloseTo(-1.019, 8)
    expect(vias[1].x - offset).toBeCloseTo(1.0048, 8)
    for (const [i, via] of vias.entries()) {
      expect(via.layers).toEqual(["top", "inner1", "inner2", "bottom"])
      expect(via.via_diameter).toBe(0.4572)
      expect(via.via_hole_diameter).toBe(0.254)
      expect(
        distance(via, connection.pointsToConnect[i]),
      ).toBeGreaterThanOrEqual(0.05 - 1e-8)
    }
    expect(joined.route[0]).toMatchObject(connection.pointsToConnect[0])
    expect(joined.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
    expect(surfaceBridgeSelfShorts(input, connection, joined)).toBe(false)
    const report = validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [...input.traces!, joined] },
      clearance: 0.1016,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0])
    expect(report.valid).toBe(true)
    expect(JSON.stringify(input)).toBe(before)
  }
})

test("endpoint handoffs preserve full length budgets and require explicit four-via policy", () => {
  const input = incompatibleChannels(),
    connection = input.connections[0],
    options = { gridStep: 0.1, maxVias: 4 }
  expect(finish(routeSurfaceViaAttachments(input, connection))).toBeNull()
  expect(
    finish(
      routeSurfaceViaAttachments(input, connection, { ...options, maxVias: 2 }),
    ),
  ).toBeNull()
  const unconstrained = finish(
      routeSurfaceViaAttachments(input, connection, options),
    )!,
    joined = joinSignalEscapes(unconstrained.carrier, unconstrained.escapes),
    bound = length(joined.route)
  const bounded = finish(
    routeSurfaceViaAttachments(input, connection, {
      ...options,
      maxLength: bound + 1e-6,
    }),
  )
  expect(bounded).toBeTruthy()
  expect(
    length(joinSignalEscapes(bounded!.carrier, bounded!.escapes).route),
  ).toBeLessThanOrEqual(bound + 1e-6)
  expect(
    finish(
      routeSurfaceViaAttachments(input, connection, {
        ...options,
        maxLength: 2.025,
      }),
    ),
  ).toBeNull()
  const busLimited = {
    ...input,
    buses: [
      {
        busId: "limited",
        connectionNames: [connection.name],
        maxLength: 2.025,
      },
    ],
  }
  expect(
    finish(routeSurfaceViaAttachments(busLimited, connection, options)),
  ).toBeNull()
})

test("independent handoffs retain a single-plane carrier when two further transitions are necessary", () => {
  const input = incompatibleChannels()
  // Widen the center region and block its Bottom plane from edge to edge.
  for (const trace of input.traces!.slice(2))
    for (const point of trace.route) point.x += 1
  for (const connection of input.connections.slice(3))
    for (const point of connection.pointsToConnect) point.x += 1
  input.connections[0].pointsToConnect[1].x += 1
  input.bounds.maxX += 1
  input.obstacles.push({
    type: "rect",
    center: { x: 0.5, y: 0 },
    width: 0.1,
    height: 3,
    layers: ["bottom"],
    connectedTo: ["middle-wall"],
  })
  const connection = input.connections[0],
    result = finish(
      routeSurfaceViaAttachments(input, connection, {
        gridStep: 0.1,
        maxVias: 4,
        maxExpansions: 30000,
      }),
    )
  expect(result).toBeTruthy()
  const joined = joinSignalEscapes(result!.carrier, result!.escapes),
    vias = joined.route.filter(
      (point): point is Via => point.route_type === "via",
    )
  expect(vias).toHaveLength(4)
  expect(
    result!.carrier.route.every(
      (point) => point.route_type === "wire" && point.layer === "top",
    ),
  ).toBe(true)
  expect(
    result!.escapes.map(
      (escape) =>
        escape.route.filter((point) => point.route_type === "via").length,
    ),
  ).toEqual([2, 2])
  expect(joined.route[0]).toMatchObject(connection.pointsToConnect[0])
  expect(joined.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
  expect(surfaceBridgeSelfShorts(input, connection, joined)).toBe(false)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [...input.traces!, joined] },
      clearance: 0.1016,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
})

test("supplemental local search terminates with microscopic pitches and distant finite phase origins", () => {
  const input = incompatibleChannels(),
    connection = input.connections[0]
  for (const gridStep of [1e-20, 1e-100]) {
    const search = routeSurfaceViaAttachments(input, connection, {
      gridStep,
      gridOrigin: { x: 1e16, y: -1e16 },
      maxAttachmentLength: 0.15,
      maxEndpointCandidates: 1,
      maxAttachmentPairs: 1,
      maxVias: 4,
      maxExpansions: 1,
      maxGridCells: 100,
    })
    // The actual carrier raster coarsens to its normal memory budget. The
    // supplemental local phase sampler must not iterate 1/gridStep times.
    const result = finish(search)
    expect(result === null || result.escapes.length === 2).toBe(true)
  }
})

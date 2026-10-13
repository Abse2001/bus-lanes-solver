import { expect, test } from "bun:test"
import { chamferOrdinaryCorners } from "../lib/chamfer-ordinary-corners"
import {
  coupledHandoffExceedsLengthLimit,
  coupledPairApproachTrims,
} from "../lib/coupled-handoff-length-bound"
import { distance, length } from "../lib/geometry"
import { maximumCarrierLength } from "../lib/route-lengths"
import type { SimpleRouteJson, Trace } from "../lib/types"

const fixture = (): SimpleRouteJson => ({
  layerCount: 4,
  minTraceWidth: 0.1016,
  bounds: { minX: -18, maxX: 18, minY: -10, maxY: 33 },
  obstacles: [],
  connections: [{
    name: "source_trace_15",
    source_trace_id: "source_trace_15",
    pointsToConnect: [
      { x: 3.6, y: 13.2, layer: "top" },
      { x: 3.2, y: 7.8, layer: "top" },
    ],
  }],
  buses: [{
    busId: "DDR_BYTE0",
    connectionNames: ["source_trace_15"],
    traceWidth: 0.1016,
    maxLength: 13.2,
    maxLengthSkew: 0.635,
  }],
})

test("G350's observed impossible strobe handoff is rejected before escape search", () => {
  const input = fixture()
  const before = structuredClone(input)
  const handoff = { x: -7.6372, y: 13.6 }
  const connection = input.connections[0]
  const rawMinimum =
    distance(connection.pointsToConnect[0], handoff) +
    distance(handoff, connection.pointsToConnect[1])
  expect(rawMinimum).toBeCloseTo(23.535976887680732, 10)
  expect(coupledHandoffExceedsLengthLimit(input, connection, [handoff], 0.1016))
    .toBe(true)
  expect(input).toEqual(before)
})

test("a handoff slightly over the raw budget remains eligible after the existing bevel", () => {
  const route: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "near-budget",
    connection_name: "D",
    coupledSection: [1, 2],
    route: [[0, 0], [3, 0], [3, 3]].map(([x, y]) => ({
      route_type: "wire", x, y, layer: "top", width: 0.1,
    })),
  }
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -1, maxX: 4, minY: -1, maxY: 4 },
    obstacles: [],
    connections: [{
      name: "D",
      pointsToConnect: [
        { x: 0, y: 0, layer: "top" },
        { x: 3, y: 3, layer: "top" },
      ],
    }],
    buses: [{busId: "D", connectionNames: ["D"], maxLength: 6}],
  }
  const [shaped] = chamferOrdinaryCorners(input, [route], [], coupledPairApproachTrims[0])
  input.buses![0].maxLength = length(shaped.route)
  expect(length(route.route)).toBeGreaterThan(input.buses![0].maxLength!)
  expect(coupledHandoffExceedsLengthLimit(input, input.connections[0], [route.route[1]], 0.1))
    .toBe(false)
  expect(coupledPairApproachTrims).toEqual([1.5, 0.75, 0.375, 0.1875])
})

test("fixed terminal copper aliases count against the tightest current planar cap", () => {
  const input = fixture()
  const connection = input.connections[0]
  const handoff = { x: -7.6372, y: 13.6 }
  input.buses![0].maxLength = 25
  expect(coupledHandoffExceedsLengthLimit(input, connection, [handoff], 0.1016))
    .toBe(false)
  input.traces = [{
    type: "pcb_trace",
    pcb_trace_id: "fixed-alias",
    connection_name: "owned-escape-alias",
    source_trace_id: connection.source_trace_id,
    route: [
      {route_type: "wire", x: 1, y: 1, layer: "top", width: 0.1016},
      {route_type: "wire", x: 3, y: 1, layer: "top", width: 0.1016},
      {route_type: "via", x: 3, y: 1, from_layer: "top", to_layer: "inner1"},
      {route_type: "wire", x: 3, y: 1, layer: "inner1", width: 0.1016},
    ],
  }]
  expect(maximumCarrierLength(input, connection.name)).toBe(23)
  expect(coupledHandoffExceedsLengthLimit(input, connection, [handoff], 0.1016))
    .toBe(true)
  input.buses!.push({busId: "looser", connectionNames: [connection.name], maxLength: 30})
  expect(coupledHandoffExceedsLengthLimit(input, connection, [handoff], 0.1016))
    .toBe(true)
})

test("an initially unbounded call cannot cache a stale result when a cap is later added", () => {
  const input = fixture()
  const connection = input.connections[0]
  const handoff = { x: -7.6372, y: 13.6 }
  delete input.buses![0].maxLength
  expect(coupledHandoffExceedsLengthLimit(input, connection, [handoff], 0.1016))
    .toBe(false)
  input.buses![0].maxLength = 13.2
  expect(coupledHandoffExceedsLengthLimit(input, connection, [handoff], 0.1016))
    .toBe(true)
})

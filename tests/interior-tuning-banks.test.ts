import { expect, test } from "bun:test"
import { spreadCoupledTuningLanes } from "../lib/spread-coupled-tuning-lanes"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function fixture() {
  const traces: Trace[] = [0, 0.22, 2, 3, 4, 5].map((y, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `D${i}`,
    connection_name: `D${i}`,
    coupledSection: i < 2 ? [0, 1] : undefined,
    route: [0, 15].map((x) => ({
      route_type: "wire",
      x,
      y,
      width: 0.1,
      layer: "top",
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -1, maxX: 16, minY: -8, maxY: 12 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: t.route as Wire[],
    })),
    buses: [
      {
        busId: "data",
        connectionNames: traces.map((t) => t.connection_name!),
        maxLengthSkew: 0.635,
      },
    ],
    differentialPairs: [
      { connectionNames: ["D0", "D1"], traceGap: 0.12, lengthTolerance: 0.127 },
    ],
  }
  return { input, traces }
}
const height = (traces: Trace[]) =>
  Math.max(...traces.flatMap((t) => t.route.map((p) => p.y))) -
  Math.min(...traces.flatMap((t) => t.route.map((p) => p.y)))

test("interior banks keep paired lanes inside the approaches instead of opening outward U corridors", () => {
  const { input, traces } = fixture(),
    before = structuredClone(traces)
  const outward = spreadCoupledTuningLanes(input, traces, 0.8)!
  const interior = spreadCoupledTuningLanes(input, traces, 0.8, "interior")!
  expect(interior).not.toBeNull()
  expect(outward).not.toBeNull()
  expect(height(interior)).toBeLessThan(height(outward) * 0.8)
  expect(routeAnglesAreConventional(interior)).toBe(true)
  expect(
    sharedPairSpacingReports(input, interior).every((p) => p.matched),
  ).toBe(true)
  const copper = [...fixedCopper(input), ...interior.flatMap(routeCopper)]
  interior.forEach((t, i) => {
    expect(t.route[0]).toEqual(traces[i].route[0])
    expect(t.route.at(-1)).toEqual(traces[i].route.at(-1))
    expect(
      new VectorScene(input, input.connections[i], 0.1, copper).pathVisible(
        t.route,
      ),
    ).toBe(true)
    expect(tuningPathIsSelfClear(t.route, 0.175)).toBe(true)
  })
  expect(traces).toEqual(before)
})

test("interior allocation rejects blocked banks without moving fixed copper", () => {
  const { input, traces } = fixture()
  input.obstacles.push({
    center: { x: 7.5, y: 2.5 },
    width: 1,
    height: 20,
    layers: ["top"],
    connectedTo: [],
  })
  const before = structuredClone(input)
  expect(spreadCoupledTuningLanes(input, traces, 0.8, "interior")).toBeNull()
  expect(input).toEqual(before)
})

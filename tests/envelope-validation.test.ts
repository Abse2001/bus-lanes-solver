import { expect, test } from "bun:test"
import {
  optimizeTuningEnvelope,
  routeEnvelopeArea,
  validateNativeEnvelopeCandidate,
} from "../lib/optimize-tuning-envelope"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function fixture() {
  const traces: Trace[] = [0, 1].map((y) => ({
    type: "pcb_trace",
    pcb_trace_id: `n${y}`,
    connection_name: `n${y}`,
    route: [0, 10].map((x) => ({
      route_type: "wire",
      x,
      y,
      layer: "top",
      width: 0.1,
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 11, minY: -2, maxY: 5 },
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: t.route as Wire[],
    })),
    obstacles: [],
    buses: [
      { busId: "b", connectionNames: ["n0", "n1"], maxLengthSkew: 0.635 },
    ],
  }
  return { input, traces }
}
test("candidate acceptance rejects incomplete, disconnected, skewed and colliding copper", () => {
  const { input, traces } = fixture()
  expect(validateNativeEnvelopeCandidate(input, traces)).toBe(true)
  expect(routeEnvelopeArea(traces)).toBeCloseTo(10.1 * 1.1, 8)
  expect(validateNativeEnvelopeCandidate(input, traces.slice(0, 1))).toBe(false)
  const detached = structuredClone(traces)
  detached[0].route[0].x += 0.1
  expect(validateNativeEnvelopeCandidate(input, detached)).toBe(false)
  const skewed = structuredClone(traces)
  skewed[1].route.splice(1, 0, {
    route_type: "wire",
    x: 5,
    y: 3,
    layer: "top",
    width: 0.1,
  })
  expect(validateNativeEnvelopeCandidate(input, skewed)).toBe(false)
  input.obstacles.push({
    center: { x: 5, y: 0 },
    width: 1,
    height: 1,
    layers: ["top"],
    connectedTo: [],
  })
  expect(validateNativeEnvelopeCandidate(input, traces)).toBe(false)
})
test("zero optimization attempts preserve the seed and perform no search", () => {
  const { input, traces } = fixture(),
    before = structuredClone({ input, traces })
  expect([...optimizeTuningEnvelope(input, traces, 0)]).toEqual([])
  expect({ input, traces }).toEqual(before)
})

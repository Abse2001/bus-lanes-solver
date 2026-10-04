import { expect, test } from "bun:test"
import {
  compactMatchingGroups,
  matchingGroupsSupportEnvelope,
} from "../lib/compact-matching-groups"
import { signalEnvelope } from "../lib/carrier-compaction-view"
import { busLengthReports } from "../lib/route-lengths"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

test("matching groups shrink together within full-copper bounds", () => {
  const traces: Trace[] = [0, 1, 2].map((i) => ({
    type: "pcb_trace",
    pcb_trace_id: `trace${i}`,
    connection_name: `signal${i}`,
    route: [
      [0, 0],
      [1, 1],
      [1, 6],
      [2, 7],
      [8, 7],
      [9, 6],
      [9, 1],
      [10, 0],
    ].map(([x, y]) => ({
      route_type: "wire",
      x,
      y,
      layer: `inner${i + 1}`,
      width: 0.1,
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 5,
    allowedLayers: ["inner1", "inner2", "inner3"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 12, minY: -2, maxY: 10 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
    buses: [
      {
        busId: "first",
        connectionNames: ["signal0", "signal1", "signal2"],
        minLength: 20,
        maxLength: 22,
        maxLengthSkew: 0.05,
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "power",
        connection_name: "VCC",
        route: [4, 6].map((x) => ({
          route_type: "wire",
          x,
          y: 4,
          layer: "inner1",
          width: 0.1,
        })),
      },
    ],
  }
  const snapshot = structuredClone({ input, traces })
  expect(matchingGroupsSupportEnvelope(input, traces)).toBe(true)
  const outer: Trace = {
    ...traces[0],
    connection_name: "unmatched",
    route: traces[0].route.map((p) => ({
      ...p,
      x: p.x * 2 - 5,
      y: p.y * 2 - 2,
    })),
  }
  expect(matchingGroupsSupportEnvelope(input, [...traces, outer])).toBe(false)
  let result = traces,
    accepted = 0
  for (const proposal of compactMatchingGroups(input, traces, {
    smoothTuning: true,
  })) {
    if (!proposal) continue
    accepted++
    result = proposal
    const reports = busLengthReports(input, result)
    expect(
      reports.every(
        (r) => r.matched && r.aboveMinimumLength && r.withinLengthLimit,
      ),
    ).toBe(true)
    const validator = BusLanesSolver.forValidation(input, result, {
      smoothTuning: true,
    })
    validator.solve()
    expect(validator.solved).toBe(true)
  }
  expect(accepted).toBeGreaterThan(0)
  expect(signalEnvelope(result).areaMm2).toBeLessThan(
    signalEnvelope(traces).areaMm2 * 0.95,
  )
  for (let i = 0; i < traces.length; i++) {
    expect(result[i].route[0]).toEqual(traces[i].route[0])
    expect(result[i].route.at(-1)).toEqual(traces[i].route.at(-1))
  }
  expect({ input, traces }).toEqual(snapshot)
})

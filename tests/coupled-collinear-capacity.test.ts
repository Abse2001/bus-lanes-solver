import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { coalesceCoupledStraightSegments } from "../lib/coalesce-coupled-straight-segments"
import { length } from "../lib/geometry"
import { pairLengthReports, busLengthReports } from "../lib/route-lengths"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { tuneCoupledLengths } from "../lib/tune-coupled-lengths"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const wire = (x: number, y: number): Wire => ({
  x,
  y,
  layer: "top",
  width: 0.1,
  route_type: "wire",
})

test("collinear subdivisions do not consume a physically continuous paired tuning bank", () => {
  const traces: Trace[] = [-0.11, 0.11].map((y, rail) => ({
    type: "pcb_trace",
    pcb_trace_id: `pair-${rail}`,
    connection_name: `rail-${rail}`,
    coupledSection: [0, 8],
    route: Array.from({ length: 9 }, (_, index) => wire(-2 + index * 0.5, y)),
  }))
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    bounds: { minX: -5, maxX: 5, minY: -4, maxY: 4 },
    obstacles: [],
    connections: [
      ...traces.map((trace) => ({
        name: trace.connection_name!,
        pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
      })),
      { name: "power", pointsToConnect: [wire(-4, -3), wire(4, -3)] },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "immutable-power",
        connection_name: "power",
        route: [wire(-4, -3), wire(4, -3)],
      },
    ],
    buses: [
      {
        busId: "matched",
        connectionNames: ["rail-0", "rail-1"],
        minLength: 6,
        maxLengthSkew: 0.127,
      },
    ],
    differentialPairs: [
      {
        connectionNames: ["rail-0", "rail-1"],
        lengthTolerance: 0.127,
        traceGap: 0.12,
      },
    ],
  }
  const before = structuredClone({ input, traces }),
    tuned = tuneCoupledLengths(input, traces, {
      packMeanders: true,
      maxCandidates: 4096,
    })
  expect(tuned.every((trace) => length(trace.route) >= 6 - 1e-6)).toBe(true)
  expect(
    busLengthReports(input, tuned).every(
      (report) => report.matched && report.aboveMinimumLength,
    ),
  ).toBe(true)
  expect(
    pairLengthReports(input, tuned).every((report) => report.matched),
  ).toBe(true)
  expect(
    sharedPairSpacingReports(input, tuned).every((report) => report.matched),
  ).toBe(true)
  expect(routeAnglesAreConventional(tuned)).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [...input.traces!, ...tuned] },
      clearance: 0.05,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect({ input, traces }).toEqual(before)
})

test("normalization preserves shared handoffs, curve tangents, outside vertices and annotation indices", () => {
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "annotated",
    connection_name: "rail",
    route: Array.from({ length: 8 }, (_, index) => wire(index - 1, 0)),
    coupledSection: [1, 5],
    curvedSegments: [4, 7],
  }
  const before = structuredClone(trace),
    [normalized] = coalesceCoupledStraightSegments([trace])
  expect(normalized.route.map((point) => point.x)).toEqual([
    -1, 0, 2, 3, 4, 5, 6,
  ])
  expect(normalized.coupledSection).toEqual([1, 4])
  expect(normalized.curvedSegments).toEqual([3, 6])
  expect(normalized.route[normalized.coupledSection![0]]).toEqual(
    trace.route[1],
  )
  expect(normalized.route[normalized.coupledSection![1]]).toEqual(
    trace.route[5],
  )
  expect(length(normalized.route)).toBe(length(trace.route))
  expect(trace).toEqual(before)
})

test("normalization retains real bends, returning segments, layer handoffs and width changes", () => {
  const routes: Trace["route"][] = [
    [wire(0, 0), wire(1, 0.001), wire(2, 0)],
    [wire(0, 0), wire(1, 0), wire(0, 0)],
    [wire(0, 0), { ...wire(1, 0), layer: "bottom" }, wire(2, 0)],
    [wire(0, 0), { ...wire(1, 0), width: 0.11 }, wire(2, 0)],
    [
      wire(0, 0),
      {
        x: 1,
        y: 0,
        route_type: "via",
        from_layer: "top",
        to_layer: "bottom",
      },
      wire(2, 0),
    ],
  ]
  for (const route of routes) {
    const trace: Trace = {
      type: "pcb_trace",
      pcb_trace_id: "protected",
      route,
      coupledSection: [0, 2],
    }
    expect(coalesceCoupledStraightSegments([trace])[0]).toBe(trace)
  }
})

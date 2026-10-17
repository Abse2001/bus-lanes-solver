import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { offsetPath } from "../lib/coupled-pair-routing"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { routeSurfaceTimingBankRetry } from "../lib/route-surface-timing-bank-retry"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

test("a computed bus demand reserves common paired banks, restores native constraints, and accepts full copper matching", () => {
  const center = [
      { x: -4, y: 4 },
      { x: 0, y: 0 },
    ],
    make = (
      name: string,
      points: Array<{ x: number; y: number }>,
      pair = false,
    ): Trace => ({
      type: "pcb_trace",
      pcb_trace_id: name,
      source_trace_id: name,
      connection_name: name,
      route: points.map(
        (point): Wire => ({
          ...point,
          width: 0.1,
          layer: "top",
          route_type: "wire",
        }),
      ),
      ...(pair
        ? { coupledSection: [0, points.length - 1] as [number, number] }
        : {}),
    }),
    retained = [
      make("P", offsetPath(center, 0.15), true),
      make("N", offsetPath(center, -0.15), true),
    ],
    ordinary = make("A", [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 4 },
      { x: 10, y: 4 },
    ]),
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.05,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      bounds: { minX: -30, maxX: 30, minY: -30, maxY: 30 },
      obstacles: [],
      connections: [...retained, ordinary].map((trace) => ({
        name: trace.connection_name!,
        pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
      })),
      buses: [
        { busId: "BYTE", connectionNames: ["P", "N", "A"], maxLengthSkew: 0.2 },
      ],
      differentialPairs: [
        { connectionNames: ["P", "N"], traceGap: 0.2, lengthTolerance: 0.05 },
      ],
    },
    state: FlexibleSignalState = {
      native,
      pending: native,
      retained,
      traces: [ordinary],
      escapes: [],
    },
    before = structuredClone(state)
  native.obstacles = native.connections.flatMap((connection, index) =>
    connection.pointsToConnect.map((point, end) => ({
      type: "rect" as const,
      center: { x: point.x, y: point.y },
      width: 0.12,
      height: 0.12,
      layers: ["top"],
      componentId: index < 2 ? `pair_package_${end}` : `control_${end}`,
      connectedTo: [connection.name],
    })),
  )
  before.native.obstacles = structuredClone(native.obstacles)
  before.pending.obstacles = before.native.obstacles
  let checkpoints = 0
  const work = routeSurfaceTimingBankRetry(
    state,
    { smoothTuning: true, denseSearch: true },
    {
      maxRounds: 5,
      maxExpansions: 20000,
      maxInitialExpansions: 20000,
      maxClosureExpansions: 20000,
    },
    (checkpoint) => {
      checkpoints++
      expect(checkpoint.native).toBe(native)
      expect(checkpoint.pending.buses).toEqual(native.buses)
    },
  )
  let next = work.next(),
    steps = 0
  while (!next.done && steps++ < 200000) next = work.next()
  expect(next.done).toBe(true)
  expect(checkpoints).toBe(1)
  const result = next.value!
  expect(result).toBeTruthy()
  expect(result.native).toBe(native)
  expect(result.pending.buses).toEqual(native.buses)
  expect(result.pending.buses![0].maxLength).toBeUndefined()
  const all = [...result.retained, ...result.traces].map((trace) =>
      joinSignalEscapes(
        trace,
        result.escapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      ),
    ),
    reportInput = { ...native, traces: result.escapes }
  expect(all).toHaveLength(3)
  expect(
    busLengthReports(reportInput, [...result.retained, ...result.traces])[0]
      .matched,
  ).toBe(true)
  expect(
    pairLengthReports(reportInput, [...result.retained, ...result.traces])[0]
      .matched,
  ).toBe(true)
  const drc = validateRoutedCopperDrc({
    inputSrj: native,
    routedSrj: { ...native, traces: all },
    clearance: 0.05,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.issues).toEqual([])
  expect(state).toEqual(before)
})

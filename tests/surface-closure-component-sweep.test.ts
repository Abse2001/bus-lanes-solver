import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { negotiateSurfaceRoutes } from "../lib/negotiate-surface-routes"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

test("a blocked first conflict component does not prevent a later independent physical repair", () => {
  const wire = (x: number, y: number): Wire => ({
      x,
      y,
      layer: "top",
      width: 0.1,
      route_type: "wire",
    }),
    connections = [
      { name: "locked_h", pointsToConnect: [wire(-3, 0), wire(-1, 0)] },
      { name: "locked_v", pointsToConnect: [wire(-2, -1), wire(-2, 1)] },
      { name: "free_h", pointsToConnect: [wire(1, 0), wire(3, 0)] },
      { name: "free_v", pointsToConnect: [wire(2, -1), wire(2, 1)] },
    ],
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.05,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.15,
      bounds: { minX: -4, maxX: 4, minY: -2, maxY: 2 },
      obstacles: [],
      connections,
      buses: [
        {
          busId: "locked",
          connectionNames: ["locked_h", "locked_v"],
          allowedLayers: ["top"],
          maxLength: 2,
        },
      ],
    },
    traces: Trace[] = connections.map((connection) => ({
      type: "pcb_trace",
      pcb_trace_id: connection.name,
      connection_name: connection.name,
      route: connection.pointsToConnect,
    })),
    state: FlexibleSignalState = {
      native,
      pending: native,
      retained: [],
      escapes: [],
      traces,
    },
    before = structuredClone(state),
    checkpoints: Array<{ state: FlexibleSignalState; conflicts: number }> = [],
    closureNames: string[] = [],
    search = negotiateSurfaceRoutes(native, state, {
      maxRounds: 0,
      maxClosureSize: 2,
      maxClosureNeighbors: 0,
      maxUntimedVias: 2,
      maxClosureExpansions: 20000,
      onProgress: (p) => {
        if (p.stage === "closure") closureNames.push(p.connectionName)
      },
      onProvisionalCheckpoint: (state, conflicts) =>
        checkpoints.push({ state, conflicts }),
    })
  let result = search.next(),
    work = 0
  while (!result.done && ++work < 50000) result = search.next()
  if (!result.done) search.return(null)
  expect(result.done).toBe(true)
  expect(result.value).toBeNull()
  expect(state).toEqual(before)
  expect(closureNames).toContain("free_h")
  expect(checkpoints.map((value) => value.conflicts)).toEqual([2, 1])
  const repaired = checkpoints.at(-1)!.state,
    freeInput = { ...native, connections: connections.slice(2), buses: [] },
    freeRoutes = repaired.traces
      .filter((trace) => trace.connection_name!.startsWith("free_"))
      .map((trace) =>
        joinSignalEscapes(
          trace,
          repaired.escapes.filter(
            (escape) => escape.connection_name === trace.connection_name,
          ),
        ),
      )
  expect(
    validateRoutedCopperDrc({
      inputSrj: freeInput,
      routedSrj: { ...freeInput, traces: freeRoutes },
      clearance: 0.05,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
}, 30000)

test("atomic and partial-domain repairs clear a native-approach cycle within their candidate budgets", () => {
  const wire = (x: number, y: number): Wire => ({
      x,
      y,
      layer: "top",
      width: 0.1,
      route_type: "wire",
    }),
    coordinates = [-1.5, -0.5, 0.5, 1.5],
    connections = coordinates.map((x, index) => ({
      name: `signal_${index}`,
      pointsToConnect: [wire(x, -1), wire(x, 1)],
    })),
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.05,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.15,
      bounds: { minX: -2.5, maxX: 2.5, minY: -2, maxY: 2 },
      obstacles: [],
      connections,
    },
    traces: Trace[] = connections.map((connection, index) => ({
      type: "pcb_trace",
      pcb_trace_id: connection.name,
      connection_name: connection.name,
      // Each old approach blocks the next signal's native attachment. No
      // proper subset of this dependency cycle can move while the rest is hard.
      route:
        index < 3
          ? [
              connection.pointsToConnect[0],
              connections[index + 1].pointsToConnect[0],
              wire(coordinates[index], 0),
              connection.pointsToConnect[1],
            ]
          : [
              connection.pointsToConnect[0],
              connections[0].pointsToConnect[0],
              wire(-1.5, 0),
              wire(1.5, 0),
              connection.pointsToConnect[1],
            ],
    })),
    state: FlexibleSignalState = {
      native,
      pending: native,
      retained: [],
      escapes: [],
      traces,
    },
    before = structuredClone(state),
    settings = {
      maxRounds: 0,
      maxClosureNeighbors: 0,
      maxClosureFragments: 4,
      maxCandidateSearchNodes: 0,
      maxUntimedVias: 2,
      maxClosureExpansions: 10000,
    },
    finish = (maximum: number, maxDomainCandidates = 1) => {
      const search = negotiateSurfaceRoutes(native, state, {
        ...settings,
        maxClosureSize: maximum,
        maxDomainCandidates,
      })
      let result = search.next(),
        work = 0
      while (!result.done && ++work < 50000) result = search.next()
      if (!result.done) search.return(null)
      expect(result.done).toBe(true)
      return result.value
    }
  expect(finish(3)).toBeNull()
  // With room for only the old candidate, all four must move atomically.
  // A larger domain can instead retain useful candidates from failed triples
  // and make strict partial progress without global CSP backtracking.
  for (const result of [finish(4), finish(3, 24)]) {
    expect(result).toBeTruthy()
    expect(state).toEqual(before)
    const joined = result!.traces.map((trace) =>
      joinSignalEscapes(
        trace,
        result!.escapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      ),
    )
    expect(
      validateRoutedCopperDrc({
        inputSrj: native,
        routedSrj: { ...native, traces: joined },
        clearance: 0.05,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
  }
}, 30000)

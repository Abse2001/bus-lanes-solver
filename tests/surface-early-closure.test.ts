import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import {
  negotiateSurfaceRoutes,
  type SurfaceNegotiationOptions,
  type SurfaceNegotiationProgress,
} from "../lib/negotiate-surface-routes"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const wire = (x: number, y: number): Wire => ({
  x,
  y,
  route_type: "wire",
  layer: "top",
  width: 0.12,
})

function crossingState(locked = false): FlexibleSignalState {
  const connections = locked
      ? [
          { name: "a", pointsToConnect: [wire(-2, -0.5), wire(2, 0.5)] },
          { name: "b", pointsToConnect: [wire(-2, 0.5), wire(2, -0.5)] },
        ]
      : [
          { name: "a", pointsToConnect: [wire(-2, 0), wire(2, 0)] },
          { name: "b", pointsToConnect: [wire(0, -1), wire(0, 1)] },
        ],
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.12,
      minTraceToPadEdgeClearance: 0.08,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minBoardEdgeClearance: 0,
      bounds: locked
        ? { minX: -2.06, maxX: 2.06, minY: -0.9, maxY: 0.9 }
        : { minX: -3, maxX: 3, minY: -2, maxY: 2 },
      connections,
      buses: locked
        ? []
        : [
            {
              busId: "two_via_controls",
              connectionNames: ["a", "b"],
              maxLength: 12,
            },
          ],
      obstacles: [
        ...connections.flatMap((connection) =>
          connection.pointsToConnect.map((point) => ({
            center: { x: point.x, y: point.y },
            width: 0.12,
            height: 0.12,
            layers: ["top"],
            connectedTo: [connection.name],
          })),
        ),
        ...(locked
          ? [
              {
                // Full-stack barrels cannot cross this physical inner-plane
                // keepout. Alternating terminals on the board boundary also
                // prevent both crossing nets sharing their native surface.
                center: { x: 0, y: 0 },
                width: 4.12,
                height: 1.8,
                layers: ["inner1"],
                connectedTo: [],
              },
            ]
          : []),
      ],
    },
    traces: Trace[] = connections.map((connection, side) => ({
      type: "pcb_trace",
      pcb_trace_id: connection.name,
      connection_name: connection.name,
      route: locked
        ? [
            connection.pointsToConnect[0],
            wire(-0.5, side ? 0.5 : -0.5),
            wire(0.5, side ? -0.5 : 0.5),
            connection.pointsToConnect[1],
          ]
        : connection.pointsToConnect,
    }))
  return { native, pending: native, retained: [], escapes: [], traces }
}

function run(
  state: FlexibleSignalState,
  options: SurfaceNegotiationOptions = {},
) {
  const progress: SurfaceNegotiationProgress[] = [],
    conflicts: number[] = [],
    states: FlexibleSignalState[] = []
  let finalFallback = false
  const work = negotiateSurfaceRoutes(state.native, state, {
    congestionHistory: true,
    maxRounds: 6,
    // Ordinary reroutes have no expansion budget. Observe and cancel the
    // final fallback so this harness measures only the early repair phase.
    maxExpansions: 0,
    maxInitialExpansions: 0,
    maxInitialSoftExpansions: 0,
    maxClosureExpansions: 25000,
    maxClosureSize: 2,
    maxClosureNeighbors: 0,
    endpointViaAttachments: false,
    criticalGridOrigins: false,
    onProgress: (value) => {
      progress.push(value)
      if (value.stage === "closure" && value.round === 0) finalFallback = true
    },
    onProvisionalCheckpoint: (value, count) => {
      conflicts.push(count)
      states.push(value)
    },
    ...options,
  })
  let next = work.next(),
    steps = 0
  try {
    while (!next.done && !finalFallback && ++steps < 50000) next = work.next()
    expect(next.done || finalFallback).toBe(true)
    return {
      result: finalFallback ? null : next.value,
      progress,
      conflicts,
      states,
    }
  } finally {
    if (!next.done) work.return(null)
  }
}

test("a stagnant surface sweep invokes a bounded atomic repair before the final fallback", () => {
  const state = crossingState(),
    before = structuredClone(state),
    disabled = run(state, { earlyClosure: false }),
    noBudget = run(state, { maxClosureExpansions: 0 }),
    enabled = run(state)
  expect(disabled.result).toBeNull()
  expect(noBudget.result).toBeNull()
  expect(noBudget.conflicts).toEqual([1])
  expect(enabled.result).toBeTruthy()
  expect(state).toEqual(before)
  const early = enabled.progress.find(
    (value) => value.stage === "closure" && value.round > 0,
  )!
  expect(early.round).toBe(state.native.connections.length)
  expect(enabled.progress.at(-1)).toMatchObject({
    stage: "complete",
    round: early.round,
    conflicts: 0,
  })
  expect(enabled.conflicts).toEqual([1, 0])
  const traces = enabled.result!.traces.map((trace) =>
    joinSignalEscapes(
      trace,
      enabled.result!.escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
  for (const trace of traces) {
    const connection = state.native.connections.find(
      (value) => value.name === trace.connection_name,
    )!
    expect(trace.route[0]).toMatchObject(connection.pointsToConnect[0])
    expect(trace.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: state.native,
      routedSrj: { ...state.native, traces },
      clearance: 0.08,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
}, 15000)

test("a failed early repair preserves the assignment and resumes negotiated history", () => {
  const state = crossingState(true),
    before = structuredClone(state),
    outcome = run(state, { maxRounds: 4 }),
    earlyIndex = outcome.progress.findIndex(
      (value) => value.stage === "closure" && value.round > 0,
    ),
    earlyRound = outcome.progress[earlyIndex].round
  expect(outcome.result).toBeNull()
  expect(state).toEqual(before)
  expect(earlyRound).toBe(2)
  expect(
    outcome.progress
      .slice(earlyIndex + 1)
      .some(
        (value) => value.stage === "negotiate" && value.round >= earlyRound,
      ),
  ).toBe(true)
  expect(outcome.conflicts).toEqual([1])
}, 15000)

test("default early repair remains reachable after a large sweep without congestion history", () => {
  const state = crossingState()
  for (let index = 0; index < 34; index++) {
    const name = `independent_${index}`,
      x = 4 + (index % 7),
      y = -1.5 + Math.floor(index / 7) * 0.5,
      route = [wire(x, y), wire(x + 0.4, y)]
    state.native.connections.push({ name, pointsToConnect: route })
    state.traces.push({
      type: "pcb_trace",
      pcb_trace_id: name,
      connection_name: name,
      route,
    })
  }
  state.native.bounds.maxX = 12
  const before = structuredClone(state),
    outcome = run(state, { congestionHistory: false, maxRounds: 40 }),
    early = outcome.progress.find(
      (value) => value.stage === "closure" && value.round > 0,
    )!
  expect(outcome.result).toBeTruthy()
  expect(early.round).toBe(36)
  expect(outcome.result!.traces).toHaveLength(36)
  expect(state).toEqual(before)
}, 15000)

test("sparse components are repaired fairly while ordinary progress postpones stagnation", () => {
  const groups = [
      { name: "locked", x: -2, span: 1 },
      { name: "easy", x: 2, span: 0.3 },
      { name: "free_0", x: 6, span: 2 },
      { name: "free_1", x: 11, span: 2 },
      { name: "free_2", x: 16, span: 2 },
    ],
    connections = groups.flatMap(({ name, x, span }) => [
      {
        name: `${name}_h`,
        pointsToConnect: [
          wire(x - span, name === "easy" ? -0.7 : 0),
          wire(x + span, name === "easy" ? -0.7 : 0),
        ],
      },
      { name: `${name}_v`, pointsToConnect: [wire(x, -span), wire(x, span)] },
    ]),
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.12,
      minTraceToPadEdgeClearance: 0.08,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      bounds: { minX: -4, maxX: 19, minY: -3, maxY: 3 },
      connections,
      obstacles: connections.flatMap((connection) =>
        connection.pointsToConnect.map((point) => ({
          center: point,
          width: 0.12,
          height: 0.12,
          layers: ["top"],
          connectedTo: [connection.name],
        })),
      ),
      buses: [
        {
          busId: "locked",
          connectionNames: ["locked_h", "locked_v"],
          allowedLayers: ["top"],
          maxLength: 2,
        },
      ],
    },
    state: FlexibleSignalState = {
      native,
      pending: native,
      retained: [],
      escapes: [],
      traces: connections.map((connection) => ({
        type: "pcb_trace",
        pcb_trace_id: connection.name,
        connection_name: connection.name,
        route:
          connection.name === "easy_h"
            ? [
                connection.pointsToConnect[0],
                wire(1.7, 0),
                wire(2.3, 0),
                connection.pointsToConnect[1],
              ]
            : connection.pointsToConnect,
      })),
    },
    before = structuredClone(state),
    outcome = run(state, {
      maxRounds: 14,
      maxExpansions: 20,
      surfaceGridStep: 0.1,
      heuristicWeight: 4,
      hardNeighborRouting: true,
    }),
    firstEarly = outcome.progress.findIndex(
      (value) => value.stage === "closure" && value.round > 0,
    ),
    early = outcome.progress
      .slice(firstEarly)
      .filter((value) => value.stage === "closure" && value.round > 0),
    previousGain = outcome.progress
      .slice(0, firstEarly)
      .find((value) => value.conflicts < 5)!
  expect(state).toEqual(before)
  expect(outcome.result).toBeNull()
  expect(previousGain.round).toBeGreaterThan(0)
  expect(early[0].round).toBe(connections.length)
  expect(early[0].round - previousGain.round).toBeLessThan(connections.length)
  // The third proposal in the first probe was never entered after free_0's
  // gain. It must stay unmarked and receive the next turn ahead of free_2.
  expect(early.slice(0, 4).map((value) => value.connectionName)).toEqual([
    "locked_h",
    "free_0_h",
    "free_1_h",
    "free_2_h",
  ])
  expect(outcome.conflicts.at(-1)).toBe(1)
  const repaired = outcome.states.at(-1)!,
    freeInput = {
      ...native,
      connections: connections.filter(
        (connection) => !connection.name.startsWith("locked"),
      ),
      buses: [],
    },
    traces = repaired.traces
      .filter((trace) => !trace.connection_name!.startsWith("locked"))
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
      routedSrj: { ...freeInput, traces },
      clearance: 0.08,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
}, 15000)

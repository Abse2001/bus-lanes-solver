import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { surfaceBridgeSelfShorts } from "../lib/route-surface-bridge"
import { routeSurfaceShortcutClosure } from "../lib/route-surface-shortcut-closure"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const wire = (x: number, y: number): Wire => ({
  route_type: "wire",
  x,
  y,
  width: 0.1,
  layer: "top",
})
const trace = (name: string, points: number[][]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  source_trace_id: name,
  route: points.map(([x, y]) => wire(x, y)),
})

function fixture(): FlexibleSignalState {
  const traces = [
      trace("A", [
        [-2, 0],
        [-2, 2.4],
        [2, 2.4],
        [2, 0],
      ]),
      trace("B", [
        [0, -1.5],
        [0, 1.5],
      ]),
      trace("REFERENCE", [
        [-2, -3],
        [2, -3],
      ]),
    ],
    retained = [
      trace("P", [
        [-2, 3.2],
        [2, 3.2],
      ]),
      trace("N", [
        [-2, 3.5],
        [2, 3.5],
      ]),
    ],
    supplied = trace("SUPPLY", [
      [3, -2],
      [3, -1],
    ]),
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.05,
      minViaPadDiameter: 0.3,
      minViaHoleDiameter: 0.15,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.15,
      bounds: { minX: -4, maxX: 4, minY: -4, maxY: 4 },
      obstacles: [],
      traces: [supplied],
      connections: [...traces, ...retained, supplied].map((item) => ({
        name: item.connection_name!,
        source_trace_id: item.source_trace_id,
        pointsToConnect: [item.route[0], item.route.at(-1)!] as Wire[],
      })),
      buses: [
        {
          busId: "BYTE",
          connectionNames: ["A", "B", "REFERENCE"],
          maxLengthSkew: 0.1,
        },
      ],
      differentialPairs: [
        { connectionNames: ["P", "N"], traceGap: 0.2, lengthTolerance: 0.1 },
      ],
    }
  return { native, pending: native, retained, traces, escapes: [] }
}

function run(state: FlexibleSignalState, maxNeighbors = 2) {
  const search = routeSurfaceShortcutClosure(
    state,
    state.native.connections[0],
    4.25,
    {
      maxNeighbors,
      maxExpansions: 20000,
      maxVias: 2,
    },
  )
  let next = search.next(),
    steps = 0
  while (!next.done && steps++ < 100000) next = search.next()
  expect(next.done).toBe(true)
  return next.done ? next.value : null
}

test("a bus driver shortcut atomically moves its actual clear neighbor while paired and supplied copper stay hard", () => {
  const state = fixture(),
    before = structuredClone(state),
    result = run(state)!
  expect(result).toBeTruthy()
  expect([...result.keys()].sort()).toEqual(["A", "B"])
  const all = [...state.retained, ...state.traces].map((item) => {
    const replacement = result.get(item.connection_name!)
    return replacement
      ? joinSignalEscapes(replacement.carrier, replacement.escapes)
      : item
  })
  expect(
    length(all.find((item) => item.connection_name === "A")!.route),
  ).toBeLessThan(4.25)
  expect(
    length(all.find((item) => item.connection_name === "B")!.route),
  ).toBeLessThan(8.8 + 1e-7)
  const drc = validateRoutedCopperDrc({
    inputSrj: state.native,
    routedSrj: { ...state.native, traces: [...state.native.traces!, ...all] },
    clearance: 0.05,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.issues).toEqual([])
  for (const item of all) {
    const member = state.native.connections.find(
      (connection) => connection.name === item.connection_name,
    )!
    expect(item.route[0]).toEqual(member.pointsToConnect[0] as Wire)
    expect(item.route.at(-1)).toEqual(member.pointsToConnect[1] as Wire)
    expect(surfaceBridgeSelfShorts(state.native, member, item)).toBe(false)
    expect(
      item.route.every(
        (point) =>
          point.route_type !== "wire" ||
          ["top", "bottom"].includes(point.layer),
      ),
    ).toBe(true)
  }
  expect(all[0]).toBe(state.retained[0])
  expect(all[1]).toBe(state.retained[1])
  expect(state).toEqual(before)
})

test("a disabled or exhausted coordinated shortcut preserves its entire input", () => {
  const state = fixture(),
    before = structuredClone(state)
  expect(run(state, 0)).toBeNull()
  const work = routeSurfaceShortcutClosure(
    state,
    state.native.connections[0],
    4.25,
    {
      maxNeighbors: 2,
      maxExpansions: 0,
      maxVias: 4,
    },
  )
  expect(work.next()).toEqual({ done: true, value: null })
  const cancelled = routeSurfaceShortcutClosure(
    state,
    state.native.connections[0],
    4.25,
    {
      maxNeighbors: 2,
      maxExpansions: 20000,
      maxVias: 4,
    },
  )
  cancelled.next()
  cancelled.return(null)
  expect(state).toEqual(before)
})

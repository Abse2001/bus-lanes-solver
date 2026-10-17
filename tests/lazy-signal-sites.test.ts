import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import {
  negotiateSignalSites,
  type SignalSiteProgress,
} from "../lib/negotiate-signal-sites"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

/** The nearest two source via cells are physically legal but enclosed on the
 * carrier. Other cells remain reachable, while TOP cannot cross the board. */
function enclosedCells(closeEveryAdjacentCell = false): SimpleRouteJson {
  const fixed: Trace[] = []
  for (const x of closeEveryAdjacentCell ? [-0.4, 0.4] : [0.4])
    for (const y of [-0.4, 0.4]) {
      const corners = [
        { x: x - 0.28, y: y - 0.28 },
        { x: x + 0.28, y: y - 0.28 },
        { x: x + 0.28, y: y + 0.28 },
        { x: x - 0.28, y: y + 0.28 },
      ]
      fixed.push({
        type: "pcb_trace",
        pcb_trace_id: `closed_cell_${x}_${y}`,
        connection_name: `guard_${x}_${y}`,
        route: [...corners, corners[0]].map((point) => ({
          ...point,
          route_type: "wire",
          layer: "bottom",
          width: 0.05,
        })),
      })
    }
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.05,
    minBoardEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 6, minY: -2, maxY: 2 },
    connections: [
      {
        name: "A",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 4, y: 0, layer: "top" },
        ],
      },
    ],
    buses: [
      {
        busId: "A",
        connectionNames: ["A"],
        allowedLayers: ["bottom"],
        maxLength: 8,
      },
    ],
    traces: fixed,
    obstacles: [
      ...[0, 4].flatMap((x) =>
        [0, 0.8].flatMap((dx) =>
          [0, 0.8].map((y) => ({
            componentId: `package_${x}`,
            shape: "circle" as const,
            type: "rect",
            center: { x: x + dx, y },
            width: 0.25,
            height: 0.25,
            layers: ["top"],
            connectedTo:
              dx === 0 && y === 0 ? ["A"] : [`unused_${x}_${dx}_${y}`],
          })),
        ),
      ),
      {
        center: { x: 2, y: 0 },
        width: 0.2,
        height: 4,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
}

test("lazy site routing passes enclosed nearest cells and reaches the true pads through another cell", () => {
  const native = enclosedCells(),
    before = structuredClone(native),
    progress: SignalSiteProgress[] = []
  const pending = {
    ...native,
    connections: native.connections.map((connection) => ({
      ...connection,
      pointsToConnect: connection.pointsToConnect.map((point) => ({
        ...point,
        layer: "bottom",
      })),
    })),
  }
  const search = negotiateSignalSites(
    { native, pending, escapes: [], retained: [], traces: [] },
    new Set(["A"]),
    false,
    false,
    { allowExpandedSites: false, onProgress: (event) => progress.push(event) },
  )
  let next = search.next(),
    steps = 0
  try {
    while (!next.done && steps++ < 15000) next = search.next()
    expect(next.done).toBe(true)
    if (!next.done || !next.value) throw Error("Expected a reachable via cell")
    const result = next.value,
      carrier = result.traces[0]
    expect((carrier.route[0] as Wire).x).toBeLessThan(0)
    expect(
      progress.filter((event) => event.stage === "negotiate").length,
    ).toBeGreaterThan(1)
    expect(progress.at(-1)?.requestedSignals).toBe(1)
    const validator = BusLanesSolver.forValidation(
      result.pending,
      result.traces,
    )
    validator.solve()
    expect(validator.solved).toBe(true)
    const joined = joinSignalEscapes(carrier, result.escapes)
    expect(joined.route[0]).toMatchObject(
      native.connections[0].pointsToConnect[0],
    )
    expect(joined.route.at(-1)).toMatchObject(
      native.connections[0].pointsToConnect[1],
    )
    const physical = {
      ...native,
      connections: [
        ...native.connections,
        ...native.traces!.map((trace) => ({
          name: trace.connection_name!,
          pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
        })),
      ],
    }
    const drc = validateRoutedCopperDrc({
      inputSrj: physical,
      routedSrj: { ...physical, traces: [...native.traces!, joined] },
      clearance: native.minTraceToPadEdgeClearance,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
    expect(drc).toMatchObject({ valid: true })
    expect(native).toEqual(before)
  } finally {
    if (!next.done) search.return(null)
  }
})

test("all enclosed compact sites still trigger the default reachable expanded-site fallback", () => {
  const native = enclosedCells(true),
    before = structuredClone(native)
  const pending = {
    ...native,
    connections: native.connections.map((connection) => ({
      ...connection,
      pointsToConnect: connection.pointsToConnect.map((point) => ({
        ...point,
        layer: "bottom",
      })),
    })),
  }
  const search = negotiateSignalSites(
    { native, pending, escapes: [], retained: [], traces: [] },
    new Set(["A"]),
  )
  let next = search.next(),
    steps = 0
  try {
    while (!next.done && steps++ < 15000) next = search.next()
    expect(next.done).toBe(true)
    if (!next.done || !next.value) throw Error("Expected an expanded via cell")
    const result = next.value,
      start = result.traces[0].route[0]
    expect(Math.max(Math.abs(start.x), Math.abs(start.y))).toBeGreaterThan(0.6)
    const validator = BusLanesSolver.forValidation(
      result.pending,
      result.traces,
    )
    validator.solve()
    expect(validator.solved).toBe(true)
    const joined = joinSignalEscapes(result.traces[0], result.escapes)
    expect(joined.route[0]).toMatchObject(
      native.connections[0].pointsToConnect[0],
    )
    expect(joined.route.at(-1)).toMatchObject(
      native.connections[0].pointsToConnect[1],
    )
    expect(native).toEqual(before)
  } finally {
    if (!next.done) search.return(null)
  }
})

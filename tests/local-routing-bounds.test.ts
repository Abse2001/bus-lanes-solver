import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { localRoutingBounds } from "../lib/local-routing-bounds"
import { negotiateSignalSites } from "../lib/negotiate-signal-sites"
import type { SimpleRouteJson, Wire } from "../lib/types"

function input(): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minBoardEdgeClearance: 0.1,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    connections: [
      {
        name: "A",
        pointsToConnect: [
          { x: -1, y: 0, layer: "top" },
          { x: 1, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [
      {
        componentId: "remote_support",
        center: { x: 9, y: 9 },
        width: 0.1,
        height: 0.1,
        layers: ["top"],
        connectedTo: [],
      },
      {
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 6,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
}

test("local bounds exclude distant support copper and align with the board grid", () => {
  const native = input(),
    bounds = localRoutingBounds(native)
  expect(bounds).toEqual({ minX: -3, maxX: 3, minY: -2, maxY: 2 })
  expect(localRoutingBounds({ ...native, connections: [] })).toEqual(
    native.bounds,
  )
})

test("signal negotiation retries the full board when a wall leaves the local window", () => {
  const native = input(),
    original = structuredClone(native),
    search = negotiateSignalSites(
      { native, pending: native, escapes: [], retained: [], traces: [] },
      new Set(["A"]),
      false,
      false,
      { allowExpandedSites: false },
    )
  let next = search.next(),
    steps = 0
  try {
    while (!next.done && steps++ < 20000) next = search.next()
    expect(next.done).toBe(true)
    if (!next.done || !next.value) throw Error("Expected the full-board detour")
    const result = next.value,
      carrier = result.traces[0]
    expect(
      Math.max(...carrier.route.map((point) => Math.abs(point.y))),
    ).toBeGreaterThan(3)
    expect(carrier.route[0]).toMatchObject(
      native.connections[0].pointsToConnect[0],
    )
    expect(carrier.route.at(-1)).toMatchObject(
      native.connections[0].pointsToConnect[1],
    )
    expect(
      carrier.route.every((point) => (point as Wire).layer === "top"),
    ).toBe(true)
    const validator = BusLanesSolver.forValidation(
      result.pending,
      result.traces,
    )
    validator.solve()
    expect(validator.solved).toBe(true)
    expect(native).toEqual(original)
  } finally {
    if (!next.done) search.return(null)
  }
})

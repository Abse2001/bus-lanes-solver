import { expect, test } from "bun:test"
import { BusLanesPipelineSolver } from "../lib"
import type { SimpleRouteJson } from "../lib/types"

test("automatic dogbones apply only to unrouted component pads, never existing handoffs", () => {
  const base: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: 0, y: 2, layer: "inner1" },
          { x: 0, y: -2, layer: "inner1" },
        ],
      },
    ],
    buses: [
      { busId: "DATA", connectionNames: ["D"], preferredLayer: "bottom" },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed",
        connection_name: "D",
        route: [
          { route_type: "wire", x: 0, y: -3, layer: "inner1", width: 0.1 },
          { route_type: "wire", x: 0, y: -2, layer: "inner1", width: 0.1 },
        ],
      },
    ],
  }
  const before = structuredClone(base)
  const completed = new BusLanesPipelineSolver(base)
  completed.solve()
  expect(completed.error).toBeNull()
  expect(
    completed.traces
      .flatMap((t) => t.route)
      .every((p) => p.route_type === "wire" && p.layer === "inner1"),
  ).toBe(true)
  expect(completed.getOutput().traces[0]).toEqual(base.traces![0])
  expect(base).toEqual(before)

  const mixed = structuredClone(base)
  mixed.connections[0].pointsToConnect[0].layer = "top"
  for (let i = 0; i < 4; i++)
    mixed.obstacles.push({
      componentId: "U1",
      center: { x: (i % 2) * 0.8, y: 2 + Math.floor(i / 2) * 0.8 },
      width: 0.4,
      height: 0.4,
      shape: "circle",
      layers: ["top"],
      connectedTo: i === 0 ? ["D"] : [],
    })
  const escaped = new BusLanesPipelineSolver(mixed)
  escaped.solve()
  expect(escaped.error).toBeNull()
  expect(
    escaped.traces
      .flatMap((t) => t.route)
      .filter((p) => p.route_type === "via"),
  ).toHaveLength(1)
  expect(escaped.getOutput().traces[0]).toEqual(mixed.traces![0])

  mixed.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "already_routed_pad",
    connection_name: "D",
    route: [
      { route_type: "wire", x: 0, y: 2, layer: "top", width: 0.1 },
      { route_type: "wire", x: -1, y: 2, layer: "top", width: 0.1 },
    ],
  })
  const incompatible = new BusLanesPipelineSolver(mixed)
  incompatible.solve()
  expect(incompatible.failed).toBe(true)
  expect(incompatible.traces).toEqual([])
  expect(incompatible.error).toContain("handoffs cannot be dogboned again")
})

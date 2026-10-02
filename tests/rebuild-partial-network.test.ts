import { expect, test } from "bun:test"
import { rebuildPairedNetwork } from "../lib/rebuild-paired-network"
import type { PairedNetwork } from "../lib/paired-network"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("partial reconstruction requires explicit opt-in and never invents missing copper", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 10, minY: -1, maxY: 10 },
    obstacles: [],
    connections: ["routed", "missing"].map((name, i) => ({
      name,
      pointsToConnect: [
        { x: 0, y: i, layer: "top" },
        { x: 5, y: i, layer: "top" },
      ],
    })),
  }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "routed",
    connection_name: "routed",
    route: input.connections[0].pointsToConnect.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.1,
    })),
  }
  const network: PairedNetwork = {
    input,
    local: input,
    transforms: [],
    copper: [],
    widths: new Map(),
    layers: new Map(),
  }
  expect(rebuildPairedNetwork(network, [trace]).next()).toEqual({
    done: true,
    value: null,
  })
  expect(
    rebuildPairedNetwork(network, [trace], { allowPartial: true }).next(),
  ).toEqual({ done: true, value: [trace] })
})

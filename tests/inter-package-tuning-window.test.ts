import { expect, test } from "bun:test"
import { interPackageTuningWindow } from "../lib/inter-package-tuning-window"
import type { SimpleRouteJson, Trace } from "../lib/types"

function fixture() {
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    obstacles: [
      { componentId: "CPU", x: 0, port: "cpu_port" },
      { componentId: "RAM", x: 4, port: "ram_port" },
    ].map((pad) => ({
      type: "rect",
      shape: "circle",
      componentId: pad.componentId,
      center: { x: pad.x, y: 0 },
      width: 1,
      height: 1,
      layers: ["top"],
      connectedTo: ["native_source", "cpu_port", "ram_port"],
      circuitJsonMetadata: { pcb_port_id: pad.port },
    })),
    connections: [
      {
        name: "lane",
        source_trace_id: "native_source",
        pointsToConnect: [
          { x: 3, y: 0, layer: "inner1", pcb_port_id: "cpu_port" },
          { x: 4, y: 0, layer: "inner1", pcb_port_id: "ram_port" },
        ],
      },
    ],
  }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "lane",
    connection_name: "lane",
    source_trace_id: "native_source",
    // Real carriers need not copy native port metadata into every wire point.
    route: input.connections[0].pointsToConnect.map(({ x, y, layer }) => ({
      x,
      y,
      layer,
      route_type: "wire",
      width: 0.1,
    })),
  }
  return { input, trace }
}

test("a completed handoff retains its physical package when nearer the remote pad field", () => {
  const { input, trace } = fixture()
  const before = structuredClone({ input, trace })
  const window = interPackageTuningWindow(input, [trace], (p) => p.x, 0.1)
  expect(window.start).toBeCloseTo(0.6, 10)
  expect(window.end).toBeCloseTo(3.4, 10)
  expect({ input, trace }).toEqual(before)
})

test("physical ownership follows reversed route endpoints instead of connection order", () => {
  const { input, trace } = fixture()
  const reversed = { ...trace, route: trace.route.toReversed() }
  const window = interPackageTuningWindow(input, [reversed], (p) => -p.x, 0.1)
  expect(window.start).toBeCloseTo(-3.4, 10)
  expect(window.end).toBeCloseTo(-0.6, 10)
})

test("native terminal ownership takes precedence over a stale emitted wire annotation", () => {
  const { input, trace } = fixture()
  Object.assign(trace.route[0], { pcb_port_id: "ram_port" })
  const window = interPackageTuningWindow(input, [trace], (p) => p.x, 0.1)
  expect(window.start).toBeCloseTo(0.6, 10)
  expect(window.end).toBeCloseTo(3.4, 10)
})

test("legacy terminals without native ports use source aliases to find their pad fields", () => {
  const { input, trace } = fixture()
  for (const point of input.connections[0].pointsToConnect)
    delete point.pcb_port_id
  input.connections[0].pointsToConnect[0].x = trace.route[0].x = 0
  const window = interPackageTuningWindow(input, [trace], (p) => p.x, 0.1)
  expect(window.start).toBeCloseTo(0.6, 10)
  expect(window.end).toBeCloseTo(3.4, 10)
})

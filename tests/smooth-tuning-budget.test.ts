import { expect, test } from "bun:test"
import { length } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { tuneSmoothLengths } from "../lib/smooth-length-tuning"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function pockets(count: number) {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -1, maxX: 11, minY: -1, maxY: count * 8 },
    connections: [],
    obstacles: [],
  }
  const traces: Trace[] = []
  const targets = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const name = `lane${i}`,
      y = i * 8
    const route: Wire[] = [0, 10].map((x) => ({
      x,
      y,
      route_type: "wire",
      layer: "top",
      width: 0.1,
    }))
    traces.push({
      type: "pcb_trace",
      pcb_trace_id: name,
      connection_name: name,
      route,
    })
    input.connections.push({ name, pointsToConnect: route })
    targets.set(name, 18)
    input.obstacles.push(
      {
        center: { x: 5, y: y - 0.4 },
        width: 12,
        height: 0.5,
        layers: ["top"],
        connectedTo: [],
      },
      {
        center: { x: 5, y: y + 1.4 },
        width: 12,
        height: 1,
        layers: ["top"],
        connectedTo: [],
      },
      {
        center: { x: 7, y: y + 2 },
        width: 6,
        height: 3.5,
        layers: ["top"],
        connectedTo: [],
      },
    )
  }
  return { input, traces, targets }
}

test("independent folded pockets do not consume later lanes' candidate budgets", () => {
  const { input, traces, targets } = pockets(12)
  const before = structuredClone({ input, traces })
  const result = tuneSmoothLengths(input, traces, targets, {
    packMeanders: true,
    maxCandidates: 16,
  })
  const copper = [...fixedCopper(input), ...result.flatMap(routeCopper)]
  expect(result).toHaveLength(12)
  for (const [i, trace] of result.entries()) {
    expect(length(trace.route)).toBeCloseTo(18, 7)
    expect(tuningPathIsSelfClear(trace.route, 0.175)).toBe(true)
    expect(
      new VectorScene(input, input.connections[i], 0.1, copper).pathVisible(
        trace.route,
      ),
    ).toBe(true)
  }
  expect({ input, traces }).toEqual(before)
})

test("folded fallback preserves a completed small ordinary correction", () => {
  const { input, traces, targets } = pockets(2)
  // The first lane has room for a small ordinary bump. A folded cell cannot
  // reproduce such a small deficit, so resetting this completed lane loses it.
  input.obstacles = input.obstacles.slice(3)
  targets.set("lane0", 10.1)
  const result = tuneSmoothLengths(input, traces, targets, {
    packMeanders: true,
    maxCandidates: 4096,
  })
  expect(length(result[0].route)).toBeCloseTo(10.1, 7)
  expect(length(result[1].route)).toBeCloseTo(18, 7)
})

import { expect, test } from "bun:test"
import { routeCoupledPair } from "../lib/coupled-pair-routing"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("paired retries explore distinct package-derived handoffs without moving terminals", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -3, maxX: 13, minY: -4, maxY: 5 },
    connections: Array.from({ length: 3 }, (_, i) => ({
      name: `D${i}`,
      pointsToConnect: [
        { x: 0, y: i * 0.8, layer: "bottom" },
        { x: 10, y: i * 0.8, layer: "bottom" },
      ],
    })),
    obstacles: [0, 10].flatMap((x) =>
      Array.from({ length: 3 }, (_, i) => ({
        type: "rect" as const,
        shape: "circle" as const,
        componentId: `U${x}`,
        center: { x, y: i * 0.8 },
        width: 0.3,
        height: 0.3,
        layers: ["top", "bottom"],
        connectedTo: [`D${i}`],
      })),
    ),
    buses: [
      {
        busId: "DATA",
        connectionNames: ["D0", "D1", "D2"],
        maxLengthSkew: 0.5,
      },
    ],
    differentialPairs: [
      { connectionNames: ["D0", "D1"], traceGap: 0.1, lengthTolerance: 0.1 },
    ],
  }
  const fixed = fixedCopper(input)
  const results: Trace[][] = []
  for (const variant of [0, 1]) {
    const generator = routeCoupledPair(
      input,
      input.differentialPairs![0],
      fixed,
      { copper: [], penalty: 10, variant },
    )
    let step = generator.next(),
      count = 0
    while (!step.done && count++ < 8000) step = generator.next()
    expect(step.done).toBe(true)
    expect(step.value).not.toBeNull()
    const traces = step.value as Trace[]
    results.push(traces)
    for (const [i, trace] of traces.entries()) {
      expect(trace.route[0]).toMatchObject(
        input.connections[i].pointsToConnect[0],
      )
      expect(trace.route.at(-1)).toMatchObject(
        input.connections[i].pointsToConnect[1],
      )
      expect(
        new VectorScene(input, input.connections[i], 0.1, [
          ...fixed,
          ...traces.flatMap(routeCopper),
        ]).pathVisible(trace.route),
      ).toBe(true)
      expect(trace.coupledSection).toBeDefined()
    }
  }
  expect(results[0].map((t) => t.route)).not.toEqual(
    results[1].map((t) => t.route),
  )
})

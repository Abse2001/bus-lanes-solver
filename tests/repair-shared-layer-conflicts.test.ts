import { expect, test } from "bun:test"
import { repairSharedLayerConflicts } from "../lib/repair-shared-layer-conflicts"
import { VectorScene, fixedCopper, routeCopper } from "../lib/vector-scene"
import { length } from "../lib/geometry"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"
const input: SimpleRouteJson = {
  layerCount: 4,
  bounds: { minX: -6, maxX: 6, minY: -6, maxY: 6 },
  minTraceWidth: 0.1,
  defaultObstacleMargin: 0.1,
  obstacles: [],
  connections: [
    {
      name: "A",
      pointsToConnect: [
        { x: -4, y: 0, layer: "inner1" },
        { x: 4, y: 0, layer: "inner1" },
      ],
    },
    {
      name: "B",
      pointsToConnect: [
        { x: 0, y: -4, layer: "inner1" },
        { x: 0, y: 4, layer: "inner1" },
      ],
    },
  ],
  buses: [{ busId: "bus", connectionNames: ["A", "B"], maxLength: 8.5 }],
}
const line = (name: string): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  route: input.connections
    .find((c) => c.name === name)!
    .pointsToConnect.map((p) => ({ ...p, route_type: "wire", width: 0.1 })),
})
function run(initial: Trace[], source = input, targets?: Map<string, number>) {
  const generator = repairSharedLayerConflicts(
    source,
    initial,
    new Map(source.connections.map((c) => [c.name, ["inner1", "inner2"]])),
    { maxNodes: 50, lengthTargets: targets },
  )
  let s = generator.next(),
    steps = 0
  while (!s.done && steps++ < 50000) s = generator.next()
  generator.return(null)
  expect(s.done).toBe(true)
  return s.value as Trace[] | null
}
test("joint repair changes carrier layers to resolve a crossing within absolute bounds", () => {
  const before = JSON.stringify(input),
    result = run([line("A"), line("B")])!
  expect(result).toHaveLength(2)
  expect(JSON.stringify(input)).toBe(before)
  for (const t of result) {
    expect(length(t.route)).toBeLessThanOrEqual(8.5 + 1e-7)
    const original = input.connections.find(
        (c) => c.name === t.connection_name,
      )!,
      connection = {
        ...original,
        pointsToConnect: [t.route[0] as Wire, t.route.at(-1)! as Wire],
      }
    expect(
      new VectorScene(input, connection, 0.1, [
        ...fixedCopper(input),
        ...result.filter((o) => o !== t).flatMap(routeCopper),
      ]).pathVisible(t.route),
    ).toBe(true)
  }
})
test("joint repair rejects overlength seed copper instead of accepting zero pairwise conflicts", () => {
  const source = {
    ...input,
    connections: [input.connections[0]],
    buses: [{ busId: "bus", connectionNames: ["A"], maxLength: 7.5 }],
  }
  expect(run([line("A")], source)).toBeNull()
})
test("joint repair tunes replacement routes to the supplied total copper target", () => {
  const source = {
    ...input,
    connections: [input.connections[0]],
    buses: [{ busId: "bus", connectionNames: ["A"], maxLength: 8.5 }],
  }
  const result = run([line("A")], source, new Map([["A", 8.4]]))!
  expect(result).toHaveLength(1)
  expect(length(result[0].route)).toBeCloseTo(8.4, 6)
})

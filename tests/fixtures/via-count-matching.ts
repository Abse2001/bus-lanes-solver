import type { SimpleRouteJson, Trace, Via, Wire } from "../../lib/types"

export const physicalLayers = ["top", "inner1", "inner2", "bottom"]
export interface Fixture {
  counts: [number, number]
  kind: "bus" | "pair"
  native: SimpleRouteJson
  input: SimpleRouteJson
  carriers: Trace[]
}
const wire = (x: number, y: number, layer = "top"): Wire => ({
  x,
  y,
  layer,
  route_type: "wire",
  width: 0.1,
})
const via = (x: number, y: number, from: string, to: string): Via => ({
  x,
  y,
  route_type: "via",
  from_layer: from,
  to_layer: to,
  layers: [...physicalLayers],
  via_diameter: 0.3,
  via_hole_diameter: 0.15,
})
const trace = (name: string, id: string, route: Trace["route"]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: id,
  connection_name: name,
  source_trace_id: `source_${name}`,
  route,
})

/** All carriers stay Top. Fixed fragments count actual barrels, independently
 * of carrier layer, with equal ten-mm native-to-native planar copper totals. */
export function fixture(
  counts: [number, number],
  kind: "bus" | "pair" = "bus",
): Fixture {
  if (!counts.every((count) => [0, 2, 4].includes(count)))
    throw Error("fixture count")
  const ys = kind === "pair" ? [0, 0.7] : [-1, 1]
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    minBoardEdgeClearance: 0.1,
    allowBlindAndBuriedVias: false,
    bounds: { minX: -6, maxX: 6, minY: -3, maxY: 3 },
    outline: [
      { x: -6, y: -3 },
      { x: 6, y: -3 },
      { x: 6, y: 3 },
      { x: -6, y: 3 },
    ],
    connections: ys.map((y, index) => ({
      name: ["A", "B"][index],
      source_trace_id: `source_${["A", "B"][index]}`,
      nominalTraceWidth: 0.1,
      width: 0.1,
      pointsToConnect: [-5, 5].map((x, end) => ({
        x,
        y,
        layer: "top",
        pointId: `port_${index}_${end}`,
      })),
    })),
    obstacles: ys.flatMap((y, index) =>
      [-5, 5].map((x, end) => ({
        shape: "circle" as const,
        componentId: `component_${end}`,
        center: { x, y },
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [["A", "B"][index], `port_${index}_${end}`],
      })),
    ),
    traces: [],
    buses: [
      { busId: "parallel", connectionNames: ["A", "B"], maxLengthSkew: 0.001 },
    ],
    differentialPairs:
      kind === "pair"
        ? [
            {
              connectionNames: ["A", "B"],
              lengthTolerance: 0.001,
              traceGap: 0.6,
              maxUncoupledLength: 7,
            },
          ]
        : [],
  }
  const fixed: Trace[] = []
  const carriers: Trace[] = []
  for (let index = 0; index < 2; index++) {
    const name = ["A", "B"][index],
      y = ys[index]
    let layer = "top"
    const left: Trace["route"] = [wire(-5, y)]
    for (let n = 0; n < counts[index]; n++) {
      const x = -4.5 + n * 0.5,
        next = layer === "top" ? "bottom" : "top"
      left.push(wire(x, y, layer), via(x, y, layer, next), wire(x, y, next))
      layer = next
    }
    left.push(wire(-2, y))
    fixed.push(
      trace(name, `fixed_${name}_left`, left),
      trace(name, `fixed_${name}_right`, [wire(2, y), wire(5, y)]),
    )
    carriers.push(trace(name, `carrier_${name}`, [wire(-2, y), wire(2, y)]))
    if (kind === "pair") carriers.at(-1)!.coupledSection = [0, 1]
  }
  const input = structuredClone(native)
  input.connections = input.connections.map((connection, index) => ({
    ...connection,
    pointsToConnect: [
      { x: -2, y: ys[index], layer: "top" },
      { x: 2, y: ys[index], layer: "top" },
    ],
  }))
  input.traces = fixed
  return { counts, kind, native, input, carriers }
}

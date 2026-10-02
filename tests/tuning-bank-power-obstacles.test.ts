import { expect, test } from "bun:test"
import { spreadCoupledTuningLanes } from "../lib/spread-coupled-tuning-lanes"
import { spreadTuningLanes } from "../lib/spread-tuning-lanes"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("both tuning bank allocators retain package approaches and clear pre-dogboned power barrels", () => {
  const traces: Trace[] = [0, 1, 2].map((y, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `signal_${i}`,
    connection_name: `D${i}`,
    route: [0, 5, 15, 20].map((x) => ({
      x,
      y,
      route_type: "wire",
      layer: "inner1",
      width: 0.1,
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 23, minY: -5, maxY: 7 },
    connections: traces.map((trace) => ({
      name: trace.connection_name!,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!].map((point) => ({
        x: point.x,
        y: point.y,
        layer: "inner1",
      })),
    })),
    buses: [
      {
        busId: "DATA",
        connectionNames: ["D0", "D1", "D2"],
        maxLengthSkew: 0.1,
      },
    ],
    obstacles: traces.flatMap((trace) =>
      [0, 20].map((x, side) => ({
        componentId: side ? "RAM" : "CPU",
        type: "rect",
        shape: "circle" as const,
        center: { x, y: trace.route[0].y },
        width: 0.4,
        height: 0.4,
        layers: ["top"],
        connectedTo: [trace.connection_name!],
      })),
    ),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed_power",
        connection_name: "VCC",
        route: [
          { route_type: "wire", x: 14, y: 3.1, layer: "top", width: 0.1 },
          { route_type: "wire", x: 13.6, y: 2.7, layer: "top", width: 0.1 },
          {
            route_type: "via",
            x: 13.6,
            y: 2.7,
            from_layer: "top",
            to_layer: "inner2",
            layers: ["top", "inner1", "inner2", "bottom"],
            via_diameter: 0.3,
            via_hole_diameter: 0.15,
          },
          { route_type: "wire", x: 13.6, y: 2.7, layer: "inner2", width: 0.1 },
        ],
      },
    ],
  }
  input.obstacles.push({
    componentId: "RAM",
    type: "rect",
    shape: "circle",
    center: { x: 14, y: 3.1 },
    width: 0.4,
    height: 0.4,
    layers: ["top"],
    connectedTo: ["VCC"],
  })
  const before = structuredClone({ input, traces })
  for (const allocator of [spreadCoupledTuningLanes, spreadTuningLanes]) {
    const result = allocator(input, traces, 0.8)
    expect(result).not.toBeNull()
    const copper = [...fixedCopper(input), ...result!.flatMap(routeCopper)]
    for (const [index, trace] of result!.entries()) {
      expect(trace.route[0]).toEqual(traces[index].route[0])
      expect(trace.route.at(-1)).toEqual(traces[index].route.at(-1))
      expect(trace.route.at(-2)!.x).toBeLessThan(14)
      expect(
        new VectorScene(
          input,
          input.connections[index],
          0.1,
          copper,
        ).pathVisible(trace.route),
      ).toBe(true)
      expect(tuningPathIsSelfClear(trace.route, 0.2)).toBe(true)
    }
  }
  expect({ input, traces }).toEqual(before)
})

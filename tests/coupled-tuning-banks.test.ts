import { expect, test } from "bun:test"
import { spreadCoupledTuningLanes } from "../lib/spread-coupled-tuning-lanes"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

test("tuning banks derive their orientation from endpoints and preserve paired escapes", () => {
  for (const rotate of [false, true]) {
    const at = (x: number, y: number): Point =>
      rotate ? { x: 50 - y, y: 30 - x } : { x: 50 + x, y: 30 + y }
    const traces: Trace[] = [-0.11, 0.11, 1, 2].map((y, i) => ({
      type: "pcb_trace",
      pcb_trace_id: `t${i}`,
      connection_name: `d${i}`,
      coupledSection: i < 2 ? [1, 2] : undefined,
      route: [0, 1, 19, 20].map((x) => ({
        ...at(x, y),
        route_type: "wire",
        layer: "top",
        width: 0.1,
      })),
    }))
    const input: SimpleRouteJson = {
      layerCount: 2,
      minTraceWidth: 0.1,
      defaultObstacleMargin: 0.1,
      bounds: { minX: 20, maxX: 80, minY: 0, maxY: 60 },
      obstacles: [],
      connections: traces.map((t) => ({
        name: t.connection_name!,
        pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
          ...p,
          layer: "top",
        })),
      })),
      buses: [
        {
          busId: "data",
          connectionNames: traces.map((t) => t.connection_name!),
          maxLengthSkew: 0.5,
        },
      ],
      differentialPairs: [
        { connectionNames: ["d0", "d1"], traceGap: 0.12, lengthTolerance: 0.1 },
      ],
    }
    const before = structuredClone(traces)
    const result = spreadCoupledTuningLanes(input, traces, 0.8)
    expect(result).not.toBeNull()
    expect(traces).toEqual(before)
    const copper = [...fixedCopper(input), ...result!.flatMap(routeCopper)]
    for (const [i, t] of result!.entries()) {
      expect(t.route[0]).toEqual(traces[i].route[0])
      expect(t.route.at(-1)).toEqual(traces[i].route.at(-1))
      expect(
        new VectorScene(input, input.connections[i], 0.1, copper).pathVisible(
          t.route,
        ),
      ).toBe(true)
      expect(tuningPathIsSelfClear(t.route, 0.2)).toBe(true)
      if (i < 2) {
        expect(t.route.slice(0, t.coupledSection![0] + 1)).toEqual(
          traces[i].route.slice(0, 2),
        )
        expect(t.route.slice(t.coupledSection![1])).toEqual(
          traces[i].route.slice(2),
        )
      }
    }
  }
})

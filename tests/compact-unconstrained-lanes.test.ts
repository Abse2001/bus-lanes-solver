import { expect, test } from "bun:test"
import { compactUnconstrainedLanes } from "../lib/compact-unconstrained-lanes"
import { length } from "../lib/geometry"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("controls compact around fixed copper while matched lanes and terminal geometry stay immutable", () => {
  for (const turn of [false, true])
    for (const reflect of [-1, 1]) {
      const at = (x: number, y: number) =>
        turn
          ? { x: 30 - y, y: 20 + reflect * x }
          : { x: 30 + reflect * x, y: 20 + y }
      const trace = (name: string, points: number[][]): Trace => ({
        type: "pcb_trace",
        pcb_trace_id: name,
        connection_name: name,
        route: points.map(([x, y]) => ({
          ...at(x, y),
          route_type: "wire",
          width: 0.1,
          layer: "inner1",
        })),
      })
      const traces = [
        trace("control", [
          [0, 0],
          [1, 1],
          [1, 4],
          [2, 5],
          [18, 5],
          [19, 4],
          [19, 1],
          [20, 0],
        ]),
        trace("bus", [
          [0, -1],
          [20, -1],
        ]),
        trace("p", [
          [0, -2],
          [20, -2],
        ]),
        trace("n", [
          [0, -2.22],
          [20, -2.22],
        ]),
        trace("curve", [
          [0, -3],
          [20, -3],
        ]),
      ]
      traces[4].curvedSegments = [1]
      const input: SimpleRouteJson = {
        layerCount: 4,
        allowedLayers: ["inner1", "inner2"],
        minTraceWidth: 0.1,
        minTraceToPadEdgeClearance: 0.075,
        bounds: { minX: 0, maxX: 60, minY: -10, maxY: 60 },
        obstacles: [
          {
            center: at(10, 1),
            width: 4,
            height: 4,
            layers: ["inner1"],
            connectedTo: [],
          },
        ],
        traces: [
          trace("power", [
            [5, 0.1],
            [15, 0.1],
          ]),
        ],
        connections: traces.map((t) => ({
          name: t.connection_name!,
          pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
            x: p.x,
            y: p.y,
            layer: "inner1",
          })),
        })),
        buses: [{ busId: "bus", connectionNames: ["bus"], maxLengthSkew: 0.2 }],
        differentialPairs: [
          { connectionNames: ["p", "n"], lengthTolerance: 0.1 },
        ],
      }
      const before = structuredClone({ input, traces }),
        result = compactUnconstrainedLanes(input, traces)
      expect(length(result[0].route)).toBeLessThan(length(traces[0].route) - 1)
      expect(result.slice(1)).toEqual(traces.slice(1))
      expect([result[0].route[0], result[0].route.at(-1)]).toEqual([
        traces[0].route[0],
        traces[0].route.at(-1),
      ])
      expect(routeAnglesAreConventional(result)).toBe(true)
      const copper = [...fixedCopper(input), ...result.flatMap(routeCopper)]
      expect(
        new VectorScene(input, input.connections[0], 0.1, copper).pathVisible(
          result[0].route,
        ),
      ).toBe(true)
      expect(tuningPathIsSelfClear(result[0].route, 0.125)).toBe(true)
      expect({ input, traces }).toEqual(before)
    }
})

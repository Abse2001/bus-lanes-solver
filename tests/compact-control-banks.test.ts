import { expect, test } from "bun:test"
import { spreadCoupledTuningLanes } from "../lib/spread-coupled-tuning-lanes"
import { highDemandPairedLanes } from "../lib/tuning-bank-demands"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import type { SimpleRouteJson, Trace } from "../lib/types"

function sample(turn: boolean, reflect: number) {
  const at = (x: number, y: number) =>
    turn
      ? { x: 31 - y, y: 17 + reflect * x }
      : { x: 31 + reflect * x, y: 17 + y }
  const traces: Trace[] = [
    -0.11, 0.11, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7,
  ].map((y, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `t${i}`,
    connection_name: `s${i}`,
    coupledSection: i < 2 ? [1, 2] : undefined,
    route: [0, 1, 19, 20].map((x) => ({
      ...at(x, y),
      route_type: "wire",
      layer: "inner1",
      width: 0.1,
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["inner1", "inner2"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: 0, maxX: 60, minY: -10, maxY: 50 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        x: p.x,
        y: p.y,
        layer: "inner1",
      })),
    })),
    buses: [
      {
        busId: "data",
        connectionNames: ["s0", "s1", "s2", "s3"],
        maxLengthSkew: 0.2,
      },
    ],
    differentialPairs: [
      { connectionNames: ["s0", "s1"], traceGap: 0.12, lengthTolerance: 0.1 },
    ],
  }
  return { input, traces }
}

test("compact banks reserve tuning space without spreading unconstrained controls", () => {
  for (const turn of [false, true])
    for (const reflect of [-1, 1]) {
      const { input, traces } = sample(turn, reflect),
        before = structuredClone({ input, traces })
      const uniform = spreadCoupledTuningLanes(input, traces, 1)!,
        compact = spreadCoupledTuningLanes(input, traces, 1, "dogleg", true)!
      expect(compact).not.toBeNull()
      expect(uniform).not.toBeNull()
      const extent = (ts: Trace[]) => {
        const vs = ts.flatMap((t) => t.route.map((p) => (turn ? p.x : p.y)))
        return Math.max(...vs) - Math.min(...vs)
      }
      expect(extent(compact)).toBeLessThan(0.8 * extent(uniform))
      const copper = [...fixedCopper(input), ...compact.flatMap(routeCopper)]
      for (const [i, t] of compact.entries()) {
        expect([t.route[0], t.route.at(-1)]).toEqual([
          traces[i].route[0],
          traces[i].route.at(-1),
        ])
        expect(
          new VectorScene(input, input.connections[i], 0.1, copper).pathVisible(
            t.route,
          ),
        ).toBe(true)
        expect(tuningPathIsSelfClear(t.route, 0.175)).toBe(true)
      }
      expect(
        sharedPairSpacingReports(input, compact).every((p) => p.matched),
      ).toBe(true)
      expect({ input, traces }).toEqual(before)
    }
})

test("paired bank demand follows copper deficits across rotations", () => {
  for (const turn of [false, true]) {
    const { input, traces } = sample(turn, 1)
    expect(highDemandPairedLanes(input, traces).size).toBe(0)
    const t = traces[2],
      a = t.route[0],
      b = t.route.at(-1)!
    t.route = [
      a,
      { ...a, x: a.x - 12, y: a.y + 12 },
      { ...b, x: b.x - 12, y: b.y + 12 },
      b,
    ]
    expect([...highDemandPairedLanes(input, traces)].sort()).toEqual([
      "s0",
      "s1",
    ])
  }
})

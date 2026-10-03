import { expect, test } from "bun:test"
import { bipolarPairedLobes } from "../lib/bipolar-tuning"
import { roundedPairedLobes } from "../lib/smooth-tuning"
import { distance, length } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { RouteConflictIndex } from "../lib/route-conflict-index"

test("two-sided rounded meanders pack equal-length rails into a shallower pocket", () => {
  for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
    const at = (x: number, y: number) => ({
      x: 13 + x * Math.cos(angle) - y * Math.sin(angle),
      y: -7 + x * Math.sin(angle) + y * Math.cos(angle),
    })
    for (const side of [-1, 1]) {
      const rails = bipolarPairedLobes(
        at(0, 0),
        at(8, 0),
        0.22,
        16,
        6,
        side,
        0.12,
      )!
      const oneSided = roundedPairedLobes(
        at(0, 0),
        at(8, 0),
        0.22,
        16,
        6,
        side,
        0.12,
      )!
      expect(rails).not.toBeNull()
      const depth = (p: { x: number; y: number }) =>
        -(p.x - 13) * Math.sin(angle) + (p.y + 7) * Math.cos(angle)
      expect(
        Math.max(...rails.flat().map((p) => Math.abs(depth(p)))),
      ).toBeLessThan(
        Math.max(...oneSided.flat().map((p) => Math.abs(depth(p)))),
      )
      expect(Math.min(...rails.flat().map(depth))).toBeLessThan(-0.5)
      expect(Math.max(...rails.flat().map(depth))).toBeGreaterThan(0.5)
      for (const [index, rail] of rails.entries()) {
        expect(length(rail)).toBeCloseTo(24, 8)
        expect(distance(rail[0], at(0, index ? -0.11 : 0.11))).toBeLessThan(
          1e-8,
        )
        expect(
          distance(rail.at(-1)!, at(8, index ? -0.11 : 0.11)),
        ).toBeLessThan(1e-8)
        expect(tuningPathIsSelfClear(rail, 0.2)).toBe(true)
        // Each rounded turn has 18 chords, limiting the directional step to 5 degrees.
        for (let i = 1; i < rail.length - 1; i++) {
          const a = rail[i - 1],
            b = rail[i],
            c = rail[i + 1]
          const cosine =
            ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
            (distance(a, b) * distance(b, c))
          expect(cosine).toBeGreaterThanOrEqual(Math.cos(Math.PI / 36) - 1e-8)
        }
      }
      expect(
        new RouteConflictIndex().firstConflict(rails[0], rails[1], 0.2),
      ).toBeFalsy()
    }
  }
})

test("invalid or undersized two-sided pockets are rejected", () => {
  const a = { x: 0, y: 0 },
    b = { x: 8, y: 0 }
  for (const args of [
    [a, a, 0.22, 16, 6, 1, 0.12],
    [a, b, -0.1, 16, 6, 1, 0.12],
    [a, b, 0.22, 0, 6, 1, 0.12],
    [a, b, 0.22, 16, 0, 1, 0.12],
    [a, b, 0.22, 16, 65, 1, 0.12],
    [a, b, 0.22, 16, 6, 0, 0.12],
    [a, b, 0.22, 16, 6, 1, 0],
    [a, b, 0.22, 0.1, 6, 1, 0.12],
    [a, b, 0.22, Infinity, 6, 1, 0.12],
  ] as Parameters<typeof bipolarPairedLobes>[])
    expect(bipolarPairedLobes(...args)).toBeNull()
})

test("paired length tuning uses both sides of a narrow obstacle-bounded corridor", async () => {
  const { tuneCoupledLengths } = await import("../lib/tune-coupled-lengths")
  const { VectorScene, fixedCopper, routeCopper } = await import(
    "../lib/vector-scene"
  )
  const { busLengthReports, pairLengthReports } = await import(
    "../lib/route-lengths"
  )
  const { sharedPairSpacingReports } = await import(
    "../lib/shared-pair-spacing"
  )
  const traces: import("../lib/types").Trace[] = [0.11, -0.11, 3].map(
    (y, i) => ({
      type: "pcb_trace",
      pcb_trace_id: `t${i}`,
      connection_name: `s${i}`,
      coupledSection: i < 2 ? [0, 1] : undefined,
      route: [0, 8].map((x) => ({
        x,
        y,
        route_type: "wire",
        width: 0.1,
        layer: "inner1",
      })),
    }),
  )
  const input: import("../lib/types").SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -20, maxX: 10, minY: -3, maxY: 4 },
    obstacles: [-1, 1].map((side) => ({
      type: "rect",
      center: { x: 4, y: side * 1.3 },
      width: 12,
      height: 0.1,
      layers: ["inner1"],
      connectedTo: [],
    })),
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: t.route as import("../lib/types").Wire[],
    })),
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed",
        connection_name: "s2",
        route: [-16, 0].map((x) => ({
          x,
          y: 3,
          route_type: "wire",
          width: 0.1,
          layer: "inner1",
        })),
      },
    ],
    buses: [
      {
        busId: "shared",
        connectionNames: ["s0", "s1", "s2"],
        maxLengthSkew: 0,
      },
    ],
    differentialPairs: [
      { connectionNames: ["s0", "s1"], traceGap: 0.12, lengthTolerance: 0.01 },
    ],
  }
  const before = structuredClone({ input, traces })
  const result = tuneCoupledLengths(input, traces, {
    packMeanders: true,
    maxCandidates: 16384,
  })
  expect({ input, traces }).toEqual(before)
  expect(busLengthReports(input, result).every((r) => r.matched)).toBe(true)
  expect(pairLengthReports(input, result).every((r) => r.matched)).toBe(true)
  expect(sharedPairSpacingReports(input, result).every((r) => r.matched)).toBe(
    true,
  )
  const copper = [...fixedCopper(input), ...result.flatMap(routeCopper)]
  for (const [i, t] of result.entries()) {
    expect(
      new VectorScene(input, input.connections[i], 0.1, copper).pathVisible(
        t.route,
      ),
    ).toBe(true)
    expect(tuningPathIsSelfClear(t.route, 0.2)).toBe(true)
    expect(t.route[0]).toEqual(traces[i].route[0])
    expect(t.route.at(-1)).toEqual(traces[i].route.at(-1))
  }
})

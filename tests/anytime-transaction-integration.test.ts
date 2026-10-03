import { expect, test } from "bun:test"
import { AnytimeBusLanesSolver } from "../lib/anytime-bus-lanes-solver"
import { recoverAnytimeSkeleton } from "../lib/anytime-skeleton"
import { anytimeTransactionCandidates } from "../lib/anytime-transaction-search"
import { length, simplify } from "../lib/geometry"
import { busLengthReports } from "../lib/route-lengths"
import { roundedTuningLobes } from "../lib/smooth-tuning"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

function routedTrace(name: string, points: Point[]): Trace {
  return {
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    route: points.map((p) => ({
      ...p,
      route_type: "wire",
      layer: "top",
      width: 0.1,
    })),
    curvedSegments: points.slice(1).flatMap((p, i) => {
      const dx = Math.abs(p.x - points[i].x),
        dy = Math.abs(p.y - points[i].y)
      return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8 ? [i + 1] : []
    }),
  }
}

/** The longest lane detours below the bus; the other lanes matched that old
 * ceiling. No single-lane shortening can cross this tight matching barrier. */
function completedBus() {
  const driver = routedTrace("driver", [
    { x: 0, y: 0 },
    { x: 1, y: -1 },
    { x: 1, y: -3 },
    { x: 2, y: -4 },
    { x: 8, y: -4 },
    { x: 9, y: -3 },
    { x: 9, y: -1 },
    { x: 10, y: 0 },
  ])
  const ceiling = length(driver.route),
    tolerance = 0.2
  const traces = [
    driver,
    ...[2, 4].map((y, i) =>
      routedTrace(
        `lane${i}`,
        simplify([
          { x: 0, y },
          ...roundedTuningLobes(
            { x: 1, y },
            { x: 9, y },
            ceiling - tolerance - 10,
            4,
            1,
            0.12,
          )!,
          { x: 10, y },
        ]),
      ),
    ),
  ]
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -2, maxX: 12, minY: -6, maxY: 9 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        x: p.x,
        y: p.y,
        layer: "top",
      })),
    })),
    buses: [
      {
        busId: "DATA",
        connectionNames: traces.map((t) => t.connection_name!),
        maxLengthSkew: tolerance,
      },
    ],
  }
  return { input, traces, ceiling }
}

test("a novel transaction lowers the old bus ceiling and every matched member together", () => {
  const { input, traces, ceiling } = completedBus(),
    recovered = recoverAnytimeSkeleton(input, traces)
  expect(busLengthReports(input, traces)[0].matched).toBe(true)
  const onlyShortDriver = [
    routedTrace("driver", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    ...traces.slice(1),
  ]
  const onlyShortMember = [traces[0], recovered.traces[1], traces[2]]
  expect(busLengthReports(input, onlyShortDriver)[0].matched).toBe(false)
  expect(busLengthReports(input, onlyShortMember)[0].matched).toBe(false)
  let candidate: Trace[] | undefined,
    steps = 0
  for (const proposal of anytimeTransactionCandidates(input, traces)) {
    steps++
    if (
      proposal &&
      busLengthReports(input, proposal)[0].matched &&
      Math.max(...proposal.map((t) => length(t.route))) < ceiling - 3
    ) {
      candidate = proposal
      break
    }
    if (steps >= 128) break
  }
  expect(candidate).toBeDefined()
  expect(steps).toBeLessThan(128)
  expect(
    candidate!.every((t, i) => length(t.route) < length(traces[i].route) - 3),
  ).toBe(true)
  expect(candidate!.reduce((s, t) => s + length(t.route), 0)).toBeLessThan(
    traces.reduce((s, t) => s + length(t.route), 0) * 0.8,
  )
})

test("the public incumbent accepts substantial physical gains from a strictly completed seed", () => {
  const { input, traces } = completedBus(),
    before = structuredClone({ input, traces })
  const solver = AnytimeBusLanesSolver.fromCompleted(input, traces, {
    fanout: "none",
    iterationsPerX: 128,
  })
  const initial = solver.getResult(),
    improved = solver.solve()
  expect(initial.status).toBe("valid")
  expect(improved.status).toBe("valid")
  expect(improved.violations).toEqual([])
  expect(improved.acceptedImprovements).toBeGreaterThan(0)
  expect(improved.score.totalLengthMm).toBeLessThan(
    initial.score.totalLengthMm * 0.7,
  )
  expect(improved.score.envelopeAreaMm2).toBeLessThan(
    initial.score.envelopeAreaMm2 * 0.6,
  )
  expect(improved.score.skewPenalty).toBeLessThan(
    initial.score.skewPenalty * 0.01,
  )
  expect(improved.score.busLengths[0].matched).toBe(true)
  for (const [i, t] of improved.output.traces!.entries()) {
    expect(t.route[0]).toEqual(traces[i].route[0])
    expect(t.route.at(-1)).toEqual(traces[i].route.at(-1))
  }
  expect({ input, traces }).toEqual(before)
})

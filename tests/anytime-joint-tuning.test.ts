import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import {
  jointLengthTargets,
  jointTuningCandidates,
  type JointTuningOptions,
} from "../lib/anytime-joint-tuning"
import { recoverAnytimeSkeleton } from "../lib/anytime-skeleton"
import { length, simplify } from "../lib/geometry"
import { busLengthReports } from "../lib/route-lengths"
import { pairCouplingReports } from "../lib/pair-coupling"
import { roundedPairedLobes, roundedTuningLobes } from "../lib/smooth-tuning"
import { copperTooClose, routeCopper } from "../lib/vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

function trace(name: string, points: Point[]): Trace {
  const clean = simplify(points)
  return {
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    route: clean.map((p) => ({
      ...p,
      route_type: "wire",
      layer: "top",
      width: 0.1,
    })),
    curvedSegments: clean.slice(1).flatMap((p, i) => {
      const previous = clean[i],
        dx = Math.abs(p.x - previous.x),
        dy = Math.abs(p.y - previous.y)
      return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8 ? [i + 1] : []
    }),
  }
}

function input(traces: Trace[]): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -5, maxX: 30, minY: -15, maxY: 35 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
    buses: [
      {
        busId: "DATA",
        connectionNames: traces.map((t) => t.connection_name!),
        maxLengthSkew: 0.05,
      },
    ],
  }
}

function firstCandidate(
  board: SimpleRouteJson,
  traces: Trace[],
  options: JointTuningOptions = {},
) {
  let heartbeats = 0
  for (const candidate of jointTuningCandidates(board, traces, options)) {
    if (candidate) return { traces: candidate, heartbeats }
    heartbeats++
  }
  throw Error(`No complete candidate after ${heartbeats} heartbeats`)
}

function assertStrictlyValid(board: SimpleRouteJson, traces: Trace[]) {
  const validator = BusLanesSolver.forValidation(board, traces)
  validator.solve()
  expect(validator.error).toBeNull()
  expect(validator.solved).toBe(true)
}

test("joint targets propagate overlapping constraints and include fixed electrical copper", () => {
  const routes = [
    trace("a", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    trace("b", [
      { x: 0, y: 5 },
      { x: 7, y: 5 },
    ]),
    trace("c", [
      { x: 0, y: 10 },
      { x: 4, y: 10 },
    ]),
  ]
  const board = input(routes)
  board.traces = [
    trace("c", [
      { x: -2, y: 10 },
      { x: 0, y: 10 },
    ]),
  ]
  board.buses = [
    { busId: "AB", connectionNames: ["a", "b"], maxLengthSkew: 1 },
    { busId: "BC", connectionNames: ["b", "c"], maxLengthSkew: 0.5 },
  ]
  expect([...jointLengthTargets(board, routes, 1)!]).toEqual([
    ["a", 10],
    ["b", 9],
    ["c", 8.5],
  ])
  expect([...jointLengthTargets(board, routes, 0.5)!]).toEqual([
    ["a", 10],
    ["b", 9.5],
    ["c", 9.25],
  ])
  expect([...jointLengthTargets(board, routes, 0)!].map(([, v]) => v)).toEqual([
    10, 10, 10,
  ])
  expect(jointLengthTargets(board, routes, Number.NaN)).toBeNull()
})

test("shortening a bus driver retargets all old banks in one legal transaction", () => {
  const driver = trace("a", [
    { x: 0, y: 0 },
    { x: 3, y: -3 },
    { x: 7, y: -3 },
    { x: 10, y: 0 },
  ])
  const ceiling = length(driver.route)
  const old = [
    driver,
    trace(
      "b",
      roundedTuningLobes(
        { x: 0, y: 5 },
        { x: 7, y: 5 },
        ceiling - 7,
        2,
        1,
        0.4,
      )!,
    ),
    trace(
      "c",
      roundedTuningLobes(
        { x: 0, y: 10 },
        { x: 8, y: 10 },
        ceiling - 8,
        2,
        1,
        0.4,
      )!,
    ),
  ]
  const board = input(old),
    original = structuredClone(old),
    recovery = recoverAnytimeSkeleton(board, old)
  recovery.traces[0] = trace("a", [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ])
  const progress: string[] = []
  const result = firstCandidate(board, recovery.traces, {
    banks: recovery.pockets,
    preservedTraces: old,
    maxCandidates: 12,
    onAttempt: (p) => progress.push(p.reason),
  })
  expect(progress).toEqual(["candidate", "candidate", "complete"])
  expect(result.heartbeats).toBe(3)
  expect(busLengthReports(board, result.traces)[0].matched).toBe(true)
  expect(result.traces.reduce((s, t) => s + length(t.route), 0)).toBeLessThan(
    old.reduce((s, t) => s + length(t.route), 0) * 0.8,
  )
  for (let i = 0; i < old.length; i++) {
    expect(result.traces[i].route[0]).toEqual(old[i].route[0])
    expect(result.traces[i].route.at(-1)).toEqual(old[i].route.at(-1))
  }
  assertStrictlyValid(board, result.traces)
  expect(old).toEqual(original)
})

test("a tiny matching residual uses smooth patterns below the rounded-cell minimum", () => {
  const routes = [
    trace("a", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    trace("b", [
      { x: 0, y: 5 },
      { x: 9.955, y: 5 },
    ]),
  ]
  const board = input(routes)
  board.buses![0].maxLengthSkew = 0.04
  const result = firstCandidate(board, routes, { maxCandidates: 32 })
  expect(length(result.traces[1].route)).toBeCloseTo(9.96, 6)
  expect(busLengthReports(board, result.traces)[0].matched).toBe(true)
  assertStrictlyValid(board, result.traces)
})

test("shared pair retargeting changes both rails atomically at preserved spacing", () => {
  const waves = roundedPairedLobes(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    0.22,
    8,
    2,
    1,
    0.12,
  )!
  const old = waves.map((points, i) => {
    const t = trace(`p${i}`, points)
    t.coupledSection = [0, t.route.length - 1]
    return t
  })
  old.push(
    trace("driver", [
      { x: 0, y: 8 },
      { x: 18, y: 8 },
    ]),
  )
  const board = input(old)
  board.differentialPairs = [
    { connectionNames: ["p0", "p1"], traceGap: 0.12, lengthTolerance: 0.001 },
  ]
  const recovery = recoverAnytimeSkeleton(board, old)
  const result = firstCandidate(board, recovery.traces, {
    banks: recovery.pockets,
    preservedTraces: old,
    maxCandidates: 128,
  })
  expect(
    pairCouplingReports(board, result.traces).every((r) => r.matched),
  ).toBe(true)
  expect(busLengthReports(board, result.traces)[0].matched).toBe(true)
  expect(result.traces[0].route.length).toBeGreaterThan(2)
  expect(result.traces[1].route.length).toBeGreaterThan(2)
  assertStrictlyValid(board, result.traces)
})

test("a lower bus ceiling contracts the paired centerline while retaining the rail gap", () => {
  const oldDriver = trace("driver", [
    { x: 0, y: 10 },
    { x: 2, y: 8 },
    { x: 16, y: 8 },
    { x: 18, y: 10 },
  ])
  const waves = roundedPairedLobes(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    0.22,
    length(oldDriver.route) - 10,
    2,
    1,
    0.4,
  )!
  const old = waves.map((points, i) => {
    const t = trace(`p${i}`, points)
    t.coupledSection = [0, t.route.length - 1]
    return t
  })
  old.push(oldDriver)
  const board = input(old)
  board.differentialPairs = [
    { connectionNames: ["p0", "p1"], traceGap: 0.12, lengthTolerance: 0.001 },
  ]
  const recovered = recoverAnytimeSkeleton(board, old)
  recovered.traces[2] = trace("driver", [
    { x: 0, y: 10 },
    { x: 18, y: 10 },
  ])
  const progress: string[] = []
  const result = firstCandidate(board, recovered.traces, {
    banks: recovered.pockets,
    preservedTraces: old,
    pairedTargetModes: ["minimum"],
    maxCandidates: 16,
    onAttempt: (p) => progress.push(p.reason),
  })
  expect(progress).toEqual(["candidate", "complete"])
  expect(length(result.traces[0].route)).toBeCloseTo(17.95, 6)
  expect(length(result.traces[1].route)).toBeCloseTo(17.95, 6)
  expect(Math.max(...result.traces[0].route.map((p) => p.y))).toBeLessThan(
    Math.max(...old[0].route.map((p) => p.y)),
  )
  for (let i = 0; i < 2; i++) {
    expect(result.traces[i].route[0]).toEqual(old[i].route[0])
    expect(result.traces[i].route.at(-1)).toEqual(old[i].route.at(-1))
  }
  expect(
    pairCouplingReports(board, result.traces).every((r) => r.matched),
  ).toBe(true)
  assertStrictlyValid(board, result.traces)
})

test("paired wave deletion preserves room reserved for a future accepted bank", () => {
  const waves = roundedPairedLobes(
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      0.22,
      12,
      3,
      1,
      0.25,
    )!,
    old = waves.map((points, i) => {
      const rail = trace(`p${i}`, points)
      rail.coupledSection = [0, rail.route.length - 1]
      return rail
    })
  old.push(
    trace("main", [
      { x: 0, y: 10 },
      { x: 24, y: 10 },
    ]),
    trace(
      "future",
      roundedTuningLobes(
        { x: 1.5, y: 1.7 },
        { x: 2.5, y: 1.7 },
        0.25,
        1,
        1,
        0.1,
      )!,
    ),
    trace("future-driver", [
      { x: 0, y: 6 },
      { x: 1.25, y: 6 },
    ]),
  )
  const board = input(old)
  board.buses = [
    { busId: "PAIR", connectionNames: ["p0", "p1", "main"], maxLengthSkew: 0 },
    {
      busId: "SMALL",
      connectionNames: ["future", "future-driver"],
      maxLengthSkew: 0,
    },
  ]
  board.differentialPairs = [
    { connectionNames: ["p0", "p1"], traceGap: 0.12, lengthTolerance: 0.00001 },
  ]
  const recovery = recoverAnytimeSkeleton(board, old)
  recovery.traces[2] = trace("main", [
    { x: 0, y: 10 },
    { x: 20, y: 10 },
  ])
  board.connections[2].pointsToConnect = [
    recovery.traces[2].route[0],
    recovery.traces[2].route.at(-1)!,
  ] as Wire[]
  const progress: string[] = [],
    result = firstCandidate(board, recovery.traces, {
      banks: recovery.pockets,
      preservedTraces: old,
      pairedTargetModes: ["minimum"],
      reserveFutureBanks: true,
      maxCandidates: 64,
      onAttempt: (p) => progress.push(p.reason),
    })
  expect(progress[0]).toBe("clearance")
  expect(result.traces[0].route.length).toBeLessThan(old[0].route.length)
  expect(result.traces[3].route).toEqual(old[3].route)
  expect(busLengthReports(board, result.traces).every((r) => r.matched)).toBe(
    true,
  )
  expect(
    pairCouplingReports(board, result.traces).every((r) => r.matched),
  ).toBe(true)
  assertStrictlyValid(board, result.traces)
})

test("additional matching length expands accepted legs without changing paired or independent phases", () => {
  const paired = roundedPairedLobes(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      0.22,
      8,
      2,
      1,
      0.25,
    )!,
    old = paired.map((points, i) => {
      const rail = trace(`p${i}`, points)
      rail.coupledSection = [0, rail.route.length - 1]
      return rail
    })
  old.push(
    trace(
      "independent",
      roundedTuningLobes({ x: 0, y: 5 }, { x: 10, y: 5 }, 8, 3, 1, 0.2)!,
    ),
    trace("driver", [
      { x: 0, y: 10 },
      { x: 20, y: 10 },
    ]),
  )
  const board = input(old)
  board.differentialPairs = [
    { connectionNames: ["p0", "p1"], traceGap: 0.12, lengthTolerance: 0.00001 },
  ]
  const recovery = recoverAnytimeSkeleton(board, old),
    result = firstCandidate(board, recovery.traces, {
      banks: recovery.pockets,
      preservedTraces: old,
      pairedTargetModes: ["minimum"],
      maxCandidates: 8,
    })
  expect(result.heartbeats).toBe(3)
  for (let i = 0; i < 3; i++) {
    expect(result.traces[i].route).toHaveLength(old[i].route.length)
    expect(length(result.traces[i].route)).toBeCloseTo(19.95, 6)
    expect(
      result.traces[i].route.every(
        (p, k) => Math.abs(p.x - old[i].route[k].x) < 1e-8,
      ),
    ).toBe(true)
  }
  assertStrictlyValid(board, result.traces)
})

test("partial placements protect future immutable approaches before spending their tuning budget", () => {
  const old = [
      trace(
        "a",
        roundedTuningLobes({ x: 0, y: 0 }, { x: 5, y: 0 }, 6, 2, 1, 0.2)!,
      ),
      trace("b", [
        { x: 1.25, y: 2 },
        { x: 1.25, y: 2.3 },
        { x: 1.75, y: 2.8 },
        ...roundedTuningLobes(
          { x: 1.75, y: 2.8 },
          { x: 9.75, y: 2.8 },
          3,
          2,
          1,
          0.2,
        )!,
      ]),
      trace("driver", [
        { x: 0, y: 8 },
        { x: 13, y: 8 },
      ]),
    ],
    board = input(old),
    recovery = recoverAnytimeSkeleton(board, old),
    approach = routeCopper({ ...old[1], route: old[1].route.slice(0, 2) })
  let protectedPartial = 0
  const result = firstCandidate(board, recovery.traces, {
    banks: recovery.pockets,
    preservedTraces: old,
    maxCandidates: 128,
    onPartialCandidate: (traces, depth) => {
      if (depth !== 1) return
      protectedPartial++
      expect(
        routeCopper(traces[0]).every((segment) =>
          approach.every(
            (fixed) =>
              !copperTooClose(segment.a, segment.b, fixed, 0.125 - 1e-8),
          ),
        ),
      ).toBe(true)
    },
  })
  expect(protectedPartial).toBeGreaterThan(0)
  assertStrictlyValid(board, result.traces)
})

test("the accepted deficit is distributed across multiple preserved banks", () => {
  const small = trace("small", [
    { x: 0, y: 5 },
    ...roundedTuningLobes({ x: 0, y: 5 }, { x: 5, y: 5 }, 4, 2, 1, 0.4)!,
    { x: 5.5, y: 5 },
    { x: 6.5, y: 6 },
    { x: 6.5, y: 8 },
    { x: 7.5, y: 9 },
    { x: 8, y: 9 },
    ...roundedTuningLobes({ x: 8, y: 9 }, { x: 13, y: 9 }, 5, 2, 1, 0.4)!,
  ])
  const driver = trace("driver", [
    { x: 0, y: -4 },
    { x: length(small.route), y: -4 },
  ])
  const old = [driver, small],
    board = input(old),
    recovery = recoverAnytimeSkeleton(board, old)
  expect(
    recovery.pockets.filter((b) => b.members[0].connectionName === "small"),
  ).toHaveLength(2)
  const progress: string[] = []
  const result = firstCandidate(board, recovery.traces, {
    banks: recovery.pockets,
    preservedTraces: old,
    maxCandidates: 4,
    onAttempt: (p) => progress.push(p.reason),
  })
  expect(progress).toEqual(["candidate", "complete"])
  expect(length(result.traces[1].route)).toBeCloseTo(
    length(driver.route) - 0.05,
    6,
  )
  assertStrictlyValid(board, result.traces)
})

test("a restored bank is followed by novel placement trials instead of duplicate restorations", () => {
  const old = [
    trace("driver", [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]),
    trace(
      "small",
      roundedTuningLobes({ x: 0, y: 5 }, { x: 10, y: 5 }, 10, 2, 1, 0.4)!,
    ),
  ]
  const board = input(old),
    recovered = recoverAnytimeSkeleton(board, old),
    complete: Trace[][] = []
  for (const candidate of jointTuningCandidates(board, recovered.traces, {
    banks: recovered.pockets,
    preservedTraces: old,
    maxCandidates: 32,
  })) {
    if (candidate) complete.push(candidate)
    if (complete.length === 2) break
  }
  expect(complete).toHaveLength(2)
  expect(complete[0][1].route).not.toEqual(complete[1][1].route)
  for (const candidate of complete) assertStrictlyValid(board, candidate)
})

test("stale bank handoffs are dropped and current segments supply tuning pockets", () => {
  const old = [
    trace("a", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    trace("b", [
      { x: 0, y: 5 },
      ...roundedTuningLobes({ x: 1, y: 5 }, { x: 6, y: 5 }, 3, 2, 1, 0.12)!,
      { x: 7, y: 5 },
    ]),
  ]
  const board = input(old),
    recovery = recoverAnytimeSkeleton(board, old)
  recovery.traces[1] = trace("b", [
    { x: 0, y: 5 },
    { x: 7, y: 5 },
  ])
  const result = firstCandidate(board, recovery.traces, {
    banks: recovery.pockets,
    preservedTraces: old,
    maxCandidates: 128,
  })
  expect(busLengthReports(board, result.traces)[0].matched).toBe(true)
  expect(result.traces[1].route[0]).toEqual(old[1].route[0])
  assertStrictlyValid(board, result.traces)
})

test("impossible placement returns bounded heartbeats and leaves skeletons untouched", () => {
  const routes = [
    trace("a", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    trace("b", [
      { x: 0, y: 1 },
      { x: 2, y: 1 },
    ]),
  ]
  const board = input(routes)
  board.bounds = { minX: -0.1, maxX: 10.1, minY: -0.1, maxY: 1.1 }
  const original = structuredClone(routes),
    progress: number[] = []
  const results = [
    ...jointTuningCandidates(board, routes, {
      maxCandidates: 10,
      onAttempt: (p) => progress.push(p.attempts),
    }),
  ]
  expect(results.every((r) => !r)).toBe(true)
  expect(progress).toHaveLength(10)
  expect(progress.at(-1)).toBe(10)
  expect(routes).toEqual(original)
})

test("full transactions reject an untuned topology driver with a sharp corner", () => {
  const routes = [
    trace("driver", [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 10, y: 1 },
      { x: 10, y: 0 },
    ]),
    trace("small", [
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    ]),
  ]
  const board = input(routes),
    reasons: string[] = [],
    results = [
      ...jointTuningCandidates(board, routes, {
        maxCandidates: 12,
        onAttempt: (p) => reasons.push(p.reason),
      }),
    ]
  expect(results.every((candidate) => candidate === undefined)).toBe(true)
  expect(reasons).toContain("complete_angles")
})

import { expect, test } from "bun:test"
import {
  discoverAnytimeTuningBanks,
  recoverAnytimeSkeleton,
  skeletonBankPockets,
  skeletonDriverPriorities,
  skeletonShortcutCandidates,
  stripAnytimeTuningBanks,
} from "../lib/anytime-skeleton"
import { length, simplify } from "../lib/geometry"
import { roundedPairedLobes, roundedTuningLobes } from "../lib/smooth-tuning"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

function trace(points: Point[], name = "D"): Trace {
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

function input(traces: Trace[]): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
    })),
  }
}

test("recovering a bank reclaims its exact excess and preserves detached handoffs", () => {
  const original = trace(
    simplify([
      { x: 0, y: 0 },
      ...roundedTuningLobes({ x: 1, y: 0 }, { x: 9, y: 0 }, 8, 2, 1, 0.12)!,
      { x: 10, y: 0 },
    ]),
  )
  const before = structuredClone(original),
    recovered = recoverAnytimeSkeleton(input([original]), [original])
  expect(recovered.banks).toHaveLength(1)
  expect(recovered.banks[0].kind).toBe("independent")
  expect(recovered.banks[0].members[0].deficitMm).toBeCloseTo(8, 7)
  expect(length(recovered.traces[0].route)).toBeCloseTo(10, 7)
  expect(recovered.traces[0].curvedSegments).toEqual([])
  const pocket = recovered.pockets[0].members[0]
  expect(pocket.endIndex).toBe(pocket.startIndex + 1)
  expect(recovered.traces[0].route[pocket.startIndex]).toEqual(pocket.start)
  expect(recovered.traces[0].route[pocket.endIndex]).toEqual(pocket.end)
  expect(pocket.originalEndIndex).toBeGreaterThan(pocket.endIndex)
  recovered.traces[0].route[0].x = 99
  expect(original).toEqual(before)
})

test("specified-bank stripping leaves the other bank and reindexes its curves", () => {
  const points = [
    { x: 0, y: 0 },
    ...roundedTuningLobes({ x: 1, y: 0 }, { x: 5, y: 0 }, 4, 2, 1, 0.12)!,
    { x: 6, y: 0 },
    { x: 7, y: 1 },
    { x: 7, y: 3 },
    { x: 8, y: 4 },
    { x: 9, y: 4 },
    ...roundedTuningLobes({ x: 9, y: 4 }, { x: 13, y: 4 }, 6, 2, 1, 0.12)!,
    { x: 14, y: 4 },
  ]
  const original = trace(points),
    banks = discoverAnytimeTuningBanks(input([original]), [original])
  expect(banks).toHaveLength(2)
  const partial = stripAnytimeTuningBanks([original], banks, [banks[0].id])[0]
  expect(length(original.route) - length(partial.route)).toBeCloseTo(4, 7)
  expect(partial.curvedSegments!.length).toBeGreaterThan(0)
  const remaining = discoverAnytimeTuningBanks(input([partial]), [partial])
  expect(remaining).toHaveLength(1)
  expect(remaining[0].members[0].deficitMm).toBeCloseTo(6, 7)
  const pocket = skeletonBankPockets([original], banks, [banks[0].id])[0]
  expect(pocket.members[0].endIndex).toBe(pocket.members[0].startIndex + 1)
  expect(
    length(original.route) -
      length(stripAnytimeTuningBanks([original], banks)[0].route),
  ).toBeCloseTo(10, 7)
})

test("shared paired banks are removed together with corridor boundaries reindexed", () => {
  const waves = roundedPairedLobes(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    0.22,
    8,
    2,
    1,
    0.12,
  )!
  const traces = waves.map((points, i) => ({
    ...trace(points, `rail${i}`),
    coupledSection: [0, points.length - 1] as [number, number],
  }))
  const board = input(traces)
  board.differentialPairs = [
    {
      connectionNames: ["rail0", "rail1"],
      traceGap: 0.12,
      lengthTolerance: 0.001,
    },
  ]
  const recovered = recoverAnytimeSkeleton(board, traces)
  expect(recovered.banks).toHaveLength(1)
  expect(recovered.banks[0].kind).toBe("paired")
  expect(recovered.banks[0].spacingMm).toBeCloseTo(0.22, 7)
  expect(recovered.pockets[0].members).toHaveLength(2)
  for (const [i, stripped] of recovered.traces.entries()) {
    expect(length(stripped.route)).toBeCloseTo(10, 7)
    expect(stripped.route[0]).toEqual(traces[i].route[0])
    expect(stripped.route.at(-1)).toEqual(traces[i].route.at(-1))
    expect(stripped.coupledSection).toEqual([0, 1])
    expect(stripped.curvedSegments).toEqual([])
  }
})

test("recovery preserves vias and local layer transitions and skips ordinary rounded corners", () => {
  const original = trace(
    roundedTuningLobes({ x: 0, y: 0 }, { x: 10, y: 0 }, 8, 2, 1, 0.12)!,
  )
  original.route = [
    { route_type: "wire", x: -1, y: 0, layer: "bottom", width: 0.1 },
    { route_type: "wire", x: 0, y: 0, layer: "bottom", width: 0.1 },
    {
      route_type: "via",
      x: 0,
      y: 0,
      from_layer: "bottom",
      to_layer: "top",
      via_diameter: 0.3,
    },
    ...original.route,
    {
      route_type: "via",
      x: 10,
      y: 0,
      from_layer: "top",
      to_layer: "bottom",
      via_diameter: 0.3,
    },
    { route_type: "wire", x: 10, y: 0, layer: "bottom", width: 0.1 },
    { route_type: "wire", x: 11, y: 0, layer: "bottom", width: 0.1 },
  ]
  original.curvedSegments = original.curvedSegments?.map((i) => i + 3)
  const stripped = recoverAnytimeSkeleton(input([original]), [original])
    .traces[0]
  expect(length(original.route) - length(stripped.route)).toBeCloseTo(8, 7)
  expect(stripped.route.filter((p) => p.route_type === "via")).toEqual(
    original.route.filter((p) => p.route_type === "via"),
  )
  expect(stripped.route.slice(0, 3)).toEqual(original.route.slice(0, 3))
  expect(stripped.route.slice(-3)).toEqual(original.route.slice(-3))
  const corner = trace([
    { x: 0, y: 0 },
    { x: 0.1, y: 0.01 },
    { x: 0.15, y: 0.05 },
    { x: 0.16, y: 0.15 },
  ])
  expect(discoverAnytimeTuningBanks(input([corner]), [corner])).toEqual([])
})

test("cheap scratch shortcuts reach the longest boundary driver without routing or matching", () => {
  const small = trace(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
    "small",
  )
  const driver = trace(
    [
      { x: 0, y: 0 },
      { x: 1, y: -1 },
      { x: 4, y: -1 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ],
    "driver",
  )
  const traces = [small, driver],
    board = input(traces)
  board.buses = [
    { busId: "bus", connectionNames: ["small", "driver"], maxLengthSkew: 0.1 },
  ]
  expect(skeletonDriverPriorities(board, traces)[0]).toBe(1)
  const first = skeletonShortcutCandidates(board, traces, {
    maxCandidates: 1,
  }).next().value!
  expect(first).toBeDefined()
  expect(first[0]).toEqual(small)
  expect(length(first[1].route)).toBeCloseTo(10, 7)
  expect(length(first[1].route)).toBeLessThan(length(driver.route))
  expect(first[1].route[0]).toEqual(driver.route[0])
  expect(first[1].route.at(-1)).toEqual(driver.route.at(-1))
  expect(traces[1]).toEqual(driver)
})

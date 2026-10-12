import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import * as grid from "../lib/grid-visibility"
import * as normalize from "../lib/normalize-surface-carriers"
import {
  finalizeCarrierArcPair,
  type CarrierShapeCandidate,
  type CarrierShapeWorkCache,
} from "../lib/finalize-carrier-arc-pair"
import {
  pruneCandidateDomains,
  type CandidateDomainFailure,
} from "../lib/prune-candidate-domains"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { routeCopper } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const trace = (name: string, points: number[][]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  route: points.map(([x, y]) => ({
    route_type: "wire",
    x,
    y,
    layer: "bottom",
    width: 0.1,
  })),
})
const candidate = (body: Trace): CarrierShapeCandidate => ({
  connection: {
    name: body.connection_name!,
    pointsToConnect: [body.route[0], body.route.at(-1)!].map((point) => ({
      x: point.x,
      y: point.y,
      layer: "bottom",
    })),
  },
  layer: "bottom",
  trace: body,
  escapes: [],
  escapeCopper: [],
  maxLength: Infinity,
})
const inputFor = (domains: CarrierShapeCandidate[][]): SimpleRouteJson => ({
  layerCount: 4,
  allowedLayers: ["top", "bottom"],
  minTraceWidth: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  minBoardEdgeClearance: 0.1,
  bounds: { minX: -2, maxX: 6, minY: -2, maxY: 6 },
  obstacles: [],
  connections: domains.map((bank) => structuredClone(bank[0].connection)),
})
const compatible = (a: CarrierShapeCandidate, b: CarrierShapeCandidate) =>
  !new CopperConflictIndex().firstConflict(
    [...a.escapeCopper, ...routeCopper(a.trace)],
    [...b.escapeCopper, ...routeCopper(b.trace)],
    0.1 - 1e-8,
  )
const contradiction = (domains: CarrierShapeCandidate[][]) => {
  const failures: CandidateDomainFailure[] = []
  expect(
    pruneCandidateDomains(domains, compatible, 1_000_000, (failure) =>
      failures.push(failure),
    ),
  ).toBeNull()
  expect(failures).toHaveLength(1)
  return failures[0]
}
const toy = () => {
  const domains = [
    [
      candidate(
        trace("A", [
          [0, 0],
          [3, 0],
          [3, 3],
        ]),
      ),
    ],
    [
      candidate(
        trace("B", [
          [2.95, 0.05],
          [2.95, 1],
        ]),
      ),
    ],
  ]
  return { native: inputFor(domains), domains, failure: contradiction(domains) }
}
const causalToy = () => {
  const domains = [
    [
      candidate(
        trace("A", [
          [0, 0],
          [4, 0],
        ]),
      ),
    ],
    [
      candidate(
        trace("B", [
          [2, -1],
          [2, 1],
        ]),
      ),
      candidate(
        trace("B", [
          [0, 2],
          [3, 2],
          [3, 5],
        ]),
      ),
    ],
    [
      candidate(
        trace("C", [
          [2.95, 2.05],
          [2.95, 3],
        ]),
      ),
    ],
  ]
  return { native: inputFor(domains), domains, failure: contradiction(domains) }
}
const realGridPrototype = grid.GridVisibilitySearch.prototype
const callableGrid = grid as unknown as {
  GridVisibilitySearch: (...args: unknown[]) => grid.GridVisibilitySearch
}
let constructorGuard: ReturnType<
  typeof spyOn<typeof callableGrid, "GridVisibilitySearch">
>
let stepGuard: ReturnType<typeof spyOn<grid.GridVisibilitySearch, "step">>
let shaping: ReturnType<
  typeof spyOn<typeof normalize, "normalizeSurfaceCarriers">
>
const realNormalize = normalize.normalizeSurfaceCarriers
beforeEach(() => {
  constructorGuard = spyOn(
    callableGrid,
    "GridVisibilitySearch",
  ).mockImplementation(() => {
    throw Error("Pure V2 finalization must never construct Grid")
  })
  stepGuard = spyOn(realGridPrototype, "step").mockImplementation(() => {
    throw Error("Pure V2 finalization must never advance Grid")
  })
  shaping = spyOn(normalize, "normalizeSurfaceCarriers").mockImplementation(
    realNormalize,
  )
})
afterEach(() => {
  expect(constructorGuard).not.toHaveBeenCalled()
  expect(stepGuard).not.toHaveBeenCalled()
  shaping.mockRestore()
  stepGuard.mockRestore()
  constructorGuard.mockRestore()
})

test("negative work progresses through every actual removed/support combination, one per call", () => {
  const domains = [
    [
      candidate(
        trace("A", [
          [0, 0],
          [4, 0],
        ]),
      ),
      candidate(
        trace("A", [
          [0, 0],
          [3, 0],
          [3, 3],
        ]),
      ),
    ],
    [
      candidate(
        trace("B", [
          [2, -1],
          [2, 2.2],
        ]),
      ),
      candidate(
        trace("B", [
          [2.95, 0.05],
          [2.95, 1],
        ]),
      ),
    ],
  ]
  const native = inputFor(domains)
  const failure = contradiction(domains)
  expect(failure.implicatedRemovals).toHaveLength(1)
  expect(failure.implicatedRemovals[0].removed).toEqual([0, 1])
  expect(failure.implicatedRemovals[0].support).toEqual([0, 1])
  const before = structuredClone({ native, domains, failure })
  const work: CarrierShapeWorkCache = new Map()
  for (let offer = 0; offer < 3; offer++) {
    expect(finalizeCarrierArcPair(native, [], domains, failure, work)).toEqual(
      [],
    )
    expect(work.size).toBe(offer + 1)
    expect(shaping).toHaveBeenCalledTimes(offer + 1)
    expect([...work.values()].every((value) => value === null)).toBe(true)
  }
  const fourth = finalizeCarrierArcPair(native, [], domains, failure, work)
  expect(fourth).toHaveLength(2)
  expect(fourth[0].original).toBe(domains[0][1])
  expect(fourth[1].original).toBe(domains[1][1])
  expect(work.size).toBe(4)
  expect(shaping).toHaveBeenCalledTimes(4)
  expect(
    compatible(
      { ...fourth[0].original, trace: fourth[0].trace },
      { ...fourth[1].original, trace: fourth[1].trace },
    ),
  ).toBe(true)
  expect({ native, domains, failure }).toEqual(before)
})

test("real implicated rows keep chronological policy, including an earlier negative pair", () => {
  const { native, domains, failure } = causalToy()
  expect(failure.removals).toEqual([
    { first: 1, second: 0, removed: [0], support: [0] },
    { first: 1, second: 2, removed: [1], support: [0] },
  ])
  expect(failure.implicatedRemovals).toEqual(failure.removals)
  const before = structuredClone({ native, domains, failure })
  const work: CarrierShapeWorkCache = new Map()
  expect(finalizeCarrierArcPair(native, [], domains, failure, work)).toEqual([])
  expect(shaping).toHaveBeenCalledTimes(1)
  expect(work.size).toBe(1)
  const second = finalizeCarrierArcPair(native, [], domains, failure, work)
  expect(second).toHaveLength(2)
  expect(second[0].original).toBe(domains[1][1])
  expect(second[1].original).toBe(domains[2][0])
  expect(shaping).toHaveBeenCalledTimes(2)
  expect(work.size).toBe(2)
  expect({ native, domains, failure }).toEqual(before)
})

test("complete 48-entry banks retain original indices beyond a prefix", () => {
  const domains = [
    Array.from({ length: 48 }, (_, index) =>
      candidate(
        trace("A", [
          [0, 0],
          [1 + index * 0.001, 0],
          [4, 0],
        ]),
      ),
    ),
    Array.from({ length: 48 }, (_, index) =>
      candidate(
        trace("B", [
          [2 + index * 0.0001, -1],
          [2 + index * 0.0001, 1],
        ]),
      ),
    ),
  ]
  const native = inputFor(domains)
  const failure = contradiction(domains)
  expect(failure.implicatedRemovals[0].removed).toHaveLength(48)
  expect(failure.implicatedRemovals[0].support).toHaveLength(48)
  const before = structuredClone({ native, domains, failure })
  const work: CarrierShapeWorkCache = new Map()
  for (let offer = 0; offer < 49; offer++) {
    expect(finalizeCarrierArcPair(native, [], domains, failure, work)).toEqual(
      [],
    )
    expect(work.size).toBe(offer + 1)
    expect(shaping).toHaveBeenCalledTimes(offer + 1)
    const pair = shaping.mock.calls[offer][1]
    expect(pair[0]).toEqual(domains[0][Math.floor(offer / 48)].trace)
    expect(pair[1]).toEqual(domains[1][offer % 48].trace)
    expect(pair).toHaveLength(2)
    const pairKey = [...work.keys()].at(-1)!
    expect(pairKey.includes('"bounds"')).toBe(false)
    expect(pairKey.includes('"minTraceWidth"')).toBe(false)
  }
  expect({ native, domains, failure }).toEqual(before)
  const tooLarge = [domains[0].concat(domains[0][0]), domains[1]]
  const fresh: CarrierShapeWorkCache = new Map()
  expect(finalizeCarrierArcPair(native, [], tooLarge, failure, fresh)).toEqual(
    [],
  )
  expect(fresh.size).toBe(0)
  expect(shaping).toHaveBeenCalledTimes(49)
})

test("an active positive is skipped, an evicted positive reoffers detached bodies at current refs", () => {
  const initial = toy()
  const c = candidate(
    trace("C", [
      [1.5, 1.3],
      [1.5, 1.7],
    ]),
  )
  const domains = [...initial.domains, [c]]
  const native = inputFor(domains)
  const failure = contradiction(domains)
  const work: CarrierShapeWorkCache = new Map()
  const first = finalizeCarrierArcPair(native, [], domains, failure, work)
  expect(first).toHaveLength(2)
  const pristine = structuredClone(first.map(({ trace: body }) => body))
  const active = { ...domains[0][0], trace: structuredClone(first[0].trace) }
  const activeDomains = [[domains[0][0], active], domains[1], domains[2]]
  const activeFailure = contradiction(activeDomains)
  expect(activeFailure.implicatedRemovals).toHaveLength(2)
  first[0].trace.route[0].x = 100
  expect(
    finalizeCarrierArcPair(native, [], activeDomains, activeFailure, work),
  ).toEqual([])
  expect(work.size).toBe(2)
  expect(shaping).toHaveBeenCalledTimes(2)
  // Actual AC on the post-eviction bank gives the original raw pair again.
  const copies = structuredClone(domains)
  const evictedFailure = contradiction(copies)
  const reoffer = finalizeCarrierArcPair(
    native,
    [],
    copies,
    evictedFailure,
    work,
  )
  expect(reoffer).toHaveLength(2)
  expect(reoffer[0].original).toBe(copies[0][0])
  expect(reoffer[1].original).toBe(copies[1][0])
  expect(reoffer.map(({ trace: body }) => body)).toEqual(pristine)
  expect(shaping).toHaveBeenCalledTimes(2)
  expect(work.size).toBe(2)
  reoffer[0].trace.route[0].x = 200
  const again = finalizeCarrierArcPair(native, [], copies, evictedFailure, work)
  expect(again.map(({ trace: body }) => body)).toEqual(pristine)
  expect(again[0].trace.route).not.toBe(reoffer[0].trace.route)
  expect(again[0].trace.route[0]).not.toBe(reoffer[0].trace.route[0])
  expect(shaping).toHaveBeenCalledTimes(2)
  expect(work.size).toBe(2)
})

test("same-reference native mutation clears all work and rejects a stale physical success", () => {
  const { native, domains, failure } = toy()
  const work: CarrierShapeWorkCache = new Map()
  expect(
    finalizeCarrierArcPair(native, [], domains, failure, work),
  ).toHaveLength(2)
  const originalPositive = [...work.values()][0]
  const otherPair = structuredClone(domains)
  otherPair[0][0].maxLength = 30
  expect(
    finalizeCarrierArcPair(native, [], otherPair, failure, work),
  ).toHaveLength(2)
  expect(work.size).toBe(2)
  native.obstacles.push({
    center: { x: 1.5, y: 1.5 },
    shape: "circle",
    width: 0.6,
    height: 0.6,
    layers: ["bottom"],
    connectedTo: ["POWER"],
  })
  expect(finalizeCarrierArcPair(native, [], domains, failure, work)).toEqual([])
  expect(work.size).toBe(1)
  expect([...work.values()]).toEqual([null])
  expect([...work.values()][0]).not.toBe(originalPositive)
  expect(shaping).toHaveBeenCalledTimes(3)
  native.obstacles[0].center.x = -1
  native.obstacles[0].center.y = -1
  expect(
    finalizeCarrierArcPair(native, [], domains, failure, work),
  ).toHaveLength(2)
  expect(work.size).toBe(1)
  expect(shaping).toHaveBeenCalledTimes(4)
})

test("same-reference fixed copper mutation resets the sole physical context", () => {
  const { native, domains, failure } = toy()
  const fixed: Trace[] = []
  const work: CarrierShapeWorkCache = new Map()
  expect(
    finalizeCarrierArcPair(native, fixed, domains, failure, work),
  ).toHaveLength(2)
  fixed.push(
    trace("POWER", [
      [1.3, 1.3],
      [1.7, 1.7],
    ]),
  )
  expect(finalizeCarrierArcPair(native, fixed, domains, failure, work)).toEqual(
    [],
  )
  expect(work.size).toBe(1)
  expect([...work.values()]).toEqual([null])
  fixed[0].route[0].x = -1
  fixed[0].route[0].y = -1
  fixed[0].route[1].x = 1
  fixed[0].route[1].y = -1
  expect(
    finalizeCarrierArcPair(native, fixed, domains, failure, work),
  ).toHaveLength(2)
  expect(work.size).toBe(1)
  expect(shaping).toHaveBeenCalledTimes(3)
})

test("Infinity and invalid numeric bounds have distinct keys and cannot poison a positive body", () => {
  const { native, domains, failure } = toy()
  const work: CarrierShapeWorkCache = new Map()
  const first = finalizeCarrierArcPair(native, [], domains, failure, work)
  expect(first).toHaveLength(2)
  const positiveKey = [...work.keys()][0]
  const saved = structuredClone(work.get(positiveKey))
  const invalid = structuredClone(domains)
  invalid[0][0].maxLength = NaN
  expect(finalizeCarrierArcPair(native, [], invalid, failure, work)).toEqual([])
  expect(work.size).toBe(2)
  expect(work.get(positiveKey)).toEqual(saved)
  expect([...work.keys()][1]).not.toBe(positiveKey)
  expect(shaping).toHaveBeenCalledTimes(1)
  const reoffer = finalizeCarrierArcPair(native, [], domains, failure, work)
  expect(reoffer).toHaveLength(2)
  expect(reoffer[0].original).toBe(domains[0][0])
  expect(work.get(positiveKey)).toEqual(saved)
  expect(shaping).toHaveBeenCalledTimes(1)
})

test("an ineligible malformed site consumes one offer without starving the next valid pair", () => {
  const initial = toy()
  const invalid = structuredClone(initial.domains[0][0])
  invalid.connection.pointsToConnect[0].x = NaN
  const domains = [[invalid, initial.domains[0][0]], initial.domains[1]]
  const failure = contradiction(domains)
  const work: CarrierShapeWorkCache = new Map()
  expect(
    finalizeCarrierArcPair(initial.native, [], domains, failure, work),
  ).toEqual([])
  expect(work.size).toBe(1)
  expect(shaping).not.toHaveBeenCalled()
  const next = finalizeCarrierArcPair(
    initial.native,
    [],
    domains,
    failure,
    work,
  )
  expect(next).toHaveLength(2)
  expect(next[0].original).toBe(initial.domains[0][0])
  expect(next[1].original).toBe(initial.domains[1][0])
  expect(work.size).toBe(2)
  expect(shaping).toHaveBeenCalledTimes(1)
})

test("malformed chronological certificates cannot create or advance pair work", () => {
  const { native, domains, failure } = causalToy()
  const reverse = structuredClone(failure)
  reverse.implicatedRemovals.reverse()
  const duplicateRemoval = structuredClone(failure)
  duplicateRemoval.removals[1].removed = [0]
  duplicateRemoval.implicatedRemovals = structuredClone(
    duplicateRemoval.removals,
  )
  const unrelatedRow = structuredClone(failure)
  unrelatedRow.implicatedRemovals[0].support = [1]
  for (const invalid of [reverse, duplicateRemoval, unrelatedRow]) {
    const work: CarrierShapeWorkCache = new Map()
    expect(finalizeCarrierArcPair(native, [], domains, invalid, work)).toEqual(
      [],
    )
    expect(work.size).toBe(0)
  }
  expect(shaping).not.toHaveBeenCalled()
})

test("same native object distinguishes nonfinite values, signed zero, null, undefined, and literal markers", () => {
  const { native, domains, failure } = toy()
  native.buses = [{ busId: "unrelated", connectionNames: [] }]
  const policy = native.buses[0] as unknown as Record<string, unknown>
  const work: CarrierShapeWorkCache = new Map()
  const values: unknown[] = [
    Infinity,
    NaN,
    null,
    undefined,
    0,
    -0,
    "Infinity",
    ["number", "Infinity"],
  ]
  for (const [index, value] of values.entries()) {
    policy.maxLength = value
    expect(
      finalizeCarrierArcPair(native, [], domains, failure, work),
    ).toHaveLength(2)
    expect(work.has("old-context-sentinel")).toBe(false)
    expect(work.size).toBe(1)
    expect(shaping).toHaveBeenCalledTimes(index + 1)
    work.set("old-context-sentinel", null)
  }
  policy.maxLength = undefined
  expect(
    finalizeCarrierArcPair(native, [], domains, failure, work),
  ).toHaveLength(2)
  work.set("old-context-sentinel", null)
  delete policy.maxLength
  expect(
    finalizeCarrierArcPair(native, [], domains, failure, work),
  ).toHaveLength(2)
  expect(work.has("old-context-sentinel")).toBe(false)
  expect(work.size).toBe(1)
  expect(shaping).toHaveBeenCalledTimes(values.length + 2)
})

test("fixed metadata mutations cannot alias undefined, null, nonfinite values, or marker arrays", () => {
  const { native, domains, failure } = toy()
  const fixed = [
    trace("POWER", [
      [-1, -1],
      [1, -1],
    ]),
  ]
  const metadata = fixed[0] as unknown as Record<string, unknown>
  const work: CarrierShapeWorkCache = new Map()
  const values: unknown[] = [
    [Infinity],
    [NaN],
    null,
    undefined,
    [0],
    [-0],
    ["number", "Infinity"],
  ]
  for (const [index, value] of values.entries()) {
    metadata.curvedSegments = value
    expect(
      finalizeCarrierArcPair(native, fixed, domains, failure, work),
    ).toHaveLength(2)
    expect(work.has("old-fixed-context-sentinel")).toBe(false)
    expect(work.size).toBe(1)
    expect(shaping).toHaveBeenCalledTimes(index + 1)
    work.set("old-fixed-context-sentinel", null)
  }
})

test("sparse array lengths and holes invalidate context separately from explicit undefined", () => {
  const { native, domains, failure } = toy()
  native.buses = [{ busId: "unrelated-sparse-context", connectionNames: [] }]
  const policy = native.buses[0] as unknown as Record<string, unknown>
  const work: CarrierShapeWorkCache = new Map()
  const values: unknown[] = [
    [],
    new Array(1),
    [undefined],
    new Array(2),
    [undefined, undefined],
    ["hole"],
    ["array", "hole"],
  ]
  for (const [index, value] of values.entries()) {
    policy.maxLength = value
    expect(
      finalizeCarrierArcPair(native, [], domains, failure, work),
    ).toHaveLength(2)
    expect(work.has("stale-sparse-context")).toBe(false)
    expect(work.size).toBe(1)
    expect(shaping).toHaveBeenCalledTimes(index + 1)
    work.set("stale-sparse-context", null)
  }
  // Deleting one element changes a dense array into a sparse array without
  // changing object identity or length; the old positive must be discarded.
  const sameArray: unknown[] = [undefined, undefined]
  policy.maxLength = sameArray
  expect(
    finalizeCarrierArcPair(native, [], domains, failure, work),
  ).toHaveLength(2)
  work.set("stale-sparse-context", null)
  delete sameArray[1]
  expect(
    finalizeCarrierArcPair(native, [], domains, failure, work),
  ).toHaveLength(2)
  expect(work.has("stale-sparse-context")).toBe(false)
  expect(work.size).toBe(1)
  expect(shaping).toHaveBeenCalledTimes(values.length + 2)
})

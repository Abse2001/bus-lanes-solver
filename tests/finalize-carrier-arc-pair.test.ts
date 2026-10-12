import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import * as grid from "../lib/grid-visibility"
import * as reduce from "../lib/reduce-ordinary-turns"
import * as chamfer from "../lib/chamfer-ordinary-corners"
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
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { boardOutlineViolations } from "../lib/board-outline"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const trace = (name: string, points: number[][], layer = "bottom"): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  route: points.map(([x, y]) => ({
    route_type: "wire",
    x,
    y,
    layer,
    width: 0.1,
  })),
})
const candidate = (body: Trace): CarrierShapeCandidate => ({
  connection: {
    name: body.connection_name!,
    pointsToConnect: [body.route[0], body.route.at(-1)!].map((point) => ({
      x: point.x,
      y: point.y,
      layer: (point as Wire).layer,
    })),
  },
  layer: (body.route[0] as Wire).layer,
  trace: body,
  escapes: [],
  escapeCopper: [],
  maxLength: 30,
})
const inputFor = (domains: CarrierShapeCandidate[][]): SimpleRouteJson => ({
  layerCount: 4,
  allowedLayers: ["top", "bottom"],
  minTraceWidth: 0.1,
  minTraceToPadEdgeClearance: 0.1,
  minBoardEdgeClearance: 0.1,
  bounds: { minX: -2, maxX: 5, minY: -2, maxY: 5 },
  obstacles: [],
  connections: domains.map((bank) => structuredClone(bank[0].connection)),
})
const compatible = (
  first: CarrierShapeCandidate,
  second: CarrierShapeCandidate,
) =>
  !new CopperConflictIndex().firstConflict(
    [...first.escapeCopper, ...routeCopper(first.trace)],
    [...second.escapeCopper, ...routeCopper(second.trace)],
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
const toy = (layer = "bottom") => {
  // A's avoidable right-angle detour collides with B. Its direct diagonal
  // clears B, so deterministic shortening can repair this supplied pair.
  const domains = [
    [
      candidate(
        trace(
          "A",
          [
            [0, 0],
            [3, 0],
            [3, 3],
          ],
          layer,
        ),
      ),
    ],
    [
      candidate(
        trace(
          "B",
          [
            [2.95, 0.05],
            [2.95, 1],
          ],
          layer,
        ),
      ),
    ],
  ]
  return { domains, native: inputFor(domains), failure: contradiction(domains) }
}

const realGridPrototype = grid.GridVisibilitySearch.prototype
// Bun spies on class exports at runtime; its spy type only accepts callable
// signatures, so describe the same export as a callable for this fail guard.
const callableGrid = grid as unknown as {
  GridVisibilitySearch: (...args: unknown[]) => grid.GridVisibilitySearch
}
let constructorGuard: ReturnType<
  typeof spyOn<typeof callableGrid, "GridVisibilitySearch">
>
let stepGuard: ReturnType<typeof spyOn<grid.GridVisibilitySearch, "step">>
beforeEach(() => {
  constructorGuard = spyOn(
    callableGrid,
    "GridVisibilitySearch",
  ).mockImplementation(() => {
    throw Error("Pure carrier finalization must never construct Grid")
  })
  stepGuard = spyOn(realGridPrototype, "step").mockImplementation(() => {
    throw Error("Pure carrier finalization must never advance Grid")
  })
})
afterEach(() => {
  expect(constructorGuard).not.toHaveBeenCalled()
  expect(stepGuard).not.toHaveBeenCalled()
  stepGuard.mockRestore()
  constructorGuard.mockRestore()
})

test("an actual finite AC contradiction becomes two clear bodies at the original sites", () => {
  const { native, domains, failure } = toy()
  const before = structuredClone({ native, domains, failure })
  const work: CarrierShapeWorkCache = new Map()
  const result = finalizeCarrierArcPair(native, [], domains, failure, work)
  expect(result).toHaveLength(2)
  const bodies = result.map(({ trace: body }) => body)
  for (const [index, shaped] of result.entries()) {
    expect(shaped.original).toBe(domains[index][0])
    expect(shaped.trace).not.toBe(shaped.original.trace)
    expect(shaped.trace.route[0]).toEqual(shaped.original.trace.route[0])
    expect(shaped.trace.route.at(-1)).toEqual(
      shaped.original.trace.route.at(-1),
    )
    expect(length(shaped.trace.route)).toBeLessThanOrEqual(
      shaped.original.maxLength,
    )
    expect(
      shaped.trace.route.every(
        (point) =>
          point.route_type === "wire" &&
          point.layer === "bottom" &&
          point.width === 0.1,
      ),
    ).toBe(true)
    expect(
      new VectorScene(
        native,
        shaped.original.connection,
        0.1,
        fixedCopper(native),
      ).pathVisible(shaped.trace.route),
    ).toBe(true)
  }
  expect(length(bodies[0].route)).toBeLessThan(
    length(domains[0][0].trace.route),
  )
  expect(
    compatible(
      { ...domains[0][0], trace: bodies[0] },
      { ...domains[1][0], trace: bodies[1] },
    ),
  ).toBe(true)
  expect(
    pruneCandidateDomains(
      result.map(({ original, trace: body }) => [{ ...original, trace: body }]),
      compatible,
    ),
  ).not.toBeNull()
  expect(routeAnglesAreConventional(bodies)).toBe(true)
  expect(boardOutlineViolations(native, bodies)).toEqual([])
  const drc = validateRoutedCopperDrc({
    inputSrj: native,
    routedSrj: { ...native, traces: bodies },
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.valid).toBe(true)
  expect(drc.issues).toEqual([])
  expect({ native, domains, failure }).toEqual(before)
  expect(work.size).toBe(1)
  expect([...work.values()][0]).not.toBeNull()
})

test("missing or malformed finite callback metadata yields no shaping work", () => {
  const { native, domains, failure } = toy()
  const malformed: unknown[] = [
    undefined,
    null,
    {},
    { ...failure, removals: {} },
    { ...failure, removals: [{}], implicatedRemovals: [{}] },
    { ...failure, removals: [{ ...failure.removals[0], removed: null }] },
    { ...failure, removals: [{ ...failure.removals[0], support: null }] },
    { ...failure, emptyDomain: 2 },
    { ...failure, unsupportedBy: 0 },
    { ...failure, implicatedRemovals: [] },
    { ...failure, removals: [{ ...failure.removals[0], removed: [-1] }] },
    { ...failure, removals: [{ ...failure.removals[0], support: [Infinity] }] },
  ]
  for (const metadata of malformed) {
    const work: CarrierShapeWorkCache = new Map()
    expect(
      finalizeCarrierArcPair(
        native,
        [],
        domains,
        metadata as CandidateDomainFailure,
        work,
      ),
    ).toEqual([])
    expect(work.size).toBe(0)
  }
})

test("only the first final-row removed/support pair is shaped, without fallback", () => {
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
          [2, 1],
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
  expect(failure.removals.at(-1)!.removed).toEqual([0, 1])
  expect(failure.removals.at(-1)!.support).toEqual([0, 1])
  const before = structuredClone({ native, domains, failure })
  const work: CarrierShapeWorkCache = new Map()
  expect(finalizeCarrierArcPair(native, [], domains, failure, work)).toEqual([])
  expect(work.size).toBe(1)
  expect([...work.values()]).toEqual([null])
  // The later pair has a real positive witness, but is outside this offer.
  const later = [[domains[0][1]], [domains[1][1]]]
  expect(
    finalizeCarrierArcPair(
      inputFor(later),
      [],
      later,
      contradiction(later),
      new Map(),
    ),
  ).toHaveLength(2)
  expect({ native, domains, failure }).toEqual(before)
})

test("paired and shared physical owners are excluded, while omitted IDs are harmless", () => {
  for (const shared of [false, true]) {
    const { native, domains, failure } = toy()
    if (shared) {
      domains[0][0].connection.source_trace_id = "shared"
      domains[1][0].connection.source_trace_id = "shared"
    } else {
      native.differentialPairs = [
        { connectionNames: ["A", "B"], lengthTolerance: 0.1 },
      ]
    }
    const work: CarrierShapeWorkCache = new Map()
    expect(finalizeCarrierArcPair(native, [], domains, failure, work)).toEqual(
      [],
    )
    expect(work.size).toBe(1)
  }
  const { native, domains, failure } = toy()
  domains[0][0].connection.source_trace_id = ""
  domains[1][0].connection.source_trace_id = ""
  expect(
    finalizeCarrierArcPair(native, [], domains, failure, new Map()),
  ).toHaveLength(2)
})

test("width, layer, site, annotation, finite geometry, and length guards reject invalid offers", () => {
  const changes: Array<
    (native: SimpleRouteJson, domains: CarrierShapeCandidate[][]) => void
  > = [
    (_native, domains) => {
      ;(domains[0][0].trace.route[1] as Wire).width = 0.2
    },
    (native) => {
      native.allowedLayers = ["top"]
    },
    (_native, domains) => {
      domains[0][0].connection.pointsToConnect[0].x += 0.1
    },
    (_native, domains) => {
      domains[0][0].trace.curvedSegments = [1]
    },
    (_native, domains) => {
      domains[0][0].trace.coupledSection = [0, 2]
    },
    (_native, domains) => {
      domains[0][0].trace.route[1].x = NaN
    },
    (_native, domains) => {
      domains[0][0].maxLength = NaN
    },
    (_native, domains) => {
      domains[0][0].maxLength = -1
    },
    (_native, domains) => {
      domains[0][0].maxLength = 2
    },
    (native) => {
      native.bounds.maxX = 2
    },
  ]
  for (const change of changes) {
    const { native, domains, failure } = toy()
    change(native, domains)
    const before = structuredClone({ native, domains, failure })
    expect(
      finalizeCarrierArcPair(native, [], domains, failure, new Map()),
    ).toEqual([])
    expect({ native, domains, failure }).toEqual(before)
  }
})

test("the 128 raw-vertex limit is total across both bodies", () => {
  const dense = (count: number) => {
    const { native, domains, failure } = toy()
    const first = Math.floor(count / 2)
    domains[0][0].trace.route = [
      ...Array.from({ length: first }, (_, index) => ({
        route_type: "wire" as const,
        x: (3 * index) / (first - 1),
        y: 0,
        layer: "bottom",
        width: 0.1,
      })),
      ...Array.from({ length: count - first }, (_, index) => ({
        route_type: "wire" as const,
        x: 3,
        y: (3 * (index + 1)) / (count - first),
        layer: "bottom",
        width: 0.1,
      })),
    ]
    return { native, domains, failure }
  }
  const within = dense(126)
  expect(
    within.domains
      .flat()
      .reduce((sum, item) => sum + item.trace.route.length, 0),
  ).toBe(128)
  expect(
    finalizeCarrierArcPair(
      within.native,
      [],
      within.domains,
      within.failure,
      new Map(),
    ),
  ).toHaveLength(2)
  const over = dense(127)
  const work: CarrierShapeWorkCache = new Map()
  expect(
    finalizeCarrierArcPair(over.native, [], over.domains, over.failure, work),
  ).toEqual([])
  expect(work.size).toBe(1)
})

test("unclear straight crossings receive at most three real shaping passes and no new infeasibility event", () => {
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
    ],
  ]
  const native = inputFor(domains)
  const failure = contradiction(domains)
  const before = structuredClone({ native, domains, failure })
  const realReduce = reduce.reduceOrdinaryTurns
  const realChamfer = chamfer.chamferOrdinaryCorners
  const shorten = spyOn(reduce, "reduceOrdinaryTurns").mockImplementation(
    realReduce,
  )
  const bevel = spyOn(chamfer, "chamferOrdinaryCorners").mockImplementation(
    realChamfer,
  )
  try {
    const work: CarrierShapeWorkCache = new Map()
    expect(finalizeCarrierArcPair(native, [], domains, failure, work)).toEqual(
      [],
    )
    expect(shorten).toHaveBeenCalledTimes(6)
    expect(bevel).toHaveBeenCalledTimes(3)
    expect([...work.values()]).toEqual([null])
    // Repeating bounded shaping work neither repeats shaping nor rewrites
    // the actual original AC certificate into a wider feasibility claim.
    expect(finalizeCarrierArcPair(native, [], domains, failure, work)).toEqual(
      [],
    )
    expect(shorten).toHaveBeenCalledTimes(6)
    expect(bevel).toHaveBeenCalledTimes(3)
    expect({ native, domains, failure }).toEqual(before)
  } finally {
    shorten.mockRestore()
    bevel.mockRestore()
  }
})

test("positive cached bodies are deep clones keyed by exact physical inputs", () => {
  const { native, domains, failure } = toy()
  const work: CarrierShapeWorkCache = new Map()
  const first = finalizeCarrierArcPair(native, [], domains, failure, work)
  expect(first).toHaveLength(2)
  const pristine = structuredClone(first.map((item) => item.trace))
  first[0].trace.route[0].x = 100
  const copies = structuredClone(domains)
  const second = finalizeCarrierArcPair(
    structuredClone(native),
    [],
    copies,
    structuredClone(failure),
    work,
  )
  expect(work.size).toBe(1)
  expect(second.map((item) => item.trace)).toEqual(pristine)
  expect(second[0].original).toBe(copies[0][0])
  expect(second[0].trace.route).not.toBe(first[0].trace.route)
  const key = [...work.keys()][0]
  const cached = work.get(key)!
  expect(second[0].trace.route).not.toBe(cached![0])
  second[0].trace.route[0].x = 200
  expect(work.get(key)).toEqual(
    pristine.map((body) => body.route) as [Wire[], Wire[]],
  )
  const bounds = structuredClone(native)
  bounds.bounds.maxX += 1
  expect(
    finalizeCarrierArcPair(bounds, [], domains, failure, work),
  ).toHaveLength(2)
  expect(work.size).toBe(1)
  const limited = structuredClone(domains)
  limited[0][0].maxLength -= 1
  expect(
    finalizeCarrierArcPair(native, [], limited, failure, work),
  ).toHaveLength(2)
  expect(work.size).toBe(1)
  const fixed = trace("VCC", [
    [-1, -1],
    [1, -1],
  ])
  expect(
    finalizeCarrierArcPair(native, [fixed], domains, failure, work),
  ).toHaveLength(2)
  expect(work.size).toBe(1)
})

test("Top surface escapes retain their exact sites and are never offered for absorption", () => {
  const { native, domains, failure } = toy("top")
  const a = domains[0][0]
  a.escapes = [
    trace(
      "A",
      [
        [-0.5, 0],
        [0, 0],
      ],
      "top",
    ),
    trace(
      "A",
      [
        [3, 3.5],
        [3, 3],
      ],
      "top",
    ),
  ]
  a.escapeCopper = a.escapes.flatMap(routeCopper)
  native.connections[0].pointsToConnect = [
    a.escapes[0].route[0],
    a.escapes[1].route[0],
  ] as Wire[]
  const before = structuredClone({ native, domains, failure })
  const realNormalize = normalize.normalizeSurfaceCarriers
  const supplied = spyOn(
    normalize,
    "normalizeSurfaceCarriers",
  ).mockImplementation(realNormalize)
  try {
    const result = finalizeCarrierArcPair(
      native,
      [],
      domains,
      failure,
      new Map(),
    )
    expect(result).toHaveLength(2)
    expect(supplied).toHaveBeenCalledTimes(1)
    expect(supplied.mock.calls[0][2]).toEqual([])
    expect(result[0].trace.route[0]).toEqual(a.trace.route[0])
    expect(result[0].trace.route.at(-1)).toEqual(a.trace.route.at(-1))
    const joined = joinSignalEscapes(result[0].trace, a.escapes)
    expect(joined.route[0]).toEqual(a.escapes[0].route[0])
    expect(joined.route.at(-1)).toEqual(a.escapes[1].route[0])
    expect(routeAnglesAreConventional([joined, result[1].trace])).toBe(true)
    expect({ native, domains, failure }).toEqual(before)
  } finally {
    supplied.mockRestore()
  }
})

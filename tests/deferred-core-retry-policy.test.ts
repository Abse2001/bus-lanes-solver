import { expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { generatedEscapeHolesConflict } from "../lib/expanded-signal-sites"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import {
  negotiateSignalSites,
  type DeferredCarrierExpansion,
  type SignalSiteDomainFailure,
} from "../lib/negotiate-signal-sites"
import * as siteNegotiator from "../lib/negotiate-signal-sites"
import * as pairPlanner from "../lib/plan-shared-pair-corridors"
import {
  pruneCandidateDomains,
  type CandidateDomainFailure,
} from "../lib/prune-candidate-domains"
import {
  routeFreshSurfaceSeeds,
  shouldRetryDeferredCarrierExpansion,
} from "../lib/route-fresh-surface-buses"
import { runBoundedRouting } from "../lib/run-bounded-routing"
import type { SimpleRouteJson } from "../lib/types"
import { fixedCopper } from "../lib/vector-scene"
import {
  guidanceWidth,
  propagatingCpuSiteConflictFixture,
} from "./selective-guidance-fixtures"

type OfferedSiteFailure = Extract<
  SignalSiteDomainFailure,
  { kind: "incompatible-offered-native-site-domains" }
>

/** Manufactured A/B/C escapes have a propagated contradiction. D is a real,
 * independent native domain, so skipping its expansion cannot repair that core. */
function physicalPropagationCertificate() {
  const { native, domains } = propagatingCpuSiteConflictFixture()
  native.bounds.maxX = 11.5
  native.connections.push({
    ...structuredClone(native.connections[0]),
    name: "D",
    pointsToConnect: native.connections[0].pointsToConnect.map((point) => ({
      ...point,
      x: point.x + 8,
    })),
  })
  native.obstacles.push(
    ...native.obstacles.slice(0, 2).map((obstacle) => ({
      ...structuredClone(obstacle),
      center: { ...obstacle.center, x: obstacle.center.x + 8 },
      connectedTo: ["D"],
    })),
  )
  const independentEscapes = domains[0].options[0].escapes.map((trace) => ({
    ...structuredClone(trace),
    pcb_trace_id: `${trace.pcb_trace_id}_independent_D`,
    connection_name: "D",
    source_trace_id: "D",
    route: trace.route.map((point) => ({ ...point, x: point.x + 8 })),
  }))
  domains.push({
    name: "D",
    options: [
      {
        escapes: independentEscapes,
        escapeCopper: fixedCopper({
          ...native,
          obstacles: [],
          traces: independentEscapes,
        }),
      },
    ],
  })
  const index = new CopperConflictIndex()
  const compatible = (
    a: (typeof domains)[number]["options"][number],
    b: (typeof domains)[number]["options"][number],
  ) =>
    !generatedEscapeHolesConflict(native, a.escapes, b.escapes) &&
    !index.firstConflict(a.escapeCopper, b.escapeCopper, guidanceWidth - 1e-8)
  const failures: CandidateDomainFailure[] = []
  const remaining = pruneCandidateDomains(
    domains.map((domain) => domain.options),
    compatible,
    1000000,
    (failure) => failures.push(failure),
  )
  if (remaining !== null || failures.length !== 1)
    throw new Error("The manufactured propagation fixture lost its certificate")
  const proof = failures[0]
  const names = [
    ...new Set(
      proof.implicatedRemovals.flatMap((removal) => [
        domains[removal.first].name,
        domains[removal.second].name,
      ]),
    ),
  ]
  const failure: OfferedSiteFailure = {
    kind: "incompatible-offered-native-site-domains",
    searchComplete: true,
    budgetUnknown: false,
    names,
    domains,
    proof: { kind: "arc-consistency", ...proof },
  }
  return { native, domains, compatible, failure }
}

test("only a complete physical contradiction disjoint from every deferred domain skips widening", () => {
  const { native, domains, compatible, failure } =
    physicalPropagationCertificate()
  const before = structuredClone({ native, domains, failure })
  for (const domain of domains)
    for (const option of domain.options) {
      const checked = validateRoutedCopperDrc({
        inputSrj: native,
        routedSrj: { ...native, traces: option.escapes },
        clearance: guidanceWidth,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0])
      expect(checked).toMatchObject({ valid: true, issues: [] })
      for (const escape of option.escapes)
        expect(
          escape.route.find((point) => point.route_type === "via"),
        ).toMatchObject({
          layers: ["top", "inner1", "inner2", "bottom"],
          via_diameter: 0.4572,
          via_hole_diameter: 0.254,
        })
    }
  for (const domain of domains.slice(0, 3))
    for (const option of domain.options)
      expect(compatible(option, domains[3].options[0])).toBe(true)
  expect([...failure.names].sort()).toEqual(["A", "B", "C"])
  expect(
    shouldRetryDeferredCarrierExpansion(failure, [
      { connectionName: "D", layer: "bottom" },
    ]),
  ).toBe(false)
  expect({ native, domains, failure }).toEqual(before)
})

test("an earlier physical support removal forces retry even when the last emptied arc is disjoint", () => {
  const { domains, failure } = physicalPropagationCertificate()
  const lastArcNames = [
    domains[failure.proof.emptyDomain].name,
    domains[failure.proof.unsupportedBy].name,
  ]
  expect(lastArcNames.sort()).toEqual(["B", "C"])
  expect(lastArcNames).not.toContain("A")
  expect(failure.proof.implicatedRemovals).toHaveLength(2)
  expect(failure.proof.implicatedRemovals[0]).toMatchObject({
    first: 1,
    second: 0,
    removed: [0],
    support: [0],
  })
  for (const connectionName of ["A", "B", "C"])
    expect(
      shouldRetryDeferredCarrierExpansion(failure, [
        { connectionName, layer: "bottom" },
      ]),
    ).toBe(true)
  expect(
    shouldRetryDeferredCarrierExpansion(failure, [
      { connectionName: "D", layer: "bottom" },
      { connectionName: "A", layer: "top" },
    ]),
  ).toBe(true)
})

test("missing legacy metadata and unknown, capped, carrier, or unary failures retain retry", () => {
  const { native, failure } = physicalPropagationCertificate()
  const deferred = [{ connectionName: "D", layer: "bottom" }]
  expect(shouldRetryDeferredCarrierExpansion(failure, undefined)).toBe(true)
  expect(shouldRetryDeferredCarrierExpansion(failure, [])).toBe(true)
  expect(shouldRetryDeferredCarrierExpansion(undefined, deferred)).toBe(true)
  const unary: SignalSiteDomainFailure = {
    kind: "empty-native-site-domain",
    connection: native.connections[0],
    searchComplete: true,
    budgetUnknown: false,
  }
  expect(shouldRetryDeferredCarrierExpansion(unary, deferred)).toBe(true)
  for (const changes of [
    { searchComplete: false, budgetUnknown: true },
    { searchComplete: false, budgetUnknown: false },
    { searchComplete: true, budgetUnknown: true },
    { proof: { ...failure.proof, kind: "carrier-pool" } },
    { kind: "carrier-search-budget-exhausted" },
  ])
    expect(
      shouldRetryDeferredCarrierExpansion(
        { ...failure, ...changes } as SignalSiteDomainFailure,
        deferred,
      ),
    ).toBe(true)
})

test("incomplete or malformed causal closure never certifies a disjoint deferred domain", () => {
  const { failure } = physicalPropagationCertificate()
  const deferred = [{ connectionName: "D", layer: "bottom" }]
  const variants: Array<[string, (copy: OfferedSiteFailure) => void]> = [
    [
      "missing declared core name",
      (copy) => {
        copy.names = ["B", "C"]
      },
    ],
    [
      "empty declared names",
      (copy) => {
        copy.names = []
      },
    ],
    [
      "unknown declared name",
      (copy) => {
        copy.names.push("unknown")
      },
    ],
    [
      "missing prior causal removal",
      (copy) => {
        copy.proof.implicatedRemovals = [copy.proof.removals[1]]
      },
    ],
    [
      "empty implicated removals",
      (copy) => {
        copy.proof.implicatedRemovals = []
      },
    ],
    [
      "missing removal history",
      (copy) => {
        copy.proof.removals = []
      },
    ],
    [
      "invalid emptied domain index",
      (copy) => {
        copy.proof.emptyDomain = copy.domains.length
      },
    ],
    [
      "invalid supporting domain index",
      (copy) => {
        copy.proof.unsupportedBy = -1
      },
    ],
    [
      "invalid removed option index",
      (copy) => {
        copy.proof.removals[0].removed = [99]
      },
    ],
    [
      "invalid supporting option index",
      (copy) => {
        copy.proof.removals[0].support = [99]
      },
    ],
    [
      "empty offered domain",
      (copy) => {
        copy.domains[0].options = []
      },
    ],
    [
      "duplicate offered domain name",
      (copy) => {
        copy.domains[3].name = "A"
      },
    ],
  ]
  for (const [description, mutate] of variants) {
    const copy = structuredClone(failure)
    mutate(copy)
    expect(
      shouldRetryDeferredCarrierExpansion(copy, deferred),
      description,
    ).toBe(true)
  }
})

test("incomplete or malformed deferral metadata retains the bounded retry", () => {
  const { failure } = physicalPropagationCertificate()
  for (const deferred of [
    [{ connectionName: "", layer: "bottom" }],
    [{ connectionName: "unknown", layer: "bottom" }],
    [{ connectionName: "D", layer: "" }],
    [{ connectionName: "D" }],
    [{ layer: "bottom" }],
    [{ connectionName: null, layer: "bottom" }],
    [{ connectionName: "D", layer: null }],
  ])
    expect(
      shouldRetryDeferredCarrierExpansion(
        failure,
        deferred as unknown as DeferredCarrierExpansion[],
      ),
    ).toBe(true)
})

test("the fresh caller skips only certified disjoint retries and preserves legacy noargument feedback", () => {
  const { native, failure } = physicalPropagationCertificate()
  native.buses = [
    {
      busId: "native_data",
      connectionNames: native.connections.map((connection) => connection.name),
      maxLengthSkew: 0.635,
    },
  ]
  const before = structuredClone({ native, failure })
  const cases: Array<{
    name: string
    metadata?: readonly DeferredCarrierExpansion[]
    failure: OfferedSiteFailure
    expectedCalls: Array<boolean | undefined>
  }> = [
    {
      name: "completed disjoint certificate",
      metadata: [{ connectionName: "D", layer: "bottom" }],
      failure,
      expectedCalls: [true],
    },
    {
      name: "legacy noargument callback",
      failure,
      expectedCalls: [true, undefined],
    },
    {
      name: "earlier causal core intersection",
      metadata: [{ connectionName: "A", layer: "bottom" }],
      failure,
      expectedCalls: [true, undefined],
    },
    {
      name: "unknown contributing site search",
      metadata: [{ connectionName: "D", layer: "bottom" }],
      failure: { ...failure, searchComplete: false, budgetUnknown: true },
      expectedCalls: [true, undefined],
    },
  ]
  for (const scenario of cases) {
    const calls: Array<boolean | undefined> = []
    const planner = spyOn(
      pairPlanner,
      "planSharedPairCorridors",
    ).mockImplementation(function* () {
      yield []
    })
    const negotiator = spyOn(
      siteNegotiator,
      "negotiateSignalSites",
    ).mockImplementation(
      function* (_state, _remove, _stop, _expanded, options) {
        calls.push(options?.deferAlternateCarrierExpansion)
        if (options?.deferAlternateCarrierExpansion) {
          options.onSiteDomainFailure?.(scenario.failure)
          if (scenario.metadata)
            options.onDeferredCarrierExpansion?.(scenario.metadata)
          else options.onDeferredCarrierExpansion?.()
        }
        return null
      },
    )
    const work = routeFreshSurfaceSeeds(native, native, [], new Map(), {
      denseSearch: true,
      smoothTuning: true,
    })
    try {
      const next = work.next()
      expect(next.done, scenario.name).toBe(true)
      expect(next.value, scenario.name).toBeNull()
      expect(calls, scenario.name).toEqual(scenario.expectedCalls)
      expect({ native, failure }).toEqual(before)
    } finally {
      work.return(null)
      negotiator.mockRestore()
      planner.mockRestore()
    }
  }
})

/** Same manufactured crossed-Top geometry as the carrier fallback regression:
 * direct Top paths are individually reachable and adjacent full-stack sites
 * are blocked. A joint Top attempt needs a deferred Bottom expansion. */
function crossedSurfaceFixture(): FlexibleSignalState {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    minBoardEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 7, minY: -3, maxY: 3 },
    connections: ["first", "second"].map((name, index) => ({
      name,
      pointsToConnect: [
        { x: 0, y: index ? 0.8 : -0.8, layer: "top" },
        { x: 4, y: index ? -0.8 : 0.8, layer: "top" },
      ],
    })),
    obstacles: [],
    traces: [],
  }
  const blocked = new Set<string>()
  for (const connection of native.connections)
    for (const pad of connection.pointsToConnect) {
      native.obstacles.push({
        type: "rect",
        shape: "circle",
        componentId: pad.x ? "right_package" : "left_package",
        center: { x: pad.x, y: pad.y },
        width: 0.25,
        height: 0.25,
        layers: ["top"],
        connectedTo: [connection.name],
      })
      for (const dx of [-0.8, 0, 0.8])
        for (const dy of [-0.8, 0, 0.8]) {
          if (!dx && !dy) continue
          const center = { x: pad.x + dx, y: pad.y + dy }
          const key = JSON.stringify(center)
          if (blocked.has(key)) continue
          blocked.add(key)
          native.obstacles.push({
            type: "rect",
            shape: "circle",
            center,
            width: 0.3,
            height: 0.3,
            layers: ["inner1", "inner2", "bottom"],
            connectedTo: ["fixed_power"],
          })
        }
    }
  for (const x of [-0.35, 4.35])
    native.obstacles.push({
      type: "rect",
      center: { x, y: 0 },
      width: 0.2,
      height: 6,
      layers: ["top"],
      connectedTo: ["fixed_power"],
    })
  return {
    native,
    pending: {
      ...native,
      connections: native.connections.map((connection) => ({
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((point) => ({
          ...point,
          layer: "bottom",
        })),
      })),
    },
    retained: [],
    traces: [],
    escapes: [],
  }
}

function runNegotiation(
  state: FlexibleSignalState,
  options: Parameters<typeof negotiateSignalSites>[4],
  limit = 1000,
) {
  const work = runBoundedRouting(
    negotiateSignalSites(
      state,
      new Set(state.native.connections.map((connection) => connection.name)),
      false,
      false,
      {
        allowExpandedSites: true,
        expandOnlyWhenBlocked: true,
        deferAlternateCarrierExpansion: true,
        ...options,
      },
    ),
    limit,
  )
  let next = work.next()
  try {
    for (let step = 0; !next.done && step <= limit; step++) next = work.next()
    expect(next.done).toBe(true)
    return next.done ? next.value : null
  } finally {
    if (!next.done) work.return(null)
  }
}

test("real crossed Top domains emit every deferred native connection and carrier once before the joint cap", () => {
  const state = crossedSurfaceFixture()
  const before = structuredClone(state)
  const emitted: Array<readonly DeferredCarrierExpansion[] | undefined> = []
  const failure: SignalSiteDomainFailure[] = []
  expect(
    runNegotiation(state, {
      onDeferredCarrierExpansion: (metadata) => {
        emitted.push(metadata)
      },
      onSiteDomainFailure: (value) => {
        failure.push(value)
      },
    }),
  ).toBeNull()
  expect(emitted).toEqual([
    [
      { connectionName: "first", layer: "bottom" },
      { connectionName: "second", layer: "bottom" },
    ],
  ])
  expect(failure).toEqual([])
  expect(shouldRetryDeferredCarrierExpansion(undefined, emitted[0])).toBe(true)
  expect(state).toEqual(before)
})

test("denied expansion, native-domain cancellation, and early failed construction emit no complete metadata", () => {
  const emitted: Array<readonly DeferredCarrierExpansion[] | undefined> = []
  const onDeferredCarrierExpansion = (
    metadata?: readonly DeferredCarrierExpansion[],
  ) => {
    emitted.push(metadata)
  }
  const state = crossedSurfaceFixture()
  runNegotiation(state, {
    allowExpandedSites: false,
    onDeferredCarrierExpansion,
  })
  expect(emitted).toEqual([])
  const work = negotiateSignalSites(
    state,
    new Set(state.native.connections.map((connection) => connection.name)),
    false,
    false,
    {
      allowExpandedSites: true,
      expandOnlyWhenBlocked: true,
      deferAlternateCarrierExpansion: true,
      onDeferredCarrierExpansion,
    },
  )
  expect(work.next().done).toBe(false)
  work.return(null)
  expect(emitted).toEqual([])
  const earlyFailure = crossedSurfaceFixture()
  earlyFailure.native.connections[1].pointsToConnect = [
    { x: 100, y: 100, layer: "top" },
    { x: 101, y: 100, layer: "top" },
  ]
  expect(
    runNegotiation(earlyFailure, { onDeferredCarrierExpansion }, 10000),
  ).toBeNull()
  expect(emitted).toEqual([])
})

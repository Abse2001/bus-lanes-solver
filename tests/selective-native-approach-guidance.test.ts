import { expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { distance } from "../lib/geometry"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import {
  negotiateSignalSites,
  type SignalSiteDomainFailure,
} from "../lib/negotiate-signal-sites"
import { planSharedPairCorridors } from "../lib/plan-shared-pair-corridors"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { generatedEscapeHolesConflict } from "../lib/expanded-signal-sites"
import { pruneCandidateDomains } from "../lib/prune-candidate-domains"
import { routeFreshSurfaceBuses } from "../lib/route-fresh-surface-buses"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { runBoundedRouting } from "../lib/run-bounded-routing"
import { deriveSelectiveNativeApproachGuide } from "../lib/selective-native-approach-guidance"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import type { SimpleRouteJson, Trace } from "../lib/types"
import {
  guidancePhysicalLayers,
  guidanceWidth,
  jointCpuConflictFixture,
  nativeWireBarrierFixture,
} from "./selective-guidance-fixtures"

function complete<T>(work: Generator<unknown, T>, limit = 100000) {
  let next = work.next()
  try {
    for (let steps = 0; !next.done && steps < limit; steps++) next = work.next()
    expect(next.done).toBe(true)
    return next.done ? next.value : undefined
  } finally {
    if (!next.done) work.return(undefined as T)
  }
}

function manufacture(input: SimpleRouteJson, generated: Trace[]) {
  return validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: [...(input.traces ?? []), ...generated] },
    clearance: guidanceWidth,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0])
}

function blockedWireState() {
  const fixture = nativeWireBarrierFixture()
  const planner = planSharedPairCorridors(
    fixture.native,
    new Map(fixture.native.connections.map((c) => [c.name, ["top"]])),
    true,
    { preferPackageOnlyTuning: true, maxTopologyVariants: 1 },
  )
  let step = planner.next()
  try {
    for (let n = 0; !step.done && !step.value && n < 10000; n++)
      step = planner.next()
    expect(step.value).toHaveLength(2)
    const state: FlexibleSignalState = {
      native: fixture.native,
      pending: {
        ...fixture.native,
        connections: [fixture.native.connections.find((c) => c.name === "D")!],
        traces: [...fixture.native.traces!, ...step.value!],
      },
      retained: step.value!,
      escapes: [],
      traces: [],
    }
    return { ...fixture, state }
  } finally {
    planner.return(undefined)
  }
}

function emptyFailure(state: FlexibleSignalState): SignalSiteDomainFailure {
  return {
    kind: "empty-native-site-domain",
    connection: state.native.connections.find(
      (connection) => connection.name === "D",
    )!,
    searchComplete: true,
    budgetUnknown: false,
  }
}

function jointFailure() {
  const fixture = jointCpuConflictFixture()
  const domains = [...fixture.variants].map(([name, options]) => ({
    name,
    options,
  }))
  const index = new CopperConflictIndex()
  let failure: SignalSiteDomainFailure | undefined
  const result = pruneCandidateDomains(
    domains.map((domain) => domain.options),
    (a, b) =>
      !generatedEscapeHolesConflict(fixture.native, a.escapes, b.escapes) &&
      !index.firstConflict(
        a.escapeCopper,
        b.escapeCopper,
        guidanceWidth - 1e-8,
      ),
    1000000,
    (proof) => {
      failure = {
        kind: "incompatible-native-site-domains",
        names: domains.map((domain) => domain.name),
        domains,
        proof: { ...proof, kind: "arc-consistency" },
      }
    },
  )
  expect(result).toBeNull()
  expect(failure).toBeDefined()
  const state: FlexibleSignalState = {
    native: fixture.native,
    pending: {
      ...fixture.native,
      connections: fixture.native.connections.filter((connection) =>
        ["A", "B"].includes(connection.name),
      ),
      traces: [...fixture.native.traces!, ...fixture.pair],
    },
    retained: fixture.pair,
    traces: [],
    escapes: [],
  }
  return { ...fixture, state, failure: failure! }
}

test("a completed ordinary domain failure reflects a real pair obstruction", () => {
  const { state, originals, physicalInput } = blockedWireState()
  const before = structuredClone({ state, originals })
  const failures: SignalSiteDomainFailure[] = []
  expect(
    complete(
      negotiateSignalSites(state, new Set(["D"]), false, false, {
        allowExpandedSites: true,
        expandOnlyWhenBlocked: true,
        onSiteDomainFailure: (failure) => failures.push(failure),
      }),
    ),
  ).toBeNull()
  expect(failures).toEqual([emptyFailure(state)])
  // The exact original approach is manufacturable against native immutable
  // geometry, but is obstructed by the selected generated pair.
  expect(manufacture(physicalInput, [originals[0]]).valid).toBe(true)
  expect(
    manufacture(physicalInput, [...state.retained, originals[0]]).valid,
  ).toBe(false)
  expect({ state, originals }).toEqual(before)
})

test("the default fresh surface stream completes the blocked native wire without promoting its guide", () => {
  const { native, physicalInput, originals } = nativeWireBarrierFixture()
  const before = structuredClone({ native, physicalInput, originals })
  const result = complete(
    routeFreshSurfaceBuses(
      physicalInput,
      physicalInput,
      originals,
      new Map(physicalInput.connections.map((c) => [c.name, ["top"]])),
      { denseSearch: true, smoothTuning: true },
    ),
  )!
  expect(result).toBeTruthy()
  expect(result.traces.map((trace) => trace.connection_name).sort()).toEqual([
    "D",
    "N",
    "P",
    "fixed_power",
  ])
  const validator = BusLanesSolver.forValidation(result.input, result.traces, {
    smoothTuning: true,
  })
  validator.solve()
  expect(validator.solved).toBe(true)
  expect(validator.error).toBeNull()
  const joined = result.traces.map((trace) =>
    joinSignalEscapes(
      trace,
      result.escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
  for (const trace of joined) {
    const connection = physicalInput.connections.find(
      (candidate) => candidate.name === trace.connection_name,
    )!
    expect(
      distance(trace.route[0], connection.pointsToConnect[0]),
    ).toBeLessThan(1e-8)
    expect(
      distance(trace.route.at(-1)!, connection.pointsToConnect[1]),
    ).toBeLessThan(1e-8)
    expect(trace.route[0]).toMatchObject({ route_type: "wire", layer: "top" })
    expect(trace.route.at(-1)).toMatchObject({
      route_type: "wire",
      layer: "top",
    })
    for (const point of trace.route) {
      if (point.route_type === "wire")
        expect(["top", "bottom"]).toContain(point.layer)
      else {
        expect(point.layers).toEqual(guidancePhysicalLayers)
        expect(point.via_diameter).toBe(0.4572)
        expect(point.via_hole_diameter).toBe(0.254)
      }
    }
  }
  expect(
    busLengthReports(native, joined).every((report) => report.matched),
  ).toBe(true)
  const pair = pairLengthReports(native, joined)[0]
  expect(pair.matched).toBe(true)
  expect(pair.skewMm).toBeLessThanOrEqual(0.127)
  expect(manufacture(physicalInput, joined)).toMatchObject({
    valid: true,
    issues: [],
  })
  expect(result.input.traces!.slice(0, native.traces!.length)).toEqual(
    native.traces!,
  )
  expect(
    result.traces.some((trace) =>
      originals.some(
        (original) => original.pcb_trace_id === trace.pcb_trace_id,
      ),
    ),
  ).toBe(false)
  expect({ native, physicalInput, originals }).toEqual(before)
})

test("complete physical escape assignments distinguish the CPU conflict from a healthy RAM endpoint", () => {
  const { native, physicalInput, originals, variants } =
    jointCpuConflictFixture()
  const before = structuredClone({ native, originals, variants })
  for (const a of variants.get("A")!)
    for (const b of variants.get("B")!)
      expect(
        manufacture(physicalInput, [...a.escapes, ...b.escapes]).valid,
      ).toBe(false)
  const aRam = originals.find(
    (trace) => trace.connection_name === "A" && trace.route[0].x === 6,
  )!
  const bCpu = originals.find(
    (trace) => trace.connection_name === "B" && trace.route[0].x === 0.4,
  )!
  for (const b of variants.get("B")!) {
    expect(manufacture(physicalInput, [aRam, ...b.escapes]).valid).toBe(true)
    for (const a of variants.get("A")!)
      expect(
        manufacture(physicalInput, [a.escapes[0], aRam, ...b.escapes]).valid,
      ).toBe(false)
  }
  for (const a of variants.get("A")!)
    for (const b of variants.get("B")!)
      expect(
        manufacture(physicalInput, [...a.escapes, bCpu, b.escapes[1]]),
      ).toMatchObject({ valid: true, issues: [] })
  expect({ native, originals, variants }).toEqual(before)
})

test("completed feedback selects only the obstructed owned wire and clones the proposal", () => {
  const { state, originals, physicalInput } = blockedWireState()
  const before = structuredClone({ state, originals, physicalInput })
  const result = deriveSelectiveNativeApproachGuide(
    state,
    emptyFailure(state),
    originals,
    [],
    { physicalInput },
  )
  expect(result.guide).toMatchObject({
    mode: "wire",
    trace: { pcb_trace_id: originals[0].pcb_trace_id },
  })
  expect(result.guide!.trace.route).toEqual(originals[0].route.slice(0, 2))
  expect(
    result.guide!.trace.route.every(
      (point) => point.route_type === "wire" && point.layer === "top",
    ),
  ).toBe(true)
  expect(
    result.proof.endpoints.filter((endpoint) => endpoint.selected),
  ).toHaveLength(1)
  expect(result.proof.endpoints[0].counterfactuals).toEqual([
    { removedOwnedPair: ["P", "N"], proposedClears: true },
  ])
  expect(manufacture(physicalInput, [result.guide!.trace])).toMatchObject({
    valid: true,
    issues: [],
  })
  result.guide!.trace.route[0].x += 1
  expect({ state, originals, physicalInput }).toEqual(before)
})

test("joint feedback repairs the CPU landing within complete options rather than protecting the clear RAM landing", () => {
  const { state, failure, originals, physicalInput, variants } = jointFailure()
  const before = structuredClone({
    state,
    failure,
    originals,
    physicalInput,
    variants,
  })
  const result = deriveSelectiveNativeApproachGuide(
    state,
    failure,
    originals,
    [],
    { physicalInput },
  )
  expect(result.guide).toMatchObject({
    key: JSON.stringify(["B", 0, "top", 0.4, 0]),
    mode: "full",
  })
  expect(result.guide!.trace.route).toEqual(
    originals.find(
      (original) =>
        original.connection_name === "B" && original.route[0].x === 0.4,
    )!.route,
  )
  expect(
    result.proof.endpoints.find(
      (endpoint) => endpoint.key === JSON.stringify(["A", 1, "top", 6, 0]),
    )!.selected,
  ).not.toBe(true)
  for (const a of variants.get("A")!)
    for (const b of variants.get("B")!)
      expect(
        manufacture(physicalInput, [
          ...a.escapes,
          result.guide!.trace,
          b.escapes[1],
        ]),
      ).toMatchObject({ valid: true, issues: [] })
  expect({ state, failure, originals, physicalInput, variants }).toEqual(before)
})

test("an interrupted finite repair search cannot produce a joint guide", () => {
  const { state, failure, originals, physicalInput } = jointFailure()
  const result = deriveSelectiveNativeApproachGuide(
    state,
    failure,
    originals,
    [],
    { physicalInput, maxSupportChecks: 1 },
  )
  expect(result.guide).toBeUndefined()
  expect(
    result.proof.endpoints.some(
      (endpoint) => endpoint.completeNativeSiteRepair?.status === "unknown",
    ),
  ).toBe(true)
})

test("cancelling or bounding a native-site search emits no completed domain failure", () => {
  const { state } = blockedWireState()
  const failures: SignalSiteDomainFailure[] = []
  const work = negotiateSignalSites(state, new Set(["D"]), false, false, {
    allowExpandedSites: true,
    expandOnlyWhenBlocked: true,
    onSiteDomainFailure: (failure) => failures.push(failure),
  })
  expect(work.next().done).toBe(false)
  work.return(null)
  expect(failures).toEqual([])
  expect(
    complete(
      runBoundedRouting(
        negotiateSignalSites(state, new Set(["D"]), false, false, {
          allowExpandedSites: true,
          expandOnlyWhenBlocked: true,
          onSiteDomainFailure: (failure) => failures.push(failure),
        }),
        0,
      ),
    ),
  ).toBeNull()
  expect(failures).toEqual([])
})

test("an unfinished inner carrier search cannot report an empty completed native domain", () => {
  const { state } = blockedWireState()
  const failures: SignalSiteDomainFailure[] = []
  let steps = 0
  // Hold the child at the budget boundary: it proves neither a path nor a
  // geometric failure. The parent must report unknown rather than guide it.
  const stub = spyOn(GridVisibilitySearch.prototype, "step").mockImplementation(
    () => {
      steps++
    },
  )
  try {
    expect(
      complete(
        negotiateSignalSites(state, new Set(["D"]), false, false, {
          allowExpandedSites: false,
          onSiteDomainFailure: (failure) => failures.push(failure),
        }),
        1000000,
      ),
    ).toBeNull()
    expect(steps).toBeGreaterThanOrEqual(3000)
    expect(failures).toEqual([])
  } finally {
    stub.mockRestore()
  }
})

test("native guidance requires both coincident manufactured handoffs and unchanged physical provenance", () => {
  const { state, originals, physicalInput } = blockedWireState()
  const damage: Array<(trace: Trace) => void> = [
    (trace) => {
      trace.route[1].x += 0.1
    },
    (trace) => {
      if (trace.route[1].route_type === "wire") trace.route[1].layer = "bottom"
    },
    (trace) => {
      trace.route[3].x += 0.1
    },
    (trace) => {
      if (trace.route[3].route_type === "wire") trace.route[3].layer = "top"
    },
    (trace) => {
      if (trace.route[2].route_type === "via")
        trace.route[2].layers = ["top", "bottom"]
    },
    (trace) => {
      if (trace.route[1].route_type === "wire") trace.route[1].width = 0
    },
    (trace) => {
      if (trace.route[2].route_type === "via")
        trace.route[2].via_hole_diameter = 0
    },
    (trace) => {
      trace.source_trace_id = "foreign_source"
    },
    (trace) => {
      trace.route.push({
        route_type: "wire",
        x: 0.2,
        y: 0.8,
        layer: "bottom",
        width: guidanceWidth,
      })
    },
    (trace) => {
      if (trace.route[2].route_type === "via")
        trace.route[2].from_layer = "bottom"
    },
    (trace) => {
      if (trace.route[3].route_type === "wire") trace.route[3].width = 0
    },
  ]
  for (const mutate of damage) {
    const malformed = structuredClone(originals)
    mutate(malformed[0])
    expect(
      deriveSelectiveNativeApproachGuide(
        state,
        emptyFailure(state),
        malformed,
        [],
        { physicalInput },
      ).guide,
    ).toBeUndefined()
  }
  const changedPhysical = structuredClone(physicalInput)
  changedPhysical.traces![0].route[0].x -= 0.1
  expect(
    deriveSelectiveNativeApproachGuide(
      state,
      emptyFailure(state),
      originals,
      [],
      { physicalInput: changedPhysical },
    ).guide,
  ).toBeUndefined()
  const supplied = structuredClone({ state, physicalInput, originals })
  supplied.state.native.traces!.push(supplied.originals[0])
  supplied.physicalInput.traces = supplied.state.native.traces
  expect(
    deriveSelectiveNativeApproachGuide(
      supplied.state,
      emptyFailure(supplied.state),
      supplied.originals,
      [],
      { physicalInput: supplied.physicalInput },
    ).guide,
  ).toBeUndefined()
})

test("omitted via minima retain the authoritative manufactured dogbone dimensions", () => {
  const { state, originals, physicalInput } = blockedWireState()
  delete state.native.minViaPadDiameter
  delete state.native.minViaHoleDiameter
  delete physicalInput.minViaPadDiameter
  delete physicalInput.minViaHoleDiameter
  const manufactured = structuredClone(originals)
  for (const trace of manufactured)
    for (const point of trace.route)
      if (point.route_type === "via") {
        point.via_diameter = 0.6
        point.via_hole_diameter = 0.3
      }
  expect(
    deriveSelectiveNativeApproachGuide(
      state,
      emptyFailure(state),
      manufactured,
      [],
      { physicalInput },
    ).guide,
  ).toMatchObject({ mode: "wire" })
  for (const trace of manufactured)
    for (const point of trace.route)
      if (point.route_type === "via") {
        point.via_diameter = 0.3
        point.via_hole_diameter = 0.15
      }
  expect(
    deriveSelectiveNativeApproachGuide(
      state,
      emptyFailure(state),
      manufactured,
      [],
      { physicalInput },
    ).guide,
  ).toBeUndefined()
})

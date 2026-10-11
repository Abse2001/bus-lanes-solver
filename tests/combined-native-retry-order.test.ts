import { expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { generatedEscapeHolesConflict } from "../lib/expanded-signal-sites"
import * as negotiator from "../lib/negotiate-signal-sites"
import type {
  DeferredCarrierExpansion,
  SignalSiteDomainFailure,
} from "../lib/negotiate-signal-sites"
import * as pairPlanner from "../lib/plan-shared-pair-corridors"
import { pruneCandidateDomains } from "../lib/prune-candidate-domains"
import { routeFreshSurfaceSeeds } from "../lib/route-fresh-surface-buses"
import { fixedCopper } from "../lib/vector-scene"
import {
  guidanceWidth,
  propagatingCpuSiteConflictFixture,
} from "./selective-guidance-fixtures"

type OfferedFailure = Extract<
  SignalSiteDomainFailure,
  { kind: "incompatible-offered-native-site-domains" }
>

function certifiedFixture() {
  const { native, domains } = propagatingCpuSiteConflictFixture()
  native.bounds.maxX = 11.5
  const original = native.connections[0]
  native.connections.push({
    ...original,
    name: "D",
    pointsToConnect: original.pointsToConnect.map((point) => ({
      ...point,
      x: point.x + 8,
    })),
  })
  native.obstacles.push(
    ...native.obstacles
      .filter((obstacle) => obstacle.connectedTo?.includes("A"))
      .map((obstacle) => ({
        ...structuredClone(obstacle),
        center: { ...obstacle.center, x: obstacle.center.x + 8 },
        connectedTo: ["D"],
      })),
  )
  const escapes = domains[0].options[0].escapes.map((trace) => ({
    ...trace,
    pcb_trace_id: `${trace.pcb_trace_id}_D`,
    connection_name: "D",
    source_trace_id: "D",
    route: trace.route.map((point) => ({ ...point, x: point.x + 8 })),
  }))
  domains.push({
    name: "D",
    options: [
      {
        escapes,
        escapeCopper: fixedCopper({
          ...native,
          obstacles: [],
          traces: escapes,
        }),
      },
    ],
  })
  for (const domain of domains)
    for (const option of domain.options)
      expect(
        validateRoutedCopperDrc({
          inputSrj: native,
          routedSrj: { ...native, traces: option.escapes },
          clearance: guidanceWidth,
          allowBlindAndBuriedVias: false,
        } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
      ).toBe(true)
  const index = new CopperConflictIndex()
  let failure: OfferedFailure | undefined
  expect(
    pruneCandidateDomains(
      domains.map((domain) => domain.options),
      (a, b) =>
        !generatedEscapeHolesConflict(native, a.escapes, b.escapes) &&
        !index.firstConflict(
          a.escapeCopper,
          b.escapeCopper,
          guidanceWidth - 1e-8,
        ),
      1_000_000,
      (proof) => {
        failure = {
          kind: "incompatible-offered-native-site-domains",
          searchComplete: true,
          budgetUnknown: false,
          names: [
            ...new Set(
              proof.implicatedRemovals.flatMap(({ first, second }) => [
                domains[first].name,
                domains[second].name,
              ]),
            ),
          ],
          domains,
          proof: { ...proof, kind: "arc-consistency" },
        }
      },
    ),
  ).toBeNull()
  expect(failure!.names.slice().sort()).toEqual(["A", "B", "C"])
  native.buses = [
    {
      busId: "data",
      connectionNames: ["A", "B", "C", "D"],
      maxLengthSkew: 0.635,
    },
  ]
  return { native, failure: failure! }
}

type Stage = {
  fine: boolean
  deferCarrier: boolean | undefined
  failure?: OfferedFailure
  deferred?: readonly DeferredCarrierExpansion[]
  legacyDeferred?: boolean
  deferFine?: boolean
}

for (const scenario of [
  "current-intersection",
  "current-disjoint",
  "current-failure-cleared",
  "current-deferral-cleared",
  "current-legacy",
  "current-unknown",
] as const) {
  test(`${scenario}: precision replay precedes the current deferred-core decision`, () => {
    const { native, failure } = certifiedFixture()
    const before = structuredClone({ native, failure })
    const disjoint = [{ connectionName: "D", layer: "bottom" }]
    const intersects = [{ connectionName: "A", layer: "bottom" }]
    const stages: Stage[] = [
      {
        fine: false,
        deferCarrier: true,
        failure,
        deferred: scenario === "current-intersection" ? disjoint : intersects,
        deferFine: true,
      },
      {
        fine: true,
        deferCarrier: true,
        failure:
          scenario === "current-failure-cleared"
            ? undefined
            : scenario === "current-unknown"
              ? { ...failure, searchComplete: false, budgetUnknown: true }
              : failure,
        deferred:
          scenario === "current-deferral-cleared" ||
          scenario === "current-legacy"
            ? undefined
            : scenario === "current-intersection"
              ? intersects
              : disjoint,
        legacyDeferred: scenario === "current-legacy",
      },
    ]
    if (
      scenario !== "current-disjoint" &&
      scenario !== "current-deferral-cleared"
    )
      stages.push({ fine: true, deferCarrier: undefined })
    const calls: Array<{
      fine: boolean | undefined
      deferCarrier: boolean | undefined
    }> = []
    let saved: Parameters<typeof negotiator.negotiateSignalSites>[0] | undefined
    let savedBytes: string | undefined
    const planner = spyOn(
      pairPlanner,
      "planSharedPairCorridors",
    ).mockImplementation(function* () {
      yield []
    })
    const child = spyOn(negotiator, "negotiateSignalSites").mockImplementation(
      function* (...args) {
        saved ??= args[0]
        savedBytes ??= JSON.stringify(saved)
        expect(args[0]).toBe(saved)
        expect(JSON.stringify(args[0])).toBe(savedBytes!)
        const stage = stages[calls.length]
        expect(stage).toBeDefined()
        calls.push({
          fine: args[4]?.allowFineNativeApproachRetry,
          deferCarrier: args[4]?.deferAlternateCarrierExpansion,
        })
        if (stage.failure) args[4]?.onSiteDomainFailure?.(stage.failure)
        if (stage.deferred)
          args[4]?.onDeferredCarrierExpansion?.(stage.deferred)
        else if (stage.legacyDeferred) args[4]?.onDeferredCarrierExpansion?.()
        if (stage.deferFine) args[4]?.onDeferredFineNativeApproachRetry?.()
        return null
      },
    )
    const work = routeFreshSurfaceSeeds(native, native, [], new Map(), {})
    try {
      const result = work.next()
      expect(result.done).toBe(true)
      expect(result.value).toBeNull()
      expect(calls).toEqual(
        stages.map(({ fine, deferCarrier }) => ({ fine, deferCarrier })),
      )
      expect({ native, failure }).toEqual(before)
    } finally {
      work.return(null)
      child.mockRestore()
      planner.mockRestore()
    }
  })
}

test("canceling precision replay closes the saved-state child without a carrier retry", () => {
  const { native, failure } = certifiedFixture()
  const before = structuredClone({ native, failure })
  let calls = 0,
    closed = 0
  const planner = spyOn(
    pairPlanner,
    "planSharedPairCorridors",
  ).mockImplementation(function* () {
    yield []
  })
  const child = spyOn(negotiator, "negotiateSignalSites").mockImplementation(
    function* (...args) {
      calls++
      try {
        if (calls === 1) {
          args[4]?.onSiteDomainFailure?.(failure)
          args[4]?.onDeferredCarrierExpansion?.([
            { connectionName: "A", layer: "bottom" },
          ])
          args[4]?.onDeferredFineNativeApproachRetry?.()
          return null
        }
        expect(args[4]?.allowFineNativeApproachRetry).toBe(true)
        yield
        throw new Error("Canceled replay must not resume")
      } finally {
        closed++
      }
    },
  )
  const work = routeFreshSurfaceSeeds(native, native, [], new Map(), {})
  try {
    expect(work.next().done).toBe(false)
    work.return(null)
    expect(calls).toBe(2)
    expect(closed).toBe(2)
    expect({ native, failure }).toEqual(before)
  } finally {
    work.return(null)
    child.mockRestore()
    planner.mockRestore()
  }
})

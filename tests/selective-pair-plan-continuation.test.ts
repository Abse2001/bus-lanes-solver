import { expect, spyOn, test } from "bun:test"
import * as coupledPair from "../lib/coupled-pair-routing"
import * as pairPlanner from "../lib/plan-shared-pair-corridors"
import {
  priorityPairPlans,
  type PairPlanFeedback,
} from "../lib/route-fresh-surface-buses"
import type { SimpleRouteJson, Trace } from "../lib/types"
import { fixedCopper } from "../lib/vector-scene"
import { nativeWireBarrierFixture } from "./selective-guidance-fixtures"

// Existing fresh topology order, including reserved package families.
const families = [
  100, 2, 3, 0, 1, 101, 102, 103, 4, 104, 5, 105, 6, 106, 7, 107,
]
function pairRoutes(input: SimpleRouteJson, id: string, offset = 0): Trace[] {
  return input.connections
    .filter((connection) => ["P", "N"].includes(connection.name))
    .map((connection) => ({
      type: "pcb_trace",
      pcb_trace_id: `${id}_${connection.name}`,
      connection_name: connection.name,
      route: [
        connection.pointsToConnect[0],
        { x: 0, y: connection.pointsToConnect[0].y + offset, layer: "top" },
        connection.pointsToConnect[1],
      ].map((point) => ({
        ...point,
        route_type: "wire" as const,
        width: 0.1016,
      })),
    }))
}
function nextOffer(
  work: Generator<Trace[] | undefined, void, PairPlanFeedback | undefined>,
  feedback?: PairPlanFeedback,
) {
  let next = work.next(feedback)
  const cooperative: undefined[] = []
  for (let steps = 0; !next.done && !next.value && steps < 1000; steps++) {
    cooperative.push(next.value)
    next = work.next()
  }
  expect(next.done).toBe(false)
  expect(next.value).toHaveLength(2)
  return { plan: next.value!, cooperative }
}

test("selective feedback retains the two-family yield prefix and reaches a third family before the original fallback", () => {
  const { native, originals } = nativeWireBarrierFixture()
  const guides = originals.map((trace) => ({
    ...trace,
    route: trace.route.slice(0, 2),
  }))
  const layers = new Map(
    native.connections.map((connection) => [connection.name, ["top"]]),
  )
  const guidedInput = { ...native, traces: [...native.traces!, ...guides] }
  const guideCopper = fixedCopper({ ...native, obstacles: [], traces: guides })
  const before = structuredClone({ native, guides })
  const calls: Array<{
    variant: number | undefined
    provisional: boolean | undefined
  }> = []
  const stub = spyOn(coupledPair, "routeCoupledPair").mockImplementation(
    function* (input, _pair, _fixed, options) {
      const guided = input.traces?.includes(guides[0])
      if (guided) {
        expect(input.traces?.slice(native.traces!.length)).toEqual(guides)
        expect(input.traces?.at(-2)).toBe(guides[0])
        expect(input.traces?.at(-1)).toBe(guides[1])
        expect(_fixed).toEqual(expect.arrayContaining(guideCopper))
        calls.push({
          variant: options?.variant,
          provisional: options?.allowProvisionalPairTuning,
        })
      }
      yield
      yield
      // Only the third existing family can supply this synthetic pair domain.
      // The real shared planner controls variant ordering and domain admission.
      if (
        guided &&
        (options?.variant !== 3 || options.allowProvisionalPairTuning)
      )
        return null
      return pairRoutes(
        input,
        guided ? "guided_third" : "original",
        guided ? 2 : 0,
      )
    },
  )
  const capped = pairPlanner.planSharedPairCorridors(
    guidedInput,
    layers,
    true,
    {
      preferPackageOnlyTuning: true,
      maxTopologyVariants: 2,
    },
  )
  const prefix: undefined[] = []
  let cappedStep = capped.next()
  while (!cappedStep.done) {
    if (cappedStep.value !== undefined)
      throw new Error("The two-family bank unexpectedly offered a pair plan")
    expect(cappedStep.value).toBeUndefined()
    prefix.push(cappedStep.value)
    cappedStep = capped.next()
  }
  expect(prefix).toHaveLength(8)
  expect(calls.map((call) => call.variant)).toEqual([0, 0, 2, 2])
  calls.length = 0
  const work = priorityPairPlans(native, layers)
  try {
    expect(nextOffer(work).plan[0].pcb_trace_id).toBe("original_P")
    const third = nextOffer(work, { kind: "native-approach-guidance", guides })
    expect(third.plan[0].pcb_trace_id).toBe("guided_third_P")
    expect(third.cooperative.slice(0, prefix.length)).toEqual(prefix)
    expect(third.cooperative).toHaveLength(10)
    expect(calls.map((call) => call.variant)).toEqual([0, 0, 2, 2, 3])
    const resumed = nextOffer(work)
    expect(resumed.plan[0].pcb_trace_id).toBe("original_P")
    // Exhausting the complete guided bank resumes the suspended original;
    // the first two families were not repeated as another truncated probe.
    expect(calls.map((call) => call.variant)).toEqual(
      families.flatMap((family) => [
        family >= 100 ? family - 100 : family,
        family >= 100 ? family - 100 : family,
      ]),
    )
    expect(calls.map((call) => call.provisional)).toEqual(
      families.flatMap(() => [false, true]),
    )
    expect({ native, guides }).toEqual(before)
  } finally {
    work.return(undefined)
    capped.return(undefined)
    stub.mockRestore()
  }
})

test("new selective feedback closes the obsolete bank and retains exactly the complete updated guide set", () => {
  const { native, originals } = nativeWireBarrierFixture()
  const oldGuide = { ...originals[0], route: originals[0].route.slice(0, 2) }
  const currentGuides = [
    originals[0],
    { ...originals[1], route: originals[1].route.slice(0, 2) },
  ]
  const closed: string[] = [],
    opened: string[] = []
  const stub = spyOn(pairPlanner, "planSharedPairCorridors").mockImplementation(
    function* (input, _layers, _fresh, options) {
      const appended = input.traces!.slice(native.traces!.length)
      const scope = appended.includes(oldGuide)
        ? "old"
        : appended.length
          ? "current"
          : "original"
      opened.push(scope)
      if (scope === "current") {
        expect(appended).toEqual(currentGuides)
        expect(appended[0]).toBe(currentGuides[0])
        expect(appended[1]).toBe(currentGuides[1])
        expect(appended).not.toContain(oldGuide)
      }
      try {
        for (const family of families.slice(
          0,
          options?.maxTopologyVariants ?? families.length,
        )) {
          yield
          yield pairRoutes(input, `${scope}_${family}`, family / 1000)
        }
      } finally {
        closed.push(scope)
      }
    },
  )
  const work = priorityPairPlans(native, new Map())
  try {
    expect(nextOffer(work).plan[0].pcb_trace_id).toBe("original_100_P")
    expect(
      nextOffer(work, { kind: "native-approach-guidance", guides: [oldGuide] })
        .plan[0].pcb_trace_id,
    ).toBe("old_100_P")
    expect(
      nextOffer(work, {
        kind: "native-approach-guidance",
        guides: currentGuides,
      }).plan[0].pcb_trace_id,
    ).toBe("current_100_P")
    expect(closed).toEqual(["old"])
    for (const family of families.slice(1))
      expect(nextOffer(work).plan[0].pcb_trace_id).toBe(`current_${family}_P`)
    expect(nextOffer(work).plan[0].pcb_trace_id).toBe("original_2_P")
    expect(closed).toEqual(["old", "current"])
    expect(opened).toEqual(["original", "old", "current"])
  } finally {
    work.return(undefined)
    stub.mockRestore()
  }
  expect(closed).toEqual(["old", "current", "original"])
})

test("no applicable feedback preserves original ordering and legacy boolean guidance still probes one family", () => {
  const { native, originals } = nativeWireBarrierFixture()
  const guide = { ...originals[0], route: originals[0].route.slice(0, 2) }
  const starts: Array<{ guided: boolean; limit: number | undefined }> = []
  const stub = spyOn(pairPlanner, "planSharedPairCorridors").mockImplementation(
    function* (input, _layers, _fresh, options) {
      const guided = input.traces?.includes(guide) ?? false
      starts.push({ guided, limit: options?.maxTopologyVariants })
      for (const family of families.slice(
        0,
        options?.maxTopologyVariants ?? families.length,
      )) {
        yield
        yield pairRoutes(
          input,
          `${guided ? "legacy" : "original"}_${family}`,
          family / 1000,
        )
      }
    },
  )
  try {
    for (const feedback of [
      undefined,
      false,
      true,
      { kind: "native-approach-guidance" as const, guides: [] },
    ]) {
      const work = priorityPairPlans(native, new Map())
      try {
        expect(nextOffer(work).plan[0].pcb_trace_id).toBe("original_100_P")
        expect(nextOffer(work, feedback).plan[0].pcb_trace_id).toBe(
          "original_2_P",
        )
        expect(nextOffer(work).plan[0].pcb_trace_id).toBe("original_3_P")
      } finally {
        work.return(undefined)
      }
    }
    expect(starts.every((call) => !call.guided)).toBe(true)
    starts.length = 0
    const legacy = priorityPairPlans(native, new Map(), [guide])
    try {
      expect(nextOffer(legacy).plan[0].pcb_trace_id).toBe("original_100_P")
      expect(nextOffer(legacy, true).plan[0].pcb_trace_id).toBe("legacy_100_P")
      expect(nextOffer(legacy, true).plan[0].pcb_trace_id).toBe("original_2_P")
      expect(nextOffer(legacy, true).plan[0].pcb_trace_id).toBe("original_3_P")
      expect(starts.filter((call) => call.guided)).toEqual([
        { guided: true, limit: 1 },
      ])
    } finally {
      legacy.return(undefined)
    }
  } finally {
    stub.mockRestore()
  }
})

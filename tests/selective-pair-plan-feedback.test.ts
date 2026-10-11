import { expect, spyOn, test } from "bun:test"
import * as pairPlanner from "../lib/plan-shared-pair-corridors"
import {
  MAX_SELECTIVE_NATIVE_APPROACH_GUIDE_EVENTS,
  priorityPairPlans,
} from "../lib/route-fresh-surface-buses"
import type { Trace } from "../lib/types"
import { nativeWireBarrierFixture } from "./selective-guidance-fixtures"

test("24 bounded selective probes preserve the suspended original pair stream", () => {
  const { native, originals } = nativeWireBarrierFixture()
  const guide = { ...originals[0], route: originals[0].route.slice(0, 2) }
  const before = structuredClone({ native, guide })
  let probes = 0,
    closedProbes = 0,
    closedOriginals = 0
  const trace = (id: string, y: number): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: id,
    connection_name: "P",
    route: [{ route_type: "wire", x: -4.75, y, layer: "top", width: 0.1016 }],
  })
  const stub = spyOn(pairPlanner, "planSharedPairCorridors").mockImplementation(
    function* (actual, _layers, _fresh, options) {
      const guided = actual.traces?.includes(guide)
      try {
        if (guided) {
          probes++
          expect(options).toMatchObject({ maxTopologyVariants: 2 })
          yield [trace(`guided_${probes}`, probes / 100)]
        } else {
          expect(actual).toEqual(native)
          yield [trace("original_first", 0)]
          yield [trace("original_second", 1)]
        }
      } finally {
        if (guided) closedProbes++
        else closedOriginals++
      }
    },
  )
  const work = priorityPairPlans(native, new Map())
  const feedback = {
    kind: "native-approach-guidance" as const,
    guides: [guide],
  }
  try {
    expect(MAX_SELECTIVE_NATIVE_APPROACH_GUIDE_EVENTS).toBe(24)
    expect(work.next().value?.[0].pcb_trace_id).toBe("original_first")
    for (let probe = 1; probe <= 24; probe++)
      expect(work.next(feedback).value?.[0].pcb_trace_id).toBe(
        `guided_${probe}`,
      )
    expect(work.next(feedback).value?.[0].pcb_trace_id).toBe("original_second")
    expect(probes).toBe(24)
    expect(closedProbes).toBe(24)
    expect({ native, guide }).toEqual(before)
  } finally {
    work.return(undefined)
    stub.mockRestore()
  }
  expect(closedOriginals).toBe(1)
})

test("canceling a selective pair probe closes both active and suspended planners", () => {
  const { native, originals } = nativeWireBarrierFixture()
  const guide = { ...originals[0], route: originals[0].route.slice(0, 2) }
  const closed: string[] = []
  const stub = spyOn(pairPlanner, "planSharedPairCorridors").mockImplementation(
    function* (actual) {
      const scope = actual.traces?.includes(guide) ? "guided" : "original"
      try {
        yield []
        yield
      } finally {
        closed.push(scope)
      }
    },
  )
  const work = priorityPairPlans(native, new Map())
  try {
    expect(work.next().value).toEqual([])
    expect(
      work.next({ kind: "native-approach-guidance", guides: [guide] }).value,
    ).toEqual([])
    expect(closed).toEqual([])
  } finally {
    work.return(undefined)
    stub.mockRestore()
  }
  expect(closed).toEqual(["guided", "original"])
})

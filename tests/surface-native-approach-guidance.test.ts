import { expect, spyOn, test } from "bun:test"
import * as pairPlanner from "../lib/plan-shared-pair-corridors"
import {
  ordinaryNativeApproachGuides,
  priorityPairPlans,
} from "../lib/route-fresh-surface-buses"
import { pairLengthReports } from "../lib/route-lengths"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function ownedEscape(name: string, id: string, y: number): Trace {
  return {
    type: "pcb_trace",
    pcb_trace_id: id,
    connection_name: name,
    route: [
      { x: -4, y, route_type: "wire", layer: "top", width: 0.1 },
      { x: -3.6, y: y + 0.4, route_type: "wire", layer: "top", width: 0.1 },
      {
        x: -3.6,
        y: y + 0.4,
        route_type: "via",
        from_layer: "top",
        to_layer: "bottom",
        layers: ["top", "inner1", "inner2", "bottom"],
        via_diameter: 0.4572,
        via_hole_diameter: 0.254,
      },
      { x: -3.6, y: y + 0.4, route_type: "wire", layer: "bottom", width: 0.1 },
    ],
  }
}

function smallInput(): SimpleRouteJson {
  return {
    layerCount: 4,
    minTraceWidth: 0.1,
    bounds: { minX: -8, maxX: 8, minY: -4, maxY: 4 },
    allowedLayers: ["top", "bottom"],
    obstacles: [],
    connections: ["P", "N", "D"].map((name, i) => ({
      name,
      pointsToConnect: [-4, 4].map((x) => ({ x, y: i, layer: "top" })),
    })),
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.127 },
    ],
  }
}

test("native guidance excludes supplied copper, paired nets and all manufactured via geometry", () => {
  const input = smallInput()
  const owned = ownedEscape("D", "owned_D", 2)
  const supplied = ownedEscape("D", "supplied_D", 2)
  input.traces = [supplied]
  const escapes = [
    owned,
    structuredClone(supplied),
    ownedEscape("P", "owned_P", 0),
  ]
  const before = structuredClone({ input, escapes })
  const guides = ordinaryNativeApproachGuides(
    input,
    escapes,
    new Set(["P", "D"]),
  )
  expect(guides).toHaveLength(1)
  expect(guides[0].pcb_trace_id).toBe("owned_D")
  expect(guides[0].route).toEqual(owned.route.slice(0, 2))
  expect(
    guides[0].route.every((p) => p.route_type === "wire" && p.layer === "top"),
  ).toBe(true)
  expect({ input, escapes }).toEqual(before)
})

test("an ordinary failure gets one guided topology probe and then resumes the unchanged original stream", () => {
  const input = smallInput()
  const guide = ownedEscape("D", "guide_D", 2)
  guide.route = guide.route.slice(0, 2)
  const first = { ...ownedEscape("P", "first", 0), route: [] }
  const guided = { ...ownedEscape("P", "guided", 0), route: [] }
  const second = { ...ownedEscape("P", "second", 0), route: [] }
  const calls: Array<{ input: SimpleRouteJson; options: unknown }> = []
  const stub = spyOn(pairPlanner, "planSharedPairCorridors").mockImplementation(
    function* (actual, _layers, _fresh, options) {
      calls.push({ input: structuredClone(actual), options })
      if (options?.maxTopologyVariants === 1) yield [guided]
      else {
        yield [first]
        yield [second]
      }
    },
  )
  try {
    const before = structuredClone(input)
    const work = priorityPairPlans(input, new Map(), [guide])
    expect(work.next().value).toEqual([first])
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toEqual(input)
    expect(work.next(true).value).toEqual([guided])
    expect(calls).toHaveLength(2)
    expect(calls[1].options).toMatchObject({ maxTopologyVariants: 1 })
    expect(calls[1].input.traces).toEqual([guide])
    expect(work.next(true).value).toEqual([second])
    expect(work.next().done).toBe(true)
    expect(calls).toHaveLength(2)
    expect(input).toEqual(before)

    calls.length = 0
    const feasible = priorityPairPlans(input, new Map(), [guide])
    expect(feasible.next().value).toEqual([first])
    expect(feasible.next().value).toEqual([second])
    expect(feasible.next().done).toBe(true)
    expect(calls).toHaveLength(1)
  } finally {
    stub.mockRestore()
  }
})

function nextCompletePlan(
  work: Generator<Trace[] | undefined>,
  failed = false,
) {
  let step = failed ? work.next(true) : work.next()
  for (let i = 0; !step.done && !step.value && i < 1000; i++) step = work.next()
  expect(step.done).toBe(false)
  expect(step.value).toHaveLength(2)
  return step.value as Trace[]
}

test("native wire guidance protects a top breakout when carrier attachments are on bottom", () => {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -2, maxY: 2 },
    obstacles: [],
    connections: [
      ...["P", "N"].map((name, i) => ({
        name,
        pointsToConnect: [-4, 4].map((x) => ({
          x,
          y: i ? 0.11 : -0.11,
          layer: "top",
        })),
      })),
      {
        name: "D",
        pointsToConnect: [
          { x: 0, y: -0.4, layer: "top" },
          { x: 4, y: 0.4, layer: "top" },
        ],
      },
    ],
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.127, traceGap: 0.12 },
    ],
  }
  const escape = ownedEscape("D", "owned_D", -0.4)
  escape.route[0] = {
    x: 0,
    y: -0.4,
    layer: "top",
    route_type: "wire",
    width: 0.1,
  }
  escape.route[1] = {
    x: 0,
    y: 0.4,
    layer: "top",
    route_type: "wire",
    width: 0.1,
  }
  escape.route[2] = { ...escape.route[2], x: 0, y: 0.4 }
  escape.route[3] = {
    x: 0,
    y: 0.4,
    layer: "bottom",
    route_type: "wire",
    width: 0.1,
  }
  const allocation: SimpleRouteJson = {
    ...native,
    connections: native.connections.map((connection) =>
      connection.name === "D"
        ? {
            ...connection,
            pointsToConnect: connection.pointsToConnect.map((p) => ({
              ...p,
              layer: "bottom",
            })),
          }
        : connection,
    ),
  }
  const before = structuredClone({ native, allocation, escape })
  const guides = ordinaryNativeApproachGuides(native, [escape], new Set(["D"]))
  const plans = priorityPairPlans(
    allocation,
    new Map(
      native.connections.map((c) => [
        c.name,
        c.name === "D" ? ["top", "bottom"] : ["top"],
      ]),
    ),
    guides,
  )
  const breakoutVisible = (paired: Trace[]) =>
    new VectorScene(
      native,
      native.connections.find((c) => c.name === "D")!,
      native.minTraceWidth,
      [...fixedCopper(native), ...paired.flatMap(routeCopper)],
    ).pathVisible(guides[0].route)
  try {
    const original = nextCompletePlan(plans)
    expect(
      original.every((trace) => (trace.route[0] as Wire).layer === "top"),
    ).toBe(true)
    expect(breakoutVisible(original)).toBe(false)
    const alternative = nextCompletePlan(plans, true)
    expect(
      alternative.every((trace) => (trace.route[0] as Wire).layer === "top"),
    ).toBe(true)
    expect(breakoutVisible(alternative)).toBe(true)
    expect(pairLengthReports(native, alternative)[0].matched).toBe(true)
    expect(guides[0].route).toHaveLength(2)
    expect(guides[0].route.every((point) => point.route_type === "wire")).toBe(
      true,
    )
    expect(
      alternative.some((trace) => trace.pcb_trace_id === escape.pcb_trace_id),
    ).toBe(false)
    expect({ native, allocation, escape }).toEqual(before)
  } finally {
    plans.return(undefined)
  }
})

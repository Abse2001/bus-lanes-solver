import { expect, test } from "bun:test"
import { priorityPairPlans } from "../lib/route-fresh-surface-buses"
import { planSharedPairCorridors } from "../lib/plan-shared-pair-corridors"
import { pairLengthReports } from "../lib/route-lengths"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function fixture(blockPreferred: boolean): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -4, maxY: 4 },
    obstacles: blockPreferred
      ? [
          {
            center: { x: 0, y: 0 },
            width: 1,
            height: 8.2,
            layers: ["bottom"],
            connectedTo: ["foreign-power"],
          },
        ]
      : [],
    connections: ["P", "N"].map((name, index) => ({
      name,
      pointsToConnect: [-4, 4].map((x) => ({
        x,
        y: index ? 0.11 : -0.11,
        layer: "bottom",
      })),
    })),
    buses: [
      { busId: "DATA", connectionNames: ["P", "N"], maxLengthSkew: 0.127 },
    ],
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.127, traceGap: 0.12 },
    ],
  }
}

function firstPlan(
  work: Generator<Trace[] | undefined>,
  maxSteps: number,
): Trace[] | undefined {
  try {
    for (let steps = 0; steps < maxSteps; steps++) {
      const next = work.next()
      if (next.done) return undefined
      if (next.value) return next.value
    }
  } finally {
    work.return(undefined)
  }
}

test("a blocked preferred surface cannot starve a clear compatible pair carrier", () => {
  const input = fixture(true)
  const before = structuredClone(input)
  const available = new Map(
    input.connections.map((connection) => [connection.name, ["bottom", "top"]]),
  )
  // The bounded reserved/ordinary preferred probe costs 40 yields here; the
  // clear compatible carrier must follow without the full topology retry bank.
  const plan = firstPlan(priorityPairPlans(input, available), 44)
  expect(plan).toBeDefined()
  expect(plan).toHaveLength(2)
  expect(pairLengthReports(input, plan!)[0].matched).toBe(true)
  const fixed = [...fixedCopper(input), ...plan!.flatMap(routeCopper)]
  for (const trace of plan!) {
    expect(trace.route.every((point) => (point as Wire).layer === "top")).toBe(
      true,
    )
    const connection = input.connections.find(
      (candidate) => candidate.name === trace.connection_name,
    )!
    const retargeted = {
      ...connection,
      pointsToConnect: connection.pointsToConnect.map((point) => ({
        ...point,
        layer: "top",
      })),
    }
    expect(
      new VectorScene(
        input,
        retargeted,
        input.minTraceWidth,
        fixed,
      ).pathVisible(trace.route),
    ).toBe(true)
  }
  expect(input).toEqual(before)
  expect(available.get("P")).toEqual(["bottom", "top"])
})

test("an available preferred pair carrier keeps its existing first-plan geometry", () => {
  const input = fixture(false)
  const preferred = new Map(
    input.connections.map((connection) => [connection.name, ["bottom"]]),
  )
  const expected = firstPlan(
    planSharedPairCorridors(input, preferred, true, {
      preferPackageOnlyTuning: true,
    }),
    8,
  )
  const actual = firstPlan(
    priorityPairPlans(
      input,
      new Map(
        input.connections.map((connection) => [
          connection.name,
          ["top", "bottom", "top"],
        ]),
      ),
    ),
    8,
  )
  expect(actual).toEqual(expected)
  expect(actual![0].route[0]).toMatchObject({ layer: "bottom" })
})

test("pair planning retains fixed handoff layers and respects declared compatible layers", () => {
  const input = fixture(true)
  expect(firstPlan(priorityPairPlans(input, new Map()), 64)).toBeUndefined()
  const topOnly = new Map(
    input.connections.map((connection) => [connection.name, ["top"]]),
  )
  const plan = firstPlan(priorityPairPlans(input, topOnly), 8)
  expect(plan).toHaveLength(2)
  expect(plan!.every((trace) => (trace.route[0] as Wire).layer === "top")).toBe(
    true,
  )
})

test("an alternate pair carrier must be compatible with both partners", () => {
  const input = fixture(true)
  const before = structuredClone(input)
  const available = new Map([
    ["P", ["bottom", "top"]],
    ["N", ["bottom"]],
  ])
  expect(firstPlan(priorityPairPlans(input, available), 64)).toBeUndefined()
  expect(input).toEqual(before)
  expect(available.get("N")).toEqual(["bottom"])
})

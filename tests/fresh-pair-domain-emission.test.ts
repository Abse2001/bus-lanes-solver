import { expect, spyOn, test } from "bun:test"
import * as coupledPair from "../lib/coupled-pair-routing"
import { planSharedPairCorridors } from "../lib/plan-shared-pair-corridors"
import { pairLengthReports } from "../lib/route-lengths"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

function fixture(): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -4, maxY: 4 },
    obstacles: [],
    connections: ["P", "N", "Q", "R"].map((name, i) => ({
      name,
      pointsToConnect: [-4, 4].map((x) => ({
        x,
        y: (i < 2 ? -1 : 1) + (i % 2 ? 0.11 : -0.11),
        layer: "top",
      })),
    })),
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.127, traceGap: 0.12 },
      { connectionNames: ["Q", "R"], lengthTolerance: 0.127, traceGap: 0.12 },
    ],
  }
}

function firstComplete(work: Generator<Trace[] | undefined>, budget: number) {
  for (let i = 0; i < budget; i++) {
    const step = work.next()
    if (step.done) return undefined
    if (step.value) return step.value
  }
}

test("a fresh legal joint tuple is offered before a slow remaining carrier starts", () => {
  const input = fixture()
  const before = structuredClone(input)
  const calls: string[] = []
  const stub = spyOn(coupledPair, "routeCoupledPair").mockImplementation(
    function* (local, pair) {
      const members = pair.connectionNames.map(
        (name) => local.connections.find((c) => c.name === name)!,
      )
      const layer = members[0].pointsToConnect[0].layer
      calls.push(`${members[0].name}:${layer}`)
      if (members[0].name === "Q" && layer === "bottom")
        for (let i = 0; i < 200; i++) yield
      return members.map((connection) => ({
        type: "pcb_trace" as const,
        pcb_trace_id: `pair_${connection.name}_${layer}`,
        connection_name: connection.name,
        route: connection.pointsToConnect.map((point) => ({
          ...point,
          route_type: "wire" as const,
          width: 0.1,
        })),
      }))
    },
  )
  const layers = new Map(
    input.connections.map((c) => [c.name, ["top", "bottom"]]),
  )
  try {
    const fresh = planSharedPairCorridors(input, layers, true)
    try {
      const plan = firstComplete(fresh, 8)
      expect(plan).toHaveLength(4)
      expect(calls).toEqual(["P:top", "P:bottom", "Q:top"])
      expect(pairLengthReports(input, plan!).every((r) => r.matched)).toBe(true)
      const fixed = [...fixedCopper(input), ...plan!.flatMap(routeCopper)]
      for (const trace of plan!) {
        const connection = input.connections.find(
          (c) => c.name === trace.connection_name,
        )!
        expect(
          new VectorScene(input, connection, 0.1, fixed).pathVisible(
            trace.route,
          ),
        ).toBe(true)
      }
      // Resume every offered tuple, then verify the pending carrier is still
      // searched; eager emission must not discard the original alternatives.
      for (let i = 0; i < 8 && !calls.includes("Q:bottom"); i++) fresh.next()
      expect(calls).toContain("Q:bottom")
    } finally {
      fresh.return(undefined)
    }
    expect(input).toEqual(before)

    calls.length = 0
    const fixedHandoffs = planSharedPairCorridors(input, layers, false)
    try {
      expect(firstComplete(fixedHandoffs, 8)).toBeUndefined()
      expect(calls).toContain("Q:bottom")
      expect(firstComplete(fixedHandoffs, 250)).toHaveLength(4)
    } finally {
      fixedHandoffs.return(undefined)
    }
  } finally {
    stub.mockRestore()
  }
})

test("fresh ordinary-only planning preserves its empty pair seed", () => {
  const input = fixture()
  input.differentialPairs = []
  const plans = planSharedPairCorridors(input, new Map(), true)
  try {
    expect(plans.next()).toEqual({ done: false, value: [] })
    expect(plans.next().done).toBe(true)
  } finally {
    plans.return(undefined)
  }
})

test("a slow blocked preferred carrier cannot starve a clear alternate, and cancellation closes it", () => {
  const input = fixture()
  input.connections = input.connections.map((connection) => ({
    ...connection,
    pointsToConnect: connection.pointsToConnect.map((point) => ({
      ...point,
      layer: "bottom",
    })),
  }))
  input.obstacles.push({
    center: { x: 0, y: 1 },
    width: 1,
    height: 0.8,
    layers: ["bottom"],
    connectedTo: ["foreign-power"],
  })
  const before = structuredClone(input)
  let slowSteps = 0
  let slowClosed = false
  const stub = spyOn(coupledPair, "routeCoupledPair").mockImplementation(
    function* (local, pair) {
      const members = pair.connectionNames.map(
        (name) => local.connections.find((c) => c.name === name)!,
      )
      const layer = members[0].pointsToConnect[0].layer
      if (members[0].name === "Q" && layer === "bottom") {
        try {
          for (let i = 0; i < 10_000; i++) {
            slowSteps++
            yield
          }
          return null
        } finally {
          slowClosed = true
        }
      }
      return members.map((connection) => ({
        type: "pcb_trace" as const,
        pcb_trace_id: `pair_${connection.name}_${layer}`,
        connection_name: connection.name,
        route: connection.pointsToConnect.map((point) => ({
          ...point,
          route_type: "wire" as const,
          width: 0.1,
        })),
      }))
    },
  )
  const plans = planSharedPairCorridors(
    input,
    new Map(input.connections.map((c) => [c.name, ["bottom", "top"]])),
    true,
  )
  try {
    const plan = firstComplete(plans, 8)
    expect(plan).toHaveLength(4)
    expect(
      plan!.find((trace) => trace.connection_name === "Q")!.route[0],
    ).toMatchObject({ layer: "top" })
    expect(slowSteps).toBeGreaterThan(0)
    expect(slowSteps).toBeLessThan(8)
    expect(slowClosed).toBe(false)
    expect(pairLengthReports(input, plan!).every((r) => r.matched)).toBe(true)
    const fixed = [...fixedCopper(input), ...plan!.flatMap(routeCopper)]
    for (const trace of plan!) {
      const connection = input.connections.find(
        (c) => c.name === trace.connection_name,
      )!
      const local = {
        ...connection,
        pointsToConnect: [trace.route[0], trace.route.at(-1)!],
      }
      expect(
        new VectorScene(
          input,
          local as typeof connection,
          0.1,
          fixed,
        ).pathVisible(trace.route),
      ).toBe(true)
    }
    expect(input).toEqual(before)
  } finally {
    plans.return(undefined)
    stub.mockRestore()
  }
  expect(slowClosed).toBe(true)
})

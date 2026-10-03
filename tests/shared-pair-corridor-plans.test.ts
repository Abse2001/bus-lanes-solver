import { expect, test } from "bun:test"
import { planSharedPairCorridors } from "../lib/plan-shared-pair-corridors"
import { RouteConflictIndex } from "../lib/route-conflict-index"
import type { SimpleRouteJson, Trace, Wire } from "../lib"

test("joint pair plans preserve bus layers, explore common permitted layers, and leave input unchanged", () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["inner1", "inner2"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -4, maxY: 4 },
    obstacles: [],
    connections: [],
    buses: [],
    differentialPairs: [],
  }
  for (const [index, y] of [-2, 0, 2].entries()) {
    const layer = index === 1 ? "inner2" : "inner1"
    const names: [string, string] = [
      `channel-${index}-positive`,
      `channel-${index}-negative`,
    ]
    names.forEach((name, rail) =>
      input.connections.push({
        name,
        pointsToConnect: [-4, 4].map((x) => ({
          x,
          y: y + (rail ? 0.11 : -0.11),
          layer,
        })),
      }),
    )
    input.differentialPairs!.push({
      connectionNames: names,
      lengthTolerance: 0.127,
      traceGap: 0.12,
    })
    if (index < 2)
      input.buses!.push({
        busId: `bus-${index}`,
        connectionNames: names,
        maxLengthSkew: 0.127,
      })
  }
  const layers = new Map(
    input.differentialPairs![2].connectionNames.map((name) => [
      name,
      ["inner1", "inner2", "bottom"],
    ]),
  )
  const before = structuredClone(input),
    generator = planSharedPairCorridors(input, layers),
    plans: Trace[][] = []
  try {
    for (let steps = 0; steps < 5000 && plans.length < 2; steps++) {
      const state = generator.next()
      if (state.done) break
      if (state.value) plans.push(state.value)
    }
  } finally {
    generator.return(undefined)
  }
  expect(plans).toHaveLength(2)
  const conflict = new RouteConflictIndex(),
    clockLayers = new Set<string>()
  for (const plan of plans) {
    expect(plan).toHaveLength(6)
    for (const [index, pair] of input.differentialPairs!.entries()) {
      const rails = plan.filter((t) =>
        pair.connectionNames.includes(t.connection_name!),
      )
      const used = new Set(
        rails.flatMap((t) => t.route.map((p) => (p as Wire).layer)),
      )
      expect(used.size).toBe(1)
      expect(["inner1", "inner2"]).toContain([...used][0])
      if (index < 2)
        expect([...used][0]).toBe(index === 1 ? "inner2" : "inner1")
      else clockLayers.add([...used][0])
    }
    for (let i = 0; i < plan.length; i++)
      for (let j = 0; j < i; j++) {
        if (
          (plan[i].route[0] as Wire).layer !== (plan[j].route[0] as Wire).layer
        )
          continue
        expect(
          conflict.firstConflict(plan[i].route, plan[j].route, 0.2 - 1e-8),
        ).toBeNull()
      }
  }
  expect([...clockLayers].sort()).toEqual(["inner1", "inner2"])
  expect(input).toEqual(before)
})

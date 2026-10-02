import { expect, test } from "bun:test"
import {
  independentBusGroups,
  routeIndependentBuses,
} from "../lib/route-independent-buses"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import type { SimpleRouteJson } from "../lib/types"

function fixture(): SimpleRouteJson {
  return {
    layerCount: 4,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, maxX: 8, minY: -2, maxY: 2 },
    obstacles: [],
    connections: ["inner1", "inner2"].flatMap((layer, bus) =>
      [-0.11, 0.11].map((y, side) => ({
        name: `${bus}_${side}`,
        pointsToConnect: [
          { x: 0, y, layer },
          { x: 6, y, layer },
        ],
      })),
    ),
    buses: [0, 1].map((bus) => ({
      busId: String(bus),
      connectionNames: [`${bus}_0`, `${bus}_1`],
      maxLengthSkew: 0.1,
    })),
    differentialPairs: [0, 1].map((bus) => ({
      connectionNames: [`${bus}_0`, `${bus}_1`],
      traceGap: 0.12,
      lengthTolerance: 0.1,
    })),
  }
}

test("independent layers complete with both members of each pair kept together", () => {
  const input = fixture(),
    before = structuredClone(input)
  const groups = independentBusGroups(input)!
  expect(groups).toHaveLength(2)
  const finished: string[][] = []
  const search = routeIndependentBuses(
    groups,
    [],
    new Map(input.connections.map((c) => [c.name, 0.1])),
    (group, traces) => {
      expect(
        sharedPairSpacingReports(group, traces).every((p) => p.matched),
      ).toBe(true)
      finished.push(traces.map((t) => t.connection_name!))
      return traces
    },
  )
  let state = search.next(),
    steps = 0
  while (!state.done && steps++ < 10000) state = search.next()
  expect(state.done).toBe(true)
  expect(state.value).toHaveLength(4)
  expect(finished.map((names) => names.sort())).toEqual([
    ["0_0", "0_1"],
    ["1_0", "1_1"],
  ])
  expect(input).toEqual(before)
})

test("layer decomposition rejects cross-layer buses and unconstrained controls", () => {
  const input = fixture()
  input.connections[0].pointsToConnect[1].layer = "inner2"
  expect(independentBusGroups(input)).toBeNull()
  input.connections[0].pointsToConnect[0].layer = "inner2"
  expect(independentBusGroups(input)).toBeNull()
  const controls = fixture()
  controls.connections.push({
    name: "control",
    pointsToConnect: [
      { x: 0, y: 1, layer: "bottom" },
      { x: 6, y: 1, layer: "bottom" },
    ],
  })
  expect(independentBusGroups(controls)).toBeNull()
})

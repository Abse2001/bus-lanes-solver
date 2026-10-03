import { expect, test } from "bun:test"
import { BusLanesPipelineSolver, type SimpleRouteJson } from "../lib"
import { busLengthReports } from "../lib/route-lengths"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"

test.each([1, -1])(
  "shared-layer pipeline routes unrelated bus and pair geometry in direction %s",
  (direction) => {
    const input: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["inner1", "inner2"],
      minTraceWidth: 0.1,
      minTraceToPadEdgeClearance: 0.1,
      bounds: { minX: 10, maxX: 24, minY: -6, maxY: 6 },
      obstacles: [],
      connections: [],
      buses: [],
      differentialPairs: [],
    }
    const add = (name: string, y: number, layer: string) =>
      input.connections.push({
        name,
        pointsToConnect: [-5, 5].map((x) => ({
          x: 17 + direction * x,
          y: direction * y,
          layer,
        })),
      })
    for (const [index, y] of [-3, 0, 3].entries()) {
      const layer = index === 1 ? "inner2" : "inner1",
        names: [string, string] = [`p${index}`, `n${index}`]
      add(names[0], y - 0.11, layer)
      add(names[1], y + 0.11, layer)
      input.differentialPairs!.push({
        connectionNames: names,
        traceGap: 0.12,
        lengthTolerance: 0.127,
      })
      if (index < 2) {
        const ordinary = `data${index}`
        add(ordinary, y + 0.7, layer)
        input.buses!.push({
          busId: `group${index}`,
          connectionNames: [...names, ordinary],
          maxLengthSkew: 0.2,
        })
      }
    }
    add("enable", 4.5, "inner2")
    const before = structuredClone(input),
      solver = new BusLanesPipelineSolver(input)
    solver.solve()
    expect(solver.error).toBeNull()
    expect(solver.solved).toBe(true)
    expect(solver.traces).toHaveLength(input.connections.length)
    expect(
      solver.traces
        .flatMap((t) => t.route)
        .every(
          (p) =>
            p.route_type === "wire" && input.allowedLayers!.includes(p.layer),
        ),
    ).toBe(true)
    expect(busLengthReports(input, solver.traces).every((b) => b.matched)).toBe(
      true,
    )
    expect(
      sharedPairSpacingReports(input, solver.traces).every((p) => p.matched),
    ).toBe(true)
    expect(input).toEqual(before)
  },
)

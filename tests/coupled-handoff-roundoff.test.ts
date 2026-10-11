import { expect, test } from "bun:test"
import { routeCoupledPair } from "../lib/coupled-pair-routing"
import { fixedCopper } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"

function alignedPackageBus(direction: number): SimpleRouteJson {
  const connections = [0, 0.8, 1.6].map((x, i) => ({
    name: `D${i}`,
    pointsToConnect: [
      { x, y: 0, layer: "bottom" },
      { x, y: direction * 10, layer: "bottom" },
    ],
  }))
  return {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -4, maxX: 5, minY: -13, maxY: 13 },
    connections,
    // Component ownership and a third bus member select the package-derived
    // outer corridor, the same branch as the aligned AM3352 RAM columns.
    obstacles: connections.flatMap((c) =>
      c.pointsToConnect.map((p, end) => ({
        type: "rect",
        shape: "circle" as const,
        componentId: `U${end}`,
        center: { x: p.x, y: p.y },
        width: 0.3,
        height: 0.3,
        layers: ["top", "bottom"],
        connectedTo: [c.name],
      })),
    ),
    buses: [
      {
        busId: "DATA",
        connectionNames: connections.map((c) => c.name),
        maxLengthSkew: 0.5,
      },
    ],
    differentialPairs: [
      { connectionNames: ["D0", "D1"], traceGap: 0.1, lengthTolerance: 0.1 },
    ],
  }
}

test.each([1, -1])(
  "roundoff in aligned package columns does not reverse the %s travel corridor",
  (direction) => {
    const input = alignedPackageBus(direction)
    const corridors: number[][] = []
    for (const delta of [-1e-12, 1e-12]) {
      const perturbed = structuredClone(input)
      for (const c of perturbed.connections) c.pointsToConnect[1].x += delta
      const generator = routeCoupledPair(
        perturbed,
        perturbed.differentialPairs![0],
        fixedCopper(perturbed),
        { copper: [], penalty: 0, variant: 2 },
      )
      let state = generator.next(),
        steps = 0
      while (!state.done && steps++ < 8000) state = generator.next()
      if (!state.done) generator.return(null)
      expect(state.done).toBe(true)
      expect(state.value).toHaveLength(2)
      corridors.push(
        (state.value as Trace[]).flatMap((t) =>
          t.coupledSection!.flatMap((index) => [
            t.route[index].x,
            t.route[index].y,
          ]),
        ),
      )
    }
    // The old Math.sign(crossDelta) expression moves these handoffs by more
    // than 0.6 mm when a 2e-12 mm rounding residue changes sign.
    for (const [i, coordinate] of corridors[0].entries()) {
      expect(coordinate).toBeCloseTo(corridors[1][i], 5)
    }
  },
  15000,
)

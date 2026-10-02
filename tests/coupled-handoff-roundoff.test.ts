import { expect, test } from "bun:test"
import { routeAlternateSignalDogbones } from "../lib/alternate-signal-dogbones"
import { routeCoupledPair } from "../lib/coupled-pair-routing"
import { independentBusGroups } from "../lib/route-independent-buses"
import { fixedCopper } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"
import { loadAm3352Sample } from "../scripts/am3352-samples"

test.each(["control", "above"] as const)(
  "roundoff in aligned RAM columns does not reverse the %s pair corridor",
  async (placement) => {
    const { input: native } = await loadAm3352Sample(placement)
    const targetLayers = new Map(
      native.connections.map((c) => {
        const bus = native.buses!.findIndex((b) =>
          b.connectionNames.includes(c.name),
        )
        return [c.name, bus < 0 ? "bottom" : `inner${bus + 1}`]
      }),
    )
    const escaped = routeAlternateSignalDogbones(
      native,
      {
        targetLayers,
        viaDiameter: native.minViaPadDiameter!,
        viaHoleDiameter: native.minViaHoleDiameter!,
        traceWidth: native.minTraceWidth,
        clearance: native.minTraceToPadEdgeClearance!,
        boardEdgeClearance: native.minBoardEdgeClearance,
        holeToHoleClearance: native.minViaHoleEdgeToViaHoleEdgeClearance,
        allowBlindAndBuriedVias: false,
      },
      0,
    )
    const busNames = new Set(native.buses!.flatMap((b) => b.connectionNames))
    const input: SimpleRouteJson = {
      ...native,
      connections: escaped.connections.filter((c) =>
        busNames.has(c.name),
      ) as SimpleRouteJson["connections"],
      traces: [...native.traces!, ...escaped.traces] as Trace[],
    }
    const group = independentBusGroups(input)!.find((g) => {
      const pair = g.differentialPairs![0]
      const members = pair.connectionNames.map(
        (n) => g.connections.find((c) => c.name === n)!,
      )
      return (
        Math.abs(
          members.reduce(
            (sum, c) => sum + c.pointsToConnect[1].x - c.pointsToConnect[0].x,
            0,
          ),
        ) < 1e-8
      )
    })!
    expect(group).toBeDefined()
    const corridors: number[][] = []
    for (const delta of [-1e-12, 1e-12]) {
      const perturbed = structuredClone(group)
      for (const c of perturbed.connections) c.pointsToConnect[1].x += delta
      const generator = routeCoupledPair(
        perturbed,
        perturbed.differentialPairs![0],
        fixedCopper(perturbed),
        {
          copper: [],
          penalty: 0,
          variant: 3,
        },
      )
      let state = generator.next(),
        steps = 0
      while (!state.done && steps++ < 30000) state = generator.next()
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
    // Before the fix, a change of 2e-12 mm selected opposite RAM edges,
    // moving the shared corridor by more than ten millimeters.
    for (const [i, coordinate] of corridors[0].entries()) {
      expect(coordinate).toBeCloseTo(corridors[1][i], 5)
    }
  },
  15000,
)

import { distance, length } from "./geometry"
import { fixedRouteLength, minimumLengthTargets } from "./route-lengths"
import type { SimpleRouteJson, Trace } from "./types"

/** Pairs with large added-length demand need room on both sides of a bank.
 * Compare against their existing shared straight runs, not board coordinates
 * or connection names. The final tuner still checks actual curve capacity. */
export function highDemandPairedLanes(input: SimpleRouteJson, traces: Trace[]) {
  const busNames = new Set(input.buses?.flatMap((bus) => bus.connectionNames))
  const targets = minimumLengthTargets(input, traces)
  const result = new Set<string>()
  for (const pair of input.differentialPairs ?? []) {
    if (
      pair.connectionNames.some((name) => {
        const trace = traces.find((t) => t.connection_name === name)
        if (!trace?.coupledSection || !busNames.has(name)) return false
        const [start, end] = trace.coupledSection
        let longest = 0
        for (let i = start + 1; i <= end; i++)
          longest = Math.max(
            longest,
            distance(trace.route[i - 1], trace.route[i]),
          )
        const deficit =
          (targets.get(name) ?? 0) -
          length(trace.route) -
          fixedRouteLength(input, name)
        return deficit > longest / 2
      })
    )
      for (const name of pair.connectionNames) result.add(name)
  }
  return result
}

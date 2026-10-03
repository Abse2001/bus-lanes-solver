import { BusLanesSolver } from "./bus-lanes-solver"
import { preparePairedNetwork } from "./paired-network"
import { negotiateLanes } from "./negotiate-lanes"
import { ejectBlockingLanes } from "./eject-blocking-lanes"
import { rebuildPairedNetwork } from "./rebuild-paired-network"
import { finishPairedNetwork } from "./finish-paired-network"
import {
  repairBusDogbones,
  type RepairedBusDogbones,
} from "./repair-bus-dogbones"
import { repairGridJogs } from "./repair-grid-jogs"
import { pairLengthReports } from "./route-lengths"
import { fixedCopper } from "./vector-scene"
import type { SimpleRouteJson, SolverOptions, Trace } from "./types"

/** Plan all signals together when multiple paired groups share a carrier.
 * A wide demand represents each pair; package approaches remain negotiable.
 * If a bus cannot be matched, reconsider only its generated signal escapes. */
export function* routeSharedLayerNetwork(
  native: SimpleRouteJson,
  input: SimpleRouteJson,
  escapes: Trace[],
  layers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
): Generator<void, RepairedBusDogbones | null> {
  const network = yield* preparePairedNetwork(input, layers)
  if (!network) return null
  const { local, copper, widths } = network
  const negotiate = negotiateLanes(
    local,
    local.connections,
    copper,
    [],
    widths,
    undefined,
    network.layers,
    () => false,
    true,
  )
  let raw: Trace[] | null = null,
    best = 0
  try {
    let state = negotiate.next(),
      steps = 0
    while (!state.done && steps++ < 600000) {
      if (state.value.length > best) {
        best = state.value.length
        if (best >= local.connections.length - 2) {
          raw = yield* ejectBlockingLanes(
            local,
            state.value,
            copper,
            widths,
            network.layers,
            { maxSearches: 2000, maxDepth: 10 },
          )
          if (raw) break
        }
      }
      yield
      state = negotiate.next()
    }
    if (state.done) raw = state.value
  } finally {
    negotiate.return(null)
  }
  if (!raw) return null
  const rebuilt = yield* rebuildPairedNetwork(network, raw)
  if (!rebuilt) return null
  const finished = yield* finishPairedNetwork(network, rebuilt)
  if (!finished) return null
  const original = { input, traces: finished, escapes }
  function* match(
    candidate: RepairedBusDogbones,
  ): Generator<void, RepairedBusDogbones | null> {
    const matcher = BusLanesSolver.forRefinement(
      candidate.input,
      candidate.traces,
      options,
    )
    try {
      while (!matcher.solved && !matcher.failed) {
        matcher.step()
        yield
      }
      return matcher.solved ? { ...candidate, traces: matcher.traces } : null
    } finally {
      if (!matcher.solved && !matcher.failed) matcher.tryFinalAcceptance()
    }
  }
  const matched = yield* match(original)
  if (matched) return matched
  const reports = pairLengthReports(input, finished)
  const pairs = (input.differentialPairs ?? [])
    .map((pair, index) => ({ pair, skew: reports[index].skewMm ?? Infinity }))
    .filter(({ pair }) =>
      input.buses?.some((bus) =>
        pair.connectionNames.every((name) =>
          bus.connectionNames.includes(name),
        ),
      ),
    )
    .sort((a, b) => b.skew - a.skew)
  for (const { pair } of pairs) {
    const repaired = yield* repairBusDogbones(
      native,
      input,
      finished.filter(
        (t) => !pair.connectionNames.includes(t.connection_name!),
      ),
      escapes,
      { pairSteps: 30000, negotiationSteps: 50000, closureSteps: 100000 },
    )
    if (!repaired) continue
    if (
      !(yield* repairGridJogs(
        repaired.input,
        repaired.traces,
        fixedCopper(repaired.input),
      ))
    )
      continue
    const matched = yield* match(repaired)
    if (matched) return matched
  }
  return null
}

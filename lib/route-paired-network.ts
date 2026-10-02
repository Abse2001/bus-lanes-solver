import { preparePairedNetwork } from "./paired-network"
import { rebuildPairedNetwork } from "./rebuild-paired-network"
import { finishPairedNetwork } from "./finish-paired-network"
import { negotiateLanes } from "./negotiate-lanes"
import { ejectBlockingLanes } from "./eject-blocking-lanes"
import type { SimpleRouteJson, Trace } from "./types"

/** Jointly move bus corridors and package approaches before matching. Every
 * shared pair is one wide routing demand; only native reconstructed rails are
 * returned to the caller. The generator is cancellable at each grid step. */
export function* routePairedNetwork(
  input: SimpleRouteJson,
  layers: ReadonlyMap<string, string[]>,
): Generator<void, Trace[] | null> {
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
    layers,
    () => false,
    true,
  )
  let raw: Trace[] | null = null,
    best = 0
  try {
    let state = negotiate.next(),
      steps = 0
    while (!state.done && steps++ < 200000) {
      if (state.value.length > best) {
        best = state.value.length
        if (best >= local.connections.length - 1) {
          raw = yield* ejectBlockingLanes(
            local,
            state.value,
            copper,
            widths,
            layers,
            { maxSearches: 120 },
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
  return yield* finishPairedNetwork(network, rebuilt)
}

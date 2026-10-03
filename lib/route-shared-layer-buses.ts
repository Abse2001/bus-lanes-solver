import { BusLanesSolver } from "./bus-lanes-solver"
import { negotiateLanes } from "./negotiate-lanes"
import { planSharedPairCorridors } from "./plan-shared-pair-corridors"
import { rematchTrappedSignalDogbones } from "./rematch-trapped-signal-dogbones"
import { signalWidth, type RepairedBusDogbones } from "./repair-bus-dogbones"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { GridVisibilitySearch } from "./grid-visibility"
import type { SimpleRouteJson, SolverOptions, Trace, Wire } from "./types"

/** Plan the pair corridors jointly, match each bus with the other shared-layer
 * pairs fixed, and only then finish unconstrained signals. All candidate
 * geometry is generated during this invocation. Supplied fanouts stay fixed. */
export function* routeSharedLayerBuses(
  native: SimpleRouteJson,
  allocation: SimpleRouteJson,
  escapes: Trace[],
  terminalLayers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
): Generator<void, RepairedBusDogbones | null> {
  const busNames = new Set(allocation.buses?.flatMap((b) => b.connectionNames))
  const pairNames = new Set(
    allocation.differentialPairs?.flatMap((p) => p.connectionNames),
  )
  const constrained = new Set([...busNames, ...pairNames])
  const widths = new Map(
    allocation.connections.map((c) => [c.name, signalWidth(allocation, c)]),
  )
  const access = new Map<string, boolean>()
  const identities = new WeakMap<Trace, number>()
  let serial = 0
  const fixed = fixedCopper(allocation)
  const plans = planSharedPairCorridors(allocation, terminalLayers)
  for (const paired of plans) {
    if (!paired) {
      yield
      continue
    }
    const local = structuredClone(allocation)
    for (const c of local.connections) {
      const trace = paired.find((t) => t.connection_name === c.name)
      if (trace)
        for (const p of c.pointsToConnect)
          p.layer = (trace.route[0] as Wire).layer
    }
    const busInput = {
      ...local,
      connections: local.connections.filter((c) => constrained.has(c.name)),
    }
    const ordinary = busInput.connections.filter((c) => !pairNames.has(c.name))
    let accessible = true
    const pairedCopper = paired.flatMap(routeCopper)
    for (const connection of ordinary) {
      const layer = connection.pointsToConnect[0].layer
      const key = JSON.stringify([
        connection.name,
        paired
          .filter((t) => (t.route[0] as Wire).layer === layer)
          .map((t) => {
            if (!identities.has(t)) identities.set(t, serial++)
            return identities.get(t)
          }),
      ])
      let reachable = access.get(key)
      if (reachable === undefined) {
        const search = new GridVisibilitySearch(
          new VectorScene(busInput, connection, widths.get(connection.name)!, [
            ...fixed,
            ...pairedCopper,
          ]),
          connection.pointsToConnect[0],
          connection.pointsToConnect[1],
        )
        try {
          let steps = 0
          while (!search.solved && !search.failed && steps++ < 4000) {
            search.step()
            yield
          }
          if (search.solved || search.failed) {
            reachable = search.solved
            access.set(key, reachable)
          }
        } finally {
          search.cancel()
        }
      }
      if (reachable === false) {
        accessible = false
        break
      }
    }
    if (!accessible) continue
    const route = negotiateLanes(
      busInput,
      ordinary,
      fixedCopper(local),
      paired,
      widths,
      undefined,
      new Map(),
      () => true,
      true,
    )
    let state = route.next(),
      steps = 0
    try {
      while (!state.done && steps++ < 16000) {
        yield
        state = route.next()
      }
    } finally {
      if (!state.done) route.return(null)
    }
    if (!state.done || !state.value) continue
    let matched = state.value
    let valid = true
    for (const bus of local.buses ?? []) {
      const names = new Set(bus.connectionNames)
      const group = {
        ...local,
        connections: local.connections.filter((c) => names.has(c.name)),
        buses: [bus],
        differentialPairs: local.differentialPairs?.filter((p) =>
          p.connectionNames.every((n) => names.has(n)),
        ),
        traces: [
          ...(local.traces ?? []),
          ...matched.filter((t) => !names.has(t.connection_name!)),
        ],
      }
      const matcher = BusLanesSolver.forRefinement(
        group,
        matched.filter((t) => names.has(t.connection_name!)),
        options,
      )
      try {
        while (!matcher.solved && !matcher.failed) {
          matcher.step()
          yield
        }
        if (!matcher.solved) {
          valid = false
          break
        }
        matched = [
          ...matched.filter((t) => !names.has(t.connection_name!)),
          ...matcher.traces,
        ]
      } finally {
        if (!matcher.solved && !matcher.failed) matcher.tryFinalAcceptance()
      }
    }
    if (!valid) continue
    const pending: SimpleRouteJson = {
      ...local,
      connections: local.connections.filter((c) => !constrained.has(c.name)),
      buses: [],
      differentialPairs: [],
    }
    const reachableLayers = new Map(terminalLayers)
    const rematched = yield* rematchTrappedSignalDogbones(
      native,
      pending,
      matched,
      escapes,
      terminalLayers,
      reachableLayers,
    )
    if (
      pending.connections.some((c) => reachableLayers.get(c.name)?.length === 0)
    )
      continue
    const remainingInput = {
      ...pending,
      connections: rematched.connections,
      traces: [...(native.traces ?? []), ...rematched.escapes, ...matched],
    }
    const remaining = new BusLanesSolver(
      remainingInput,
      {
        ...options,
        maxSearchIterations: Math.min(
          options.maxSearchIterations ?? 200000,
          200000,
        ),
      },
      terminalLayers,
    )
    try {
      while (!remaining.solved && !remaining.failed) {
        remaining.step()
        yield
      }
      if (!remaining.solved) continue
      const traces = [...matched, ...remaining.traces]
      return {
        escapes: rematched.escapes,
        traces,
        input: {
          ...local,
          connections: local.connections.map((c) => {
            const t = traces.find((t) => t.connection_name === c.name)!
            return {
              ...c,
              pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
            }
          }),
          traces: [...(native.traces ?? []), ...rematched.escapes],
        },
      }
    } finally {
      if (!remaining.solved && !remaining.failed) remaining.tryFinalAcceptance()
    }
  }
  return null
}

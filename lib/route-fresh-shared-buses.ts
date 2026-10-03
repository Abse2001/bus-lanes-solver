import { BusLanesSolver } from "./bus-lanes-solver"
import { planSharedPairCorridors } from "./plan-shared-pair-corridors"
import { reachableSignalDogbones } from "./reachable-signal-dogbones"
import {
  signalDogboneOptions,
  signalWidth,
  type RepairedBusDogbones,
} from "./repair-bus-dogbones"
import { signalLayers, type FlexibleSignalState } from "./flexible-signal-state"
import {
  expandSignalSitePocket,
  findViaAwareSignalPocket,
} from "./find-signal-site-pocket"
import { negotiateSignalSites } from "./negotiate-signal-sites"
import { negotiateLanes } from "./negotiate-lanes"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { length } from "./geometry"
import type { SimpleRouteJson, SolverOptions, Trace, Wire } from "./types"

/** Shared signal planes require joint site and carrier choices. Reserve the
 * paired corridors, negotiate ordinary signals across compatible planes, then
 * repair only the residual site/copper closure before matching full lengths. */
export function* routeFreshSharedBuses(
  native: SimpleRouteJson,
  allocation: SimpleRouteJson,
  originalEscapes: Trace[],
  terminalLayers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
): Generator<void, RepairedBusDogbones | null> {
  const pairNames = new Set(
    native.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  const busNames = new Set(native.buses?.flatMap((bus) => bus.connectionNames))
  const pairEscapes = originalEscapes.filter((trace) =>
    pairNames.has(trace.connection_name!),
  )
  const targets = new Map(
    allocation.connections.map((connection) => [
      connection.name,
      connection.pointsToConnect[0].layer,
    ]),
  )
  const layers = new Map(
    native.connections.map((connection) => [
      connection.name,
      signalLayers(native, connection),
    ]),
  )
  const direction = native.connections.reduce(
    (sum, c) => ({
      x: sum.x + c.pointsToConnect[1].x - c.pointsToConnect[0].x,
      y: sum.y + c.pointsToConnect[1].y - c.pointsToConnect[0].y,
    }),
    { x: 0, y: 0 },
  )
  // Along rows, closest grid attachments preserve narrow package channels.
  // Across rows, consider all nearby attachments to avoid isolated cells.
  const nearestAttachments = Math.abs(direction.x) > Math.abs(direction.y)
  for (const paired of planSharedPairCorridors(
    allocation,
    terminalLayers,
    true,
  )) {
    if (!paired) {
      yield
      continue
    }
    // Large independently routed bus approaches impose an expensive topology
    // before matching. Prefer a more coupled bus candidate; standalone pairs
    // can still be extended after the bus corridors are matched.
    if (
      exteriorPairSpacingReports(allocation, paired).some(
        (report) =>
          busNames.has(report.connectionNames[0]) &&
          (report.separatedExteriorLengthMm ?? 0) >
            0.05 *
              length(
                paired.find(
                  (trace) =>
                    trace.connection_name === report.connectionNames[0],
                )!.route,
              ),
      )
    )
      continue
    const ordinary = {
      ...native,
      connections: native.connections.filter(
        (connection) => !pairNames.has(connection.name),
      ),
      traces: [...(native.traces ?? []), ...pairEscapes, ...paired],
    }
    const generated = yield* reachableSignalDogbones(
      ordinary,
      signalDogboneOptions(ordinary, targets),
      layers,
      nearestAttachments,
    )
    if (!generated) continue
    const escapes = [...pairEscapes, ...generated.traces]
    const pending: SimpleRouteJson = {
      ...native,
      connections: generated.connections,
      buses: [],
      differentialPairs: [],
      traces: [...(native.traces ?? []), ...escapes, ...paired],
    }
    const widths = new Map(
      pending.connections.map((c) => [c.name, signalWidth(native, c)]),
    )
    const route = negotiateLanes(
      pending,
      pending.connections,
      fixedCopper(pending),
      [],
      widths,
      undefined,
      layers,
      () => false,
      true,
    )
    let state: FlexibleSignalState | undefined
    try {
      let step = route.next(),
        iterations = 0
      while (!step.done && iterations++ < 300000) {
        if (step.value.length >= Math.max(1, pending.connections.length - 2)) {
          state = {
            native,
            pending,
            escapes,
            retained: paired,
            traces: step.value,
          }
          break
        }
        yield
        step = route.next()
      }
      if (step.done && step.value)
        state = {
          native,
          pending,
          escapes,
          retained: paired,
          traces: step.value,
        }
    } finally {
      route.return(null)
    }
    if (!state) continue
    if (
      state.retained.length + state.traces.length <
      native.connections.length
    ) {
      const pocket = yield* expandSignalSitePocket(state)
      state = (yield* negotiateSignalSites(state, pocket, true)) ?? undefined
      if (!state) continue
    }
    if (
      state.retained.length + state.traces.length <
      native.connections.length
    ) {
      const pocket = yield* findViaAwareSignalPocket(state)
      state = (yield* negotiateSignalSites(state, pocket)) ?? undefined
      if (!state) continue
    }
    let traces = [...state.retained, ...state.traces]
    if (traces.length !== native.connections.length) continue
    const input: SimpleRouteJson = {
      ...native,
      connections: native.connections.map((connection) => {
        const trace = traces.find((t) => t.connection_name === connection.name)!
        return {
          ...connection,
          pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
        }
      }),
      traces: [...(native.traces ?? []), ...state.escapes],
    }
    const fixed = fixedCopper(input)
    for (let pass = 0; pass < 3; pass++) {
      for (let index = 0; index < traces.length; index++) {
        const trace = traces[index]
        if (trace.coupledSection) continue
        const width = (trace.route[0] as Wire).width,
          layer = (trace.route[0] as Wire).layer
        const connection = input.connections.find(
          (c) => c.name === trace.connection_name,
        )!
        traces[index] = {
          ...trace,
          route: reduceOrdinaryTurns(
            trace.route,
            new VectorScene(input, connection, width, [
              ...fixed,
              ...traces.flatMap(routeCopper),
            ]),
          ).map((point) => ({ ...point, route_type: "wire", layer, width })),
        }
      }
      traces = chamferOrdinaryCorners(input, traces)
      yield
    }
    const matcher = BusLanesSolver.forRefinement(input, traces, options)
    try {
      while (!matcher.solved && !matcher.failed) {
        matcher.step()
        yield
      }
      if (matcher.solved)
        return { input, traces: matcher.traces, escapes: state.escapes }
    } finally {
      if (!matcher.solved && !matcher.failed) matcher.tryFinalAcceptance()
    }
  }
  return null
}

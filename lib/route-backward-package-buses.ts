import { routeAlternateSignalDogbones } from "./alternate-signal-dogbones"
import { BusLanesSolver } from "./bus-lanes-solver"
import { routeCoupledPair } from "./coupled-pair-routing"
import { extendPackageCoupling } from "./extend-package-coupling"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { finishPairedNetwork } from "./finish-paired-network"
import { negotiateLanes } from "./negotiate-lanes"
import { packageApproachRegions, pointInBox } from "./package-approach-regions"
import { preparePairedNetwork } from "./paired-network"
import { rebuildPairedNetwork } from "./rebuild-paired-network"
import {
  ownedSignalEscapes,
  repairBusDogbones,
  signalDogboneOptions,
  signalWidth,
  type RepairedBusDogbones,
} from "./repair-bus-dogbones"
import { independentBusGroups } from "./route-independent-buses"
import { busLengthReports } from "./route-lengths"
import { runBoundedRouting } from "./run-bounded-routing"
import { fixedCopper, routeCopper } from "./vector-scene"
import type { Connection, SimpleRouteJson, SolverOptions, Trace } from "./types"

function initialPairVariants(input: SimpleRouteJson) {
  const busNames = new Set(input.buses?.flatMap((b) => b.connectionNames))
  const groups = independentBusGroups({
    ...input,
    connections: input.connections.filter((c) => busNames.has(c.name)),
  })
  return (groups ?? []).map((group) => {
    const pair = group.differentialPairs?.[0]
    if (!pair) return 0
    const members = pair.connectionNames.map(
      (name) => group.connections.find((c) => c.name === name)!,
    )
    const centers = [0, 1].map((end) => ({
      x:
        (members[0].pointsToConnect[end].x +
          members[1].pointsToConnect[end].x) /
        2,
      y:
        (members[0].pointsToConnect[end].y +
          members[1].pointsToConnect[end].y) /
        2,
    }))
    const dx = Math.abs(centers[1].x - centers[0].x)
    const dy = Math.abs(centers[1].y - centers[0].y)
    const pitch =
      signalWidth(input, members[0]) +
      (pair.traceGap ?? input.minTraceToPadEdgeClearance ?? 0.075)
    // Nearly aligned columns benefit from a facing-edge handoff. Oblique
    // connections keep the nearby edge first; both retain bounded alternatives.
    return Math.min(dx, dy) <= 4 * pitch ? 3 : 0
  })
}

function* matchRoutes(
  input: SimpleRouteJson,
  traces: Trace[],
  options: SolverOptions,
): Generator<void, Trace[] | null> {
  const solver = BusLanesSolver.forRefinement(input, traces, options)
  try {
    while (!solver.solved && !solver.failed) {
      solver.step()
      yield
    }
    return solver.solved ? solver.traces : null
  } finally {
    if (!solver.solved && !solver.failed) solver.tryFinalAcceptance()
  }
}

/** Joint routing for two packages whose bus pads face away from each other.
 * Generate local sites, retain constrained source approaches, then repair a
 * nearly complete bus together with its sites. All geometry is computed during
 * this invocation; native supplied fanouts are immutable. */
export function* routeBackwardPackageBuses(
  native: SimpleRouteJson,
  allocation: SimpleRouteJson,
  terminalLayers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
): Generator<void, RepairedBusDogbones | null> {
  const targets = new Map(
    allocation.connections.map((c) => [c.name, c.pointsToConnect[0].layer]),
  )
  const alternatives = [0, 2].map((attempt) =>
    routeAlternateSignalDogbones(
      native,
      signalDogboneOptions(native, targets),
      attempt,
    ),
  )
  const connections = native.connections.map((c, i) => ({
    ...c,
    pointsToConnect: [
      alternatives[0].connections[i].pointsToConnect[0],
      alternatives[1].connections[i].pointsToConnect[1],
    ],
  })) as Connection[]
  const escapes = ownedSignalEscapes(
    native,
    alternatives.flatMap((alternative, end) =>
      alternative.traces.filter((trace) => {
        const connection = native.connections.find(
          (c) => c.name === trace.connection_name,
        )!
        const point = connection.pointsToConnect[end]
        const start = trace.route[0]
        return (
          start.route_type === "wire" &&
          Math.hypot(start.x - point.x, start.y - point.y) < 1e-8
        )
      }),
    ),
  )
  const fullInput: SimpleRouteJson = {
    ...native,
    connections,
    traces: [...(native.traces ?? []), ...escapes],
  }
  const standalone = (fullInput.differentialPairs ?? []).filter(
    (pair) =>
      !fullInput.buses?.some((bus) =>
        pair.connectionNames.some((name) => bus.connectionNames.includes(name)),
      ),
  )
  const heldNames = new Set(standalone.flatMap((p) => p.connectionNames))
  const input: SimpleRouteJson = {
    ...fullInput,
    connections: fullInput.connections.filter((c) => !heldNames.has(c.name)),
    differentialPairs: fullInput.differentialPairs?.filter(
      (p) => !p.connectionNames.some((name) => heldNames.has(name)),
    ),
  }
  const network = yield* runBoundedRouting(
    preparePairedNetwork(input, terminalLayers, initialPairVariants(input)),
    60000,
  )
  if (!network) return null
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const regions = packageApproachRegions(
    input,
    Math.max(...network.transforms.map((t) => t.envelope / 2)) + clearance,
  )
  // A source handoff embedded in the package needs its complete native escape.
  // A target handoff near its package can still accept the movable corridor.
  const locked = network.transforms.filter((t) =>
    regions.some((region) => pointInBox(t.center[0], region.copper)),
  )
  const dropped = new Set(
    locked.flatMap((t) => [
      t.connection.name,
      ...t.approaches.map((c) => c.name),
    ]),
  )
  const lockedRails = locked.flatMap((t) => t.rails)
  network.local = {
    ...network.local,
    connections: network.local.connections.filter((c) => !dropped.has(c.name)),
    traces: [
      ...(network.local.traces ?? []).filter(
        (t) => !locked.some((l) => t.connection_name === l.connection.name),
      ),
      ...lockedRails,
    ],
    buses: network.local.buses?.map((bus) => ({
      ...bus,
      connectionNames: bus.connectionNames.filter((name) => !dropped.has(name)),
    })),
  }
  network.transforms = network.transforms.filter((t) => !locked.includes(t))
  network.copper = fixedCopper(network.local)
  const generator = negotiateLanes(
    network.local,
    network.local.connections,
    network.copper,
    [],
    network.widths,
    undefined,
    terminalLayers,
    () => false,
    true,
  )
  const originalNames = new Set(input.connections.map((c) => c.name))
  const busNames = new Set(input.buses?.flatMap((b) => b.connectionNames))
  const routeIds = new WeakMap<Trace, number>()
  const tried = new Set<string>()
  let serial = 0
  let partial: Trace[] | null = null
  let state = generator.next()
  let steps = 0
  try {
    while (!state.done && steps++ < 200000) {
      const current = state.value
      const missing = network.local.connections.filter(
        (c) => !current.some((t) => t.connection_name === c.name),
      )
      if (
        missing.length <= 3 &&
        missing.every((c) => originalNames.has(c.name) && busNames.has(c.name))
      ) {
        const key = state.value
          .map((trace) => {
            if (!routeIds.has(trace)) routeIds.set(trace, serial++)
            return routeIds.get(trace)
          })
          .join(",")
        if (!tried.has(key) && tried.size < 24) {
          tried.add(key)
          partial = yield* runBoundedRouting(
            rebuildPairedNetwork(network, [...state.value, ...lockedRails], {
              allowPartial: true,
            }),
            12000,
          )
          if (partial) break
        }
      }
      yield
      state = generator.next()
    }
    if (state.done && state.value)
      partial = yield* runBoundedRouting(
        rebuildPairedNetwork(network, [...state.value, ...lockedRails]),
        12000,
      )
  } finally {
    if (!state.done) generator.return(null)
  }
  if (!partial) return null
  const repaired = yield* repairBusDogbones(native, input, partial, escapes)
  if (!repaired) return null
  const completeInput: SimpleRouteJson = {
    ...fullInput,
    connections: fullInput.connections.map(
      (c) =>
        repaired.input.connections.find((next) => next.name === c.name) ?? c,
    ),
    traces: repaired.input.traces,
  }
  let traces = repaired.traces
  for (const trace of traces)
    for (const point of completeInput.connections.find(
      (c) => c.name === trace.connection_name,
    )!.pointsToConnect)
      point.layer =
        trace.route[0].route_type === "wire"
          ? trace.route[0].layer
          : point.layer
  for (const pair of standalone) {
    const members = completeInput.connections.filter((c) =>
      pair.connectionNames.includes(c.name),
    )
    const layers = [
      ...new Set([
        members[0].pointsToConnect[0].layer,
        ...(terminalLayers.get(members[0].name) ?? []).filter((layer) =>
          members.every((c) => terminalLayers.get(c.name)?.includes(layer)),
        ),
      ]),
    ].filter((layer) => layer !== "top")
    let paired: Trace[] | null = null
    for (const layer of layers) {
      for (const c of members)
        for (const point of c.pointsToConnect) point.layer = layer
      for (let variant = 0; variant < 6 && !paired; variant++)
        paired = yield* runBoundedRouting(
          routeCoupledPair(
            completeInput,
            pair,
            [...fixedCopper(completeInput), ...traces.flatMap(routeCopper)],
            { copper: [], penalty: 0, variant },
          ),
          12000,
        )
      if (paired) break
    }
    if (!paired) return null
    traces = [...traces, ...paired]
  }
  const finished = yield* finishPairedNetwork(
    { ...network, input: completeInput, transforms: [] },
    traces,
  )
  if (!finished) return null
  const matched = yield* matchRoutes(completeInput, finished, options)
  if (!matched) return null
  // Preserve existing internal compensation while extending a package approach.
  // Shortening every approach here would discard unrelated matched meanders.
  const extended = yield* extendPackageCoupling(completeInput, matched, {
    preserveMatching: false,
  })
  if (
    exteriorPairSpacingReports(completeInput, extended).some((r) => !r.matched)
  )
    return null
  const final = yield* matchRoutes(completeInput, extended, options)
  if (
    !final ||
    exteriorPairSpacingReports(completeInput, final).some((r) => !r.matched)
  )
    return null
  const ceilings = new Map(
    busLengthReports(completeInput, matched).map((bus) => [
      bus.busId,
      Math.max(
        ...bus.lengths.map((length) => length.totalLengthMm ?? Infinity),
      ),
    ]),
  )
  if (
    busLengthReports(completeInput, final).some(
      (bus) =>
        Math.max(
          ...bus.lengths.map((length) => length.totalLengthMm ?? Infinity),
        ) >
        ceilings.get(bus.busId)! + 1e-6,
    )
  )
    return null
  return { input: completeInput, traces: final, escapes: repaired.escapes }
}

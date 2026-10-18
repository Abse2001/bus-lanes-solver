import { finishSurfaceTiming } from "./finish-surface-timing"
import { insertNativeSurfaceSignal } from "./insert-native-surface-signal"
import { surfaceBusShortcutCandidates } from "./surface-bus-shortcuts"
import { insertSurfaceSignal } from "./insert-surface-signal"
import { surfaceBridgeEligible } from "./route-surface-bridge"
import { routeAlternateSignalDogbones } from "./alternate-signal-dogbones"
import { CopperConflictIndex } from "./copper-conflict-index"
import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import {
  expandSignalSitePocket,
  findViaAwareSignalPocket,
} from "./find-signal-site-pocket"
import { signalLayers, type FlexibleSignalState } from "./flexible-signal-state"
import {
  negotiateSignalSites,
  type SignalSiteProgress,
} from "./negotiate-signal-sites"
import { negotiateSurfaceRoutes } from "./negotiate-surface-routes"
import { pairCouplingReports } from "./pair-coupling"
import { prepareSurfaceTimingBanks } from "./prepare-surface-timing-banks"
import {
  isProvisionalPairPlan,
  planSharedPairCorridors,
} from "./plan-shared-pair-corridors"
import { retargetGeneratedEscape } from "./retarget-generated-escape"
import {
  ownedSignalEscapes,
  signalDogboneOptions,
  type RepairedBusDogbones,
} from "./repair-bus-dogbones"
import { runBoundedRouting } from "./run-bounded-routing"
import { fixedCopper } from "./vector-scene"
import type { SimpleRouteJson, SolverOptions, Trace, Wire } from "./types"

export interface SurfaceRoutingSeed {
  phase: "timing" | "controls"
  state: FlexibleSignalState
  controlOrdersComplete?: boolean
}
export interface SurfaceSeedOptions {
  maxControlAttempts?: number
  maxControlIterations?: number
  onProgress?: (progress: SurfaceRoutingProgress) => void
}

export type SurfaceRoutingProgress = Omit<SignalSiteProgress, "stage"> & {
  stage: SignalSiteProgress["stage"] | "pairs" | "matching"
}

/** Choose fresh surface sites before committing independent control dogbones.
 * Complete results still pass matching and physical coupling; partial computed
 * seeds expose compatible copper to a later joint surface negotiation. */
export function* routeFreshSurfaceBuses(
  native: SimpleRouteJson,
  allocation: SimpleRouteJson,
  originalEscapes: Trace[],
  terminalLayers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
  seedOptions: SurfaceSeedOptions = {},
): Generator<void, RepairedBusDogbones | null> {
  const seeds = routeFreshSurfaceSeeds(
    native,
    allocation,
    originalEscapes,
    terminalLayers,
    options,
    seedOptions,
  )
  let next = seeds.next()
  let matchedTiming: FlexibleSignalState | undefined
  try {
    while (!next.done) {
      const candidate = next.value
      if (candidate?.phase === "timing") {
        matchedTiming = candidate.state
      }
      if (
        candidate &&
        carrierCount(candidate.state) === native.connections.length
      ) {
        const finished = yield* finishSurfaceTiming(candidate.state, options, {
          preserveTiming: true,
        })
        if (finished)
          return {
            input: finished.pending,
            traces: [...finished.retained, ...finished.traces],
            escapes: finished.escapes,
          }
      }
      if (candidate?.controlOrdersComplete) {
        if (matchedTiming) {
          const timing = yield* prepareSurfaceTimingBanks(
            native,
            candidate.state,
            matchedTiming,
            { solverOptions: options },
          )
          if (timing) {
            const joint = yield* negotiateSurfaceRoutes(
              native,
              mergeTimingCheckpoint(native, candidate.state, timing),
              {
                frozenConnectionNames: new Set(
                  native.buses?.flatMap((bus) => bus.connectionNames),
                ),
              },
            )
            if (joint) {
              const finished = yield* finishSurfaceTiming(joint, options, {
                preserveTiming: true,
              })
              if (finished)
                return {
                  input: finished.pending,
                  traces: [...finished.retained, ...finished.traces],
                  escapes: finished.escapes,
                }
            }
          }
        }
        const joint = yield* negotiateSurfaceRoutes(native, candidate.state)
        if (joint) {
          const finished = yield* finishSurfaceTiming(joint, options, {
            preserveTiming: true,
          })
          if (finished)
            return {
              input: finished.pending,
              traces: [...finished.retained, ...finished.traces],
              escapes: finished.escapes,
            }
        }
      }
      yield
      next = seeds.next()
    }
  } finally {
    if (!next.done) seeds.return(null)
  }
  return null
}

/** Keep computed untimed choices as candidates while replacing complete owned
 * timing tuples. The joint negotiator rechecks those controls against the new
 * timing copper before admitting them to its candidate pool. */
function mergeTimingCheckpoint(
  native: SimpleRouteJson,
  previous: FlexibleSignalState,
  timing: FlexibleSignalState,
): FlexibleSignalState {
  const timingNames = new Set(
    timing.native.connections.map((connection) => connection.name),
  )
  const untimed = [...previous.retained, ...previous.traces].filter(
    (trace) => !timingNames.has(trace.connection_name!),
  )
  const carriers = [...timing.retained, ...timing.traces, ...untimed]
  const escapes = [
    ...timing.escapes,
    ...previous.escapes.filter(
      (trace) => !timingNames.has(trace.connection_name!),
    ),
  ]
  return {
    native,
    pending: carrierInput(native, carriers, escapes),
    escapes,
    retained: timing.retained,
    traces: [...timing.traces, ...untimed],
  }
}

/** Emit a strictly matched timing checkpoint before controls, then compatible
 * control prefixes after each ordering pass. Preserve the greatest computed
 * partial so a failed insertion does not discard its physical route choices. */
export function* routeFreshSurfaceSeeds(
  native: SimpleRouteJson,
  allocation: SimpleRouteJson,
  originalEscapes: Trace[],
  terminalLayers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
  seedOptions: SurfaceSeedOptions = {},
): Generator<void | SurfaceRoutingSeed, FlexibleSignalState | null> {
  const busNames = new Set(native.buses?.flatMap((bus) => bus.connectionNames))
  const pairNames = new Set(
    native.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  const timingNames = new Set(busNames)
  for (const pair of native.differentialPairs ?? [])
    if (pair.connectionNames.some((name) => busNames.has(name)))
      for (const name of pair.connectionNames) timingNames.add(name)
  const timing = scopeInput(native, timingNames)
  const timingPairs = new Set(
    timing.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  const controls = native.connections.filter(
    (connection) =>
      !timingNames.has(connection.name) && !pairNames.has(connection.name),
  )
  const firstNativeControl = controls.find((connection) =>
    surfaceBridgeEligible(native, connection),
  )
  const pairEscapes = originalEscapes.filter((trace) =>
    timingPairs.has(trace.connection_name!),
  )
  const timingAllocation: SimpleRouteJson = {
    ...timing,
    connections: allocation.connections.filter((connection) =>
      timingNames.has(connection.name),
    ),
    traces: [...(native.traces ?? []), ...pairEscapes],
  }
  const plans = priorityPairPlans(timingAllocation, terminalLayers, seedOptions)
  let plan = plans.next()
  let greatest: FlexibleSignalState | null = null
  try {
    while (!plan.done) {
      if (!plan.value) {
        yield
        plan = plans.next()
        continue
      }
      const paired: Trace[] = plan.value
      const ordinaryNames = new Set(
        timing.connections
          .filter((connection) => !timingPairs.has(connection.name))
          .map((connection) => connection.name),
      )
      const selectedEscapes = pairEscapes.map((escape) => {
        const carrier = paired.find(
          (trace) => trace.connection_name === escape.connection_name,
        )!
        return retargetGeneratedEscape(escape, (carrier.route[0] as Wire).layer)
      })
      let state: FlexibleSignalState | null = {
        native: timing,
        pending: {
          ...timingAllocation,
          connections: timingAllocation.connections.filter((connection) =>
            ordinaryNames.has(connection.name),
          ),
          traces: [...(native.traces ?? []), ...selectedEscapes, ...paired],
        },
        escapes: selectedEscapes,
        retained: paired,
        traces: [],
      }
      if (ordinaryNames.size)
        state = yield* runBoundedRouting(
          negotiateSignalSites(state, ordinaryNames, false, false, {
            allowExpandedSites: false,
            maxCandidateSearchNodes: 12000,
            onProgress: seedOptions.onProgress,
          }),
          paired.length && !isProvisionalPairPlan(paired) ? 250000 : 1500000,
        )
      if (!state) {
        plan = plans.next()
        continue
      }
      if (firstNativeControl) {
        state =
          native.allowedLayers?.length === 1
            ? yield* insertOrdinarySignal(
                native,
                allocation,
                state,
                firstNativeControl.name,
                false,
              )
            : yield* insertNativeSurfaceSignal(
                native,
                state,
                firstNativeControl.name,
              )
        if (!state) {
          plan = plans.next()
          continue
        }
      }
      for (const pair of native.differentialPairs ?? []) {
        if (pair.connectionNames.every((name) => timingNames.has(name)))
          continue
        state = yield* insertFreshPair(native, state, pair)
        if (!state) break
      }
      if (!state) {
        plan = plans.next()
        continue
      }
      const shortcuts = yield* surfaceBusShortcutCandidates(state)
      // A shorter candidate may consume its own tuning corridor. Each actual
      // checkpoint is finished independently before controls occupy that space.
      for (const checkpoint of shortcuts.toReversed()) {
        seedOptions.onProgress?.({
          stage: "matching",
          connectionName: "",
          requestedSignals: timing.connections.length,
          routedSignals: carrierCount(checkpoint),
          siteOptions: 0,
        })
        const finished = yield* finishSurfaceTiming(checkpoint, options)
        if (!finished) continue
        if (!greatest || carrierCount(finished) > carrierCount(greatest))
          greatest = finished
        yield { phase: "timing", state: finished }
        const controlWork = insertSurfaceControlCandidates(
          native,
          allocation,
          finished,
          controls.map((connection) => connection.name),
          {
            maxAttempts: seedOptions.maxControlAttempts ?? 3,
            maxIterations: seedOptions.maxControlIterations,
            allowPocketRepair: false,
          },
        )
        let control = controlWork.next()
        try {
          while (!control.done) {
            if (control.value) {
              const candidate = control.value.state
              if (!greatest || carrierCount(candidate) > carrierCount(greatest))
                greatest = candidate
              if (
                control.value.completedOrder ||
                carrierCount(candidate) === native.connections.length
              )
                yield { phase: "controls", state: candidate }
            } else yield
            control = controlWork.next()
          }
          if (control.value) {
            if (
              !greatest ||
              carrierCount(control.value) > carrierCount(greatest)
            )
              greatest = control.value
            yield {
              phase: "controls",
              state: control.value,
              controlOrdersComplete: true,
            }
          }
          if (
            control.value &&
            carrierCount(control.value) === native.connections.length
          )
            return control.value
        } finally {
          if (!control.done) controlWork.return(finished)
        }
      }
      plan = plans.next()
    }
  } finally {
    if (!plan.done) plans.return(undefined)
  }
  return greatest
}

function carrierCount(state: FlexibleSignalState) {
  return state.retained.length + state.traces.length
}

function* priorityPairPlans(
  allocation: SimpleRouteJson,
  terminalLayers: ReadonlyMap<string, string[]>,
  options: SurfaceSeedOptions,
): Generator<Trace[] | undefined> {
  const preferred = new Map(
    allocation.connections.map((connection) => [
      connection.name,
      [
        ...new Set([
          connection.pointsToConnect[0].layer,
          ...(terminalLayers.get(connection.name) ?? []),
        ]),
      ],
    ]),
  )
  const pairOptions = {
    preferPackageOnlyTuning: true,
    onProgress: (progress: {
      connectionName: string
      pairedSignals: number
      candidates: number
    }) =>
      options.onProgress?.({
        stage: "pairs",
        connectionName: progress.connectionName,
        requestedSignals: allocation.connections.length,
        routedSignals: progress.pairedSignals,
        siteOptions: progress.candidates,
      }),
  }
  // Grow both permitted carrier domains together. Exhausting every preferred-
  // layer topology before considering the other surface can starve an otherwise
  // legal plan whose paired package approaches cross on the preferred layer.
  yield* planSharedPairCorridors(allocation, preferred, true, pairOptions)
}

function scopeInput(
  input: SimpleRouteJson,
  names: ReadonlySet<string>,
): SimpleRouteJson {
  return {
    ...input,
    connections: input.connections.filter((connection) =>
      names.has(connection.name),
    ),
    buses: input.buses?.filter((bus) =>
      bus.connectionNames.every((name) => names.has(name)),
    ),
    differentialPairs: input.differentialPairs?.filter((pair) =>
      pair.connectionNames.every((name) => names.has(name)),
    ),
  }
}

function carrierInput(
  native: SimpleRouteJson,
  traces: Trace[],
  escapes: Trace[],
): SimpleRouteJson {
  const byName = new Map(traces.map((trace) => [trace.connection_name, trace]))
  return {
    ...native,
    connections: native.connections.map((connection) => {
      const trace = byName.get(connection.name)
      return trace
        ? {
            ...connection,
            pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
          }
        : connection
    }),
    traces: [...(native.traces ?? []), ...escapes],
  }
}

export interface SurfaceControlCandidate {
  state: FlexibleSignalState
  completedOrder: boolean
}

/** Preserve compatible partial progress under an explicit insertion budget.
 * Each ordering attempt still starts from the unchanged timing checkpoint. */
export function* insertSurfaceControlCandidates(
  full: SimpleRouteJson,
  allocation: SimpleRouteJson,
  previous: FlexibleSignalState,
  names: string[],
  options: {
    maxAttempts?: number
    maxIterations?: number
    allowPocketRepair?: boolean
  } = {},
): Generator<void | SurfaceControlCandidate, FlexibleSignalState> {
  const work = surfaceControlCandidates(
    full,
    allocation,
    previous,
    names,
    options.maxAttempts ?? 5,
    options.allowPocketRepair ?? true,
  )
  let next = work.next()
  let greatest = previous
  let iterations = 0
  try {
    while (!next.done && iterations++ < (options.maxIterations ?? Infinity)) {
      if (next.value && carrierCount(next.value.state) > carrierCount(greatest))
        greatest = next.value.state
      yield next.value
      next = work.next()
    }
    if (next.done && carrierCount(next.value) > carrierCount(greatest))
      greatest = next.value
    return greatest
  } finally {
    if (!next.done) work.return(greatest)
  }
}

/** Complete-only compatibility wrapper for callers that do not consume seeds. */
export function* insertSurfaceControls(
  full: SimpleRouteJson,
  allocation: SimpleRouteJson,
  previous: FlexibleSignalState,
  names: string[],
): Generator<void, FlexibleSignalState | null> {
  const work = insertSurfaceControlCandidates(full, allocation, previous, names)
  let next = work.next()
  try {
    while (!next.done) {
      yield
      next = work.next()
    }
    const expected = new Set([
      ...previous.retained.map((trace) => trace.connection_name!),
      ...previous.traces.map((trace) => trace.connection_name!),
      ...names,
    ])
    return carrierCount(next.value) === expected.size ? next.value : null
  } finally {
    if (!next.done) work.return(previous)
  }
}

function* surfaceControlCandidates(
  full: SimpleRouteJson,
  allocation: SimpleRouteJson,
  previous: FlexibleSignalState,
  names: string[],
  maxAttempts: number,
  allowPocketRepair: boolean,
): Generator<void | SurfaceControlCandidate, FlexibleSignalState> {
  const original = names.filter(
      (name) =>
        ![...previous.retained, ...previous.traces].some(
          (trace) => trace.connection_name === name,
        ),
    ),
    visited = new Set<string>()
  let order = original
  let greatest = previous
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let state = previous
    const pending = new Set(order)
    for (let round = 0; pending.size && round <= names.length; round++) {
      const fingerprint = JSON.stringify([
        order,
        [...pending],
        [...state.retained, ...state.traces]
          .sort((a, b) => a.connection_name!.localeCompare(b.connection_name!))
          .map((trace) => [
            trace.connection_name,
            trace.route,
            state.escapes
              .filter(
                (escape) => escape.connection_name === trace.connection_name,
              )
              .map((escape) => escape.route),
          ]),
      ])
      if (visited.has(fingerprint)) break
      visited.add(fingerprint)
      let progress = false
      for (const name of [...pending]) {
        const result = yield* insertOrdinarySignal(
          full,
          allocation,
          state,
          name,
          false,
        )
        if (!result) continue
        state = result
        if (carrierCount(state) > carrierCount(greatest)) greatest = state
        yield { state, completedOrder: false }
        pending.delete(name)
        progress = true
        yield
      }
      if (!pending.size) return state
      if (progress) continue
      if (attempt + 1 < maxAttempts || !allowPocketRepair) break
      for (const name of pending) {
        const result = yield* insertOrdinarySignal(
          full,
          allocation,
          state,
          name,
          true,
        )
        if (!result) continue
        state = result
        if (carrierCount(state) > carrierCount(greatest)) greatest = state
        yield { state, completedOrder: false }
        pending.delete(name)
        progress = true
        yield
        break
      }
      if (!progress) break
    }
    yield { state, completedOrder: true }
    const failed = [...pending].reverse(),
      failedNames = new Set(failed)
    order = [...failed, ...original.filter((name) => !failedNames.has(name))]
    yield
  }
  return greatest
}

function* insertOrdinarySignal(
  full: SimpleRouteJson,
  allocation: SimpleRouteJson,
  previous: FlexibleSignalState,
  name: string,
  allowPocketRepair = true,
): Generator<void, FlexibleSignalState | null> {
  const carriers = [...previous.retained, ...previous.traces]
  const names = new Set([
    ...carriers.map((trace) => trace.connection_name!),
    name,
  ])
  const native = scopeInput(full, names)
  const pairs = new Set(
    native.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  const input = carrierInput(native, carriers, previous.escapes)
  const state: FlexibleSignalState = {
    native,
    pending: {
      ...input,
      connections: input.connections.map((connection) =>
        connection.name === name
          ? (allocation.connections.find((item) => item.name === name) ??
            connection)
          : connection,
      ),
      traces: [
        ...(native.traces ?? []),
        ...previous.escapes,
        ...carriers.filter((trace) => pairs.has(trace.connection_name!)),
      ],
    },
    escapes: previous.escapes,
    retained: carriers.filter((trace) => pairs.has(trace.connection_name!)),
    traces: carriers.filter((trace) => !pairs.has(trace.connection_name!)),
  }
  const direct = yield* negotiateSignalSites(state, new Set([name]))
  if (direct) return direct
  const bridge = yield* insertSurfaceSignal(state, name)
  if (bridge) return bridge
  return allowPocketRepair
    ? yield* repairOrdinaryPocket(state, new Set([name]))
    : null
}

function* repairOrdinaryPocket(
  state: FlexibleSignalState,
  initialClosure: ReadonlySet<string>,
): Generator<void, FlexibleSignalState | null> {
  const pairs = new Set(
    state.native.differentialPairs?.flatMap((pair) => pair.connectionNames),
  )
  let current = state
  const closure = new Set(initialClosure)
  const visited = new Set<string>()
  for (let round = 0; round < 6; round++) {
    const viaPocket = yield* findViaAwareSignalPocket(current, closure)
    const carrierPocket = yield* expandSignalSitePocket(current)
    for (const released of [...viaPocket, ...carrierPocket])
      if (!pairs.has(released)) closure.add(released)
    const expanded = round > 0
    const fingerprint = JSON.stringify([
      expanded,
      [...closure]
        .sort()
        .map((released) => [
          released,
          [...current.retained, ...current.traces].find(
            (trace) => trace.connection_name === released,
          )?.route,
          current.escapes
            .filter((escape) => escape.connection_name === released)
            .map((escape) => escape.route),
        ]),
    ])
    // A changed partial assignment can open another handoff even when its
    // member set repeats. Stop only when the same physical state and domain
    // breadth recur; the separate round bound keeps this repair finite.
    if (visited.has(fingerprint)) break
    visited.add(fingerprint)
    const repaired = yield* runBoundedRouting(
      negotiateSignalSites(current, closure, false, expanded, {
        retainExistingRoutes: true,
      }),
      150000,
    )
    if (repaired) return repaired
    const partial = yield* runBoundedRouting(
      negotiateSignalSites(current, closure, true, true, {
        retainExistingRoutes: true,
      }),
      150000,
    )
    if (!partial) continue
    const partialCount = partial.retained.length + partial.traces.length
    if (partialCount === state.native.connections.length) return partial
    current = partial
  }
  return null
}

function* insertFreshPair(
  full: SimpleRouteJson,
  previous: FlexibleSignalState,
  pair: NonNullable<SimpleRouteJson["differentialPairs"]>[number],
): Generator<void, FlexibleSignalState | null> {
  const carriers = [...previous.retained, ...previous.traces]
  const members = full.connections.filter((connection) =>
    pair.connectionNames.includes(connection.name),
  )
  if (members.length !== 2) return null
  const layers = signalLayers(full, members[0]).filter((layer) =>
    members.every((member) => signalLayers(full, member).includes(layer)),
  )
  const oldPairNames = new Set(
    previous.native.differentialPairs?.flatMap(
      (existing) => existing.connectionNames,
    ),
  )
  const clearance =
    full.minTraceToPadEdgeClearance ?? full.defaultObstacleMargin ?? 0.075
  const conflicts = new CopperConflictIndex()
  layers.sort(
    (first, second) =>
      Number(
        !members.every((member) =>
          member.pointsToConnect.every((point) => point.layer === first),
        ),
      ) -
      Number(
        !members.every((member) =>
          member.pointsToConnect.every((point) => point.layer === second),
        ),
      ),
  )
  const nativeLayers = layers.filter((layer) =>
    members.every((member) =>
      member.pointsToConnect.every((point) => point.layer === layer),
    ),
  )
  const alternateLayers = layers.filter(
    (layer) => !nativeLayers.includes(layer),
  )
  const phase = (
    layer: string,
    releaseOrdinary: boolean,
    firstSoft = false,
  ) => ({
    layer,
    releaseOrdinary,
    firstSoft,
  })
  // Give a native surface repair an early, finite opportunity. Trying every
  // native repair before a clear alternate plane can consume the whole request.
  const phases = [
    ...nativeLayers.map((layer) => phase(layer, false)),
    ...nativeLayers.map((layer) => phase(layer, true, true)),
    ...alternateLayers.map((layer) => phase(layer, false)),
    ...nativeLayers.map((layer) => phase(layer, true)),
    ...alternateLayers.map((layer) => phase(layer, true)),
  ]
  const triedSoft = new Set<string>()
  for (const { layer, releaseOrdinary, firstSoft } of phases) {
    let attemptedFirstSoft = false

    const nativeLayer = members.every((member) =>
      member.pointsToConnect.every((point) => point.layer === layer),
    )
    for (
      let orientation = 0;
      orientation < (nativeLayer ? 1 : 4);
      orientation++
    ) {
      const local: SimpleRouteJson = {
        ...full,
        connections: members,
        buses: [],
        differentialPairs: [pair],
        traces: [
          ...(full.traces ?? []),
          ...previous.escapes.filter(
            (trace) =>
              !releaseOrdinary || oldPairNames.has(trace.connection_name!),
          ),
          ...carriers.filter(
            (trace) =>
              !releaseOrdinary || oldPairNames.has(trace.connection_name!),
          ),
        ],
      }
      let escapes: Trace[] = []
      if (!nativeLayer) {
        try {
          const generated = routeAlternateSignalDogbones(
            local,
            signalDogboneOptions(
              local,
              new Map(members.map((member) => [member.name, layer])),
            ),
            orientation,
          )
          local.connections =
            generated.connections as SimpleRouteJson["connections"]
          escapes = ownedSignalEscapes(full, generated.traces)
          if (
            generatedEscapeHolesConflict(full, escapes, local.traces ?? []) ||
            escapes.some((owned, index) =>
              generatedEscapeHolesConflict(
                full,
                [owned],
                escapes.slice(index + 1),
              ),
            )
          )
            continue
          local.traces = [...local.traces!, ...escapes]
        } catch {
          yield
          continue
        }
      }
      const plans = planSharedPairCorridors(
        local,
        new Map(members.map((member) => [member.name, [layer]])),
        true,
        { preferPackageOnlyTuning: true },
      )
      let planned = plans.next()
      try {
        while (!planned.done) {
          if (
            planned.value &&
            pairCouplingReports(local, planned.value).every(
              (report) => report.matched,
            )
          ) {
            const key = JSON.stringify([
              escapes.map((escape) => escape.route),
              planned.value.map((trace) => trace.route),
            ])
            if (releaseOrdinary && triedSoft.has(key)) {
              yield
              planned = plans.next()
              continue
            }
            if (releaseOrdinary) {
              triedSoft.add(key)
              attemptedFirstSoft = true
            }
            const joined = [...carriers, ...planned.value]
            const native = scopeInput(
              full,
              new Set(joined.map((trace) => trace.connection_name!)),
            )
            const allEscapes = [...previous.escapes, ...escapes]
            const pairNames = new Set(
              native.differentialPairs?.flatMap((item) => item.connectionNames),
            )
            const state: FlexibleSignalState = {
              native,
              pending: carrierInput(native, joined, allEscapes),
              escapes: allEscapes,
              retained: joined.filter((trace) =>
                pairNames.has(trace.connection_name!),
              ),
              traces: joined.filter(
                (trace) => !pairNames.has(trace.connection_name!),
              ),
            }
            if (!releaseOrdinary) return state
            const pairCopper = fixedCopper({
              ...full,
              obstacles: [],
              traces: [...escapes, ...planned.value],
            })
            const blockers = new Set(
              carriers
                .filter((trace) => !oldPairNames.has(trace.connection_name!))
                .filter(
                  (trace) =>
                    conflicts.firstConflict(
                      pairCopper,
                      fixedCopper({
                        ...full,
                        obstacles: [],
                        traces: [
                          trace,
                          ...previous.escapes.filter(
                            (escape) =>
                              escape.connection_name === trace.connection_name,
                          ),
                        ],
                      }),
                      clearance - 1e-8,
                    ) ||
                    generatedEscapeHolesConflict(
                      full,
                      escapes,
                      previous.escapes.filter(
                        (owned) =>
                          owned.connection_name === trace.connection_name,
                      ),
                    ),
                )
                .map((trace) => trace.connection_name!),
            )
            if (!blockers.size) return state
            const repair = repairOrdinaryPocket(state, blockers)
            const repaired = firstSoft
              ? yield* runBoundedRouting(repair, 150000)
              : yield* repair
            if (repaired) return repaired
          }
          if (firstSoft && attemptedFirstSoft) break
          yield
          planned = plans.next()
        }
      } finally {
        if (!planned.done) plans.return(undefined)
      }
    }
  }
  return null
}

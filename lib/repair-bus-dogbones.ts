import { routeAlternateSignalDogbones } from "./alternate-signal-dogbones"
import { routeCoupledPair } from "./coupled-pair-routing"
import { ejectBlockingLanes } from "./eject-blocking-lanes"
import { negotiateLanes } from "./negotiate-lanes"
import { runBoundedRouting } from "./run-bounded-routing"
import { fixedCopper, routeCopper } from "./vector-scene"
import type { Connection, SimpleRouteJson, Trace } from "./types"

export function signalWidth(input: SimpleRouteJson, connection: Connection) {
  return (
    input.buses?.find((bus) => bus.connectionNames.includes(connection.name))
      ?.traceWidth ??
    connection.nominalTraceWidth ??
    connection.width ??
    input.minTraceWidth
  )
}

export function signalDogboneOptions(
  input: SimpleRouteJson,
  targetLayers: Map<string, string>,
): Parameters<typeof routeAlternateSignalDogbones>[1] {
  return {
    targetLayers,
    viaDiameter: input.minViaPadDiameter ?? 0.6,
    viaHoleDiameter: input.minViaHoleDiameter ?? 0.3,
    traceWidth: Math.max(
      input.minTraceWidth,
      ...input.connections.map((c) => signalWidth(input, c)),
    ),
    clearance:
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    boardEdgeClearance: input.minBoardEdgeClearance,
    holeToHoleClearance: input.minViaHoleEdgeToViaHoleEdgeClearance,
    allowBlindAndBuriedVias: input.allowBlindAndBuriedVias ?? false,
  }
}

export function ownedSignalEscapes(
  native: SimpleRouteJson,
  traces: ReturnType<typeof routeAlternateSignalDogbones>["traces"],
): Trace[] {
  return traces.map((trace) => ({
    ...trace,
    source_trace_id:
      native.connections.find((c) => c.name === trace.connection_name)
        ?.source_trace_id ?? trace.connection_name,
  })) as Trace[]
}

export interface RepairedBusDogbones {
  input: SimpleRouteJson
  traces: Trace[]
  escapes: Trace[]
}

/** Reconsider an unfinished bus's fresh pad dogbones and its coupled corridor
 * together. Other routes and all supplied copper stay hard. The caller owns
 * these generated escapes; existing user fanouts must never enter this repair. */
export function* repairBusDogbones(
  native: SimpleRouteJson,
  laneInput: SimpleRouteJson,
  current: Trace[],
  generatedEscapes: Trace[],
  limits: {
    pairSteps?: number
    negotiationSteps?: number
    closureSteps?: number
  } = {},
): Generator<void, RepairedBusDogbones | null> {
  let input = structuredClone(laneInput)
  let traces = current
  let escapes = generatedEscapes
  const widths = new Map(
    native.connections.map((c) => [c.name, signalWidth(native, c)]),
  )
  const missing = input.connections.filter(
    (c) => !traces.some((t) => t.connection_name === c.name),
  )
  if (!missing.length) return { input, traces, escapes }
  if (
    missing.length > 3 ||
    missing.some(
      (c) => !input.buses?.some((b) => b.connectionNames.includes(c.name)),
    )
  )
    return null
  const missingCount = (names: string[]) =>
    missing.filter((c) => names.includes(c.name)).length
  const buses = (input.buses ?? [])
    .filter((bus) => missingCount(bus.connectionNames))
    .sort(
      (a, b) =>
        missingCount(b.connectionNames) - missingCount(a.connectionNames),
    )
  for (const bus of buses) {
    const names = new Set(bus.connectionNames)
    const group = native.connections.filter((c) => names.has(c.name))
    const outside = traces.filter((t) => !names.has(t.connection_name!))
    const pair = input.differentialPairs?.find((p) =>
      p.connectionNames.every((name) => names.has(name)),
    )
    if (!pair || group.length !== names.size) return null
    const layer = input.connections.find((c) => names.has(c.name))!
      .pointsToConnect[0].layer
    // Several blocked lanes warrant a new local site orientation first. For a
    // single closure, keep the preferred sites and try another pair handoff.
    const congested = missingCount(bus.connectionNames) > 1
    const variants = congested ? [1, 0, 3, 5, 2, 4] : [2, 1, 0, 3, 5, 4]
    let solved = false
    for (let choice = 0; choice < 4 && !solved; choice++) {
      const attempt = ((congested ? 1 : 0) + choice) % 4
      const base: SimpleRouteJson = {
        ...native,
        connections: group,
        traces: [
          ...(native.traces ?? []),
          ...escapes.filter((t) => !names.has(t.connection_name!)),
          ...outside,
        ],
      }
      let replacement: ReturnType<typeof routeAlternateSignalDogbones>
      try {
        replacement = routeAlternateSignalDogbones(
          base,
          signalDogboneOptions(
            base,
            new Map(group.map((c) => [c.name, layer])),
          ),
          attempt,
        )
      } catch {
        yield
        continue
      }
      const newEscapes = ownedSignalEscapes(native, replacement.traces)
      const local: SimpleRouteJson = {
        ...input,
        connections: replacement.connections as Connection[],
        buses: [bus],
        differentialPairs: [pair],
        traces: [...base.traces!, ...newEscapes],
      }
      const fixed = fixedCopper(local)
      const ordinary = local.connections.filter(
        (c) => !pair.connectionNames.includes(c.name),
      )
      for (const variant of variants) {
        const paired = yield* runBoundedRouting(
          routeCoupledPair(local, pair, fixed, {
            copper: [],
            penalty: 0,
            variant,
          }),
          limits.pairSteps ?? 6000,
        )
        if (!paired) continue
        const generator = negotiateLanes(
          local,
          ordinary,
          fixed,
          paired,
          widths,
          undefined,
          new Map(),
          () => false,
          true,
        )
        let state = generator.next()
        let steps = 0
        let best = 0
        let completed: Trace[] | null = null
        try {
          while (!state.done && steps++ < (limits.negotiationSteps ?? 10000)) {
            if (state.value.length > best) {
              best = state.value.length
              if (best >= local.connections.length - 1) {
                const closed = yield* runBoundedRouting(
                  ejectBlockingLanes(
                    { ...local, connections: ordinary },
                    state.value.filter(
                      (t) => !pair.connectionNames.includes(t.connection_name!),
                    ),
                    [...fixed, ...paired.flatMap(routeCopper)],
                    widths,
                    new Map(),
                    { maxSearches: 200 },
                  ),
                  limits.closureSteps ?? 20000,
                )
                if (closed) {
                  completed = [...paired, ...closed]
                  break
                }
              }
            }
            yield
            state = generator.next()
          }
          if (state.done) completed = state.value
        } finally {
          if (!state.done) generator.return(null)
        }
        if (!completed) continue
        traces = [...outside, ...completed]
        escapes = [
          ...escapes.filter((t) => !names.has(t.connection_name!)),
          ...newEscapes,
        ]
        input = {
          ...input,
          connections: input.connections.map(
            (c) => local.connections.find((next) => next.name === c.name) ?? c,
          ),
          traces: [...(native.traces ?? []), ...escapes],
        }
        solved = true
        break
      }
    }
    if (!solved) return null
  }
  return traces.length === input.connections.length
    ? { input, traces, escapes }
    : null
}

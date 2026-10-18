import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { distance, length } from "./geometry"
import { joinSignalEscapes } from "./join-signal-escapes"
import { tuningPathIsSelfClear } from "./length-tuning"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { fixedRouteLength, minimumLengthTargets } from "./route-lengths"
import { surfaceBridgeSelfShorts } from "./route-surface-bridge"
import {
  IncompleteLengthTuningError,
  tuneSmoothLengths,
} from "./smooth-length-tuning"
import { createTerminalViaClearanceChecker } from "./terminal-via-clearance"
import { fixedCopper, VectorScene } from "./vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Tune only explicitly caller-owned surface approaches of ordinary signals.
 * Every carrier and barrel stays fixed. Supplied input traces, paired corridors,
 * native pads, and all other connections stay hard and byte-identical.
 * Targets account for both approaches plus the unchanged carrier. */
export function* tuneGeneratedOrdinaryEscapes(
  input: SimpleRouteJson,
  carriers: Trace[],
  generatedEscapes: Trace[],
  options: { maxCandidatesPerEscape?: number; targetNames?: string[] } = {},
): Generator<
  void,
  {
    input: SimpleRouteJson
    traces: Trace[]
    escapes: Trace[]
    matchedNames: string[]
    unfinishedNames: string[]
  } | null
> {
  const physical = getCopperLayerNames(input.layerCount)
  const surface = physical[0]
  if (!input.allowedLayers?.includes(surface)) return null
  const carrierIds = new Set(carriers.map((t) => t.pcb_trace_id))
  const escapeIds = new Set(generatedEscapes.map((t) => t.pcb_trace_id))
  if (escapeIds.size !== generatedEscapes.length)
    throw Error("Owned escape IDs must be unique")
  if (carrierIds.size !== carriers.length)
    throw Error("Carrier IDs must be unique")
  const movable = new Map(
    [...carriers, ...generatedEscapes].map((t) => [t.pcb_trace_id, t]),
  )
  const owned = new Set([...carriers, ...generatedEscapes])
  if (movable.size !== carriers.length + generatedEscapes.length)
    throw Error("Carrier and owned escape IDs must be disjoint")
  for (const trace of input.traces ?? []) {
    const movableTrace = movable.get(trace.pcb_trace_id)
    // Explicit object identity determines ownership. An unrelated supplied
    // trace sharing an owned identifier must never be removed as owned.
    if (movableTrace && !owned.has(trace))
      throw Error(
        `Owned trace ID collides with supplied input: ${trace.pcb_trace_id}`,
      )
  }
  const supplied = (input.traces ?? []).filter((t) => !owned.has(t))
  const suppliedInput = { ...input, traces: supplied }
  let escapes = generatedEscapes
  let local: SimpleRouteJson = { ...input, traces: [...supplied, ...escapes] }
  const targets = minimumLengthTargets(local, carriers)
  const paired = new Set(
    input.differentialPairs?.flatMap((p) => p.connectionNames),
  )
  const requested = options.targetNames ? new Set(options.targetNames) : null
  const deficit = (t: Trace) =>
    (targets.get(t.connection_name!) ?? 0) -
    length(t.route) -
    fixedRouteLength(local, t.connection_name!)
  const eligible = carriers
    .filter((t) => {
      const name = t.connection_name!
      return (
        !paired.has(name) &&
        (!requested || requested.has(name)) &&
        t.route.every((p) => p.route_type === "wire") &&
        t.route[0]?.route_type === "wire" &&
        t.route[0].layer !== surface &&
        deficit(t) > 1e-7
      )
    })
    .sort((a, b) => deficit(b) - deficit(a))
  let changed = false
  for (const carrier of eligible) {
    const name = carrier.connection_name!
    const originalConnection = input.connections.find((c) => c.name === name)
    if (!originalConnection) continue
    const maxLength = Math.min(
      Infinity,
      ...(input.buses ?? [])
        .filter(
          (b) => b.connectionNames.includes(name) && b.maxLength !== undefined,
        )
        .map((b) => b.maxLength!),
    )
    if (targets.get(name)! > maxLength + 1e-7) continue
    const candidates = escapes
      .filter((e) => e.connection_name === name)
      .sort((a, b) => length(b.route) - length(a.route))
    for (const oldEscape of candidates) {
      const escape = escapes.find((e) => e === oldEscape)!
      const viaIndex = escape.route.findIndex((p) => p.route_type === "via")
      if (
        viaIndex < 2 ||
        escape.route.filter((p) => p.route_type === "via").length !== 1
      )
        continue
      const top = escape.route.slice(0, viaIndex)
      const via = escape.route[viaIndex]
      if (
        via.route_type !== "via" ||
        via.from_layer !== surface ||
        top.some((p) => p.route_type !== "wire" || p.layer !== surface) ||
        distance(top.at(-1)!, via) > 1e-8
      )
        continue
      const pad = top[0] as Wire
      const stub: Trace = { ...escape, route: top }
      const stubInput: SimpleRouteJson = {
        ...local,
        connections: local.connections.map((c) =>
          c.name === name
            ? { ...c, pointsToConnect: [pad, top.at(-1)! as Wire] }
            : c,
        ),
        traces: [
          ...local.traces!.filter((t) => t !== escape),
          {
            ...escape,
            pcb_trace_id: `${escape.pcb_trace_id}_held_barrel`,
            route: escape.route.slice(viaIndex),
          },
          ...carriers,
        ],
      }
      let tuned: Trace
      try {
        tuned = tuneSmoothLengths(
          stubInput,
          [stub],
          new Map([[name, targets.get(name)!]]),
          {
            maxCandidates: options.maxCandidatesPerEscape ?? 4096,
            packMeanders: true,
          },
        )[0]
      } catch (error) {
        if (!(error instanceof IncompleteLengthTuningError)) {
          yield
          continue
        }
        tuned = error.traces[0]
      }
      const added = length(tuned.route) - length(stub.route)
      if (added < 1e-7) {
        yield
        continue
      }
      const replacement: Trace = {
        ...escape,
        route: [...tuned.route, ...escape.route.slice(viaIndex)],
        curvedSegments: tuned.curvedSegments,
      }
      const ownEscapes = escapes
        .map((e) => (e === escape ? replacement : e))
        .filter((e) => e.connection_name === name)
      const joined = joinSignalEscapes(carrier, ownEscapes)
      const totalLength =
        length(joined.route) + fixedRouteLength(suppliedInput, name)
      const others = carriers
        .filter((t) => t.connection_name !== name)
        .map((t) =>
          joinSignalEscapes(
            t,
            escapes.filter((e) => e.connection_name === t.connection_name),
          ),
        )
      const scene = new VectorScene(
        input,
        { ...originalConnection, pointsToConnect: [pad, top.at(-1)! as Wire] },
        pad.width,
        fixedCopper({ ...input, traces: [...supplied, ...others] }),
      )
      if (
        !scene.pathVisible(tuned.route) ||
        !tuningPathIsSelfClear(
          tuned.route,
          pad.width +
            (input.minTraceToPadEdgeClearance ??
              input.defaultObstacleMargin ??
              0.075),
        ) ||
        !createTerminalViaClearanceChecker(stubInput, stub, {
          preserveExistingApproach: false,
        })(tuned.route) ||
        !routeAnglesAreConventional([joined]) ||
        surfaceBridgeSelfShorts(input, originalConnection, joined) ||
        totalLength > maxLength + 1e-7 ||
        totalLength > targets.get(name)! + 1e-6
      ) {
        yield
        continue
      }
      escapes = escapes.map((e) => (e === escape ? replacement : e))
      local = { ...local, traces: [...supplied, ...escapes] }
      changed = true
      yield
      if (totalLength >= targets.get(name)! - 1e-7) break
    }
  }
  if (!changed) return null
  const matchedNames: string[] = [],
    unfinishedNames: string[] = []
  for (const carrier of eligible) {
    const name = carrier.connection_name!
    const total =
      length(
        joinSignalEscapes(
          carrier,
          escapes.filter((e) => e.connection_name === name),
        ).route,
      ) + fixedRouteLength(suppliedInput, name)
    ;(total >= targets.get(name)! - 1e-7 ? matchedNames : unfinishedNames).push(
      name,
    )
  }
  return {
    input: local,
    traces: carriers,
    escapes,
    matchedNames,
    unfinishedNames,
  }
}

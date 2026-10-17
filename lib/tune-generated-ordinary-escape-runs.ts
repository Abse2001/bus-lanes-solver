import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { boardBoundaryReports } from "./board-boundary"
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
import type { SimpleRouteJson, Trace, Wire } from "./types"
import { fixedCopper, VectorScene } from "./vector-scene"

interface WireRun {
  start: number
  end: number
  route: Wire[]
}

function wireRuns(trace: Trace): WireRun[] {
  const runs: WireRun[] = []
  let current: WireRun | undefined
  trace.route.forEach((point, index) => {
    if (point.route_type !== "wire") {
      current = undefined
      return
    }
    if (!current || current.route[0].layer !== point.layer) {
      current = { start: index, end: index, route: [] }
      runs.push(current)
    }
    current.end = index
    current.route.push(point)
  })
  return runs.filter((run) => run.route.length > 1 && length(run.route) > 1e-8)
}

/** Spend length inside explicitly owned multivia approaches. Only one complete
 * constant-layer wire run moves at a time; its endpoints, every barrel, the
 * other runs, all carriers, supplied copper and paired paths remain fixed. */
export function* tuneGeneratedOrdinaryEscapeRuns(
  input: SimpleRouteJson,
  carriers: Trace[],
  generatedEscapes: Trace[],
  options: { maxCandidatesPerRun?: number; targetNames?: string[] } = {},
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
  const limit = options.maxCandidatesPerRun ?? 4096
  if (!Number.isInteger(limit) || limit < 1 || limit > 16384) return null
  const owned = new Set([...carriers, ...generatedEscapes]),
    ids = new Map([...owned].map((trace) => [trace.pcb_trace_id, trace]))
  if (
    owned.size !== carriers.length + generatedEscapes.length ||
    ids.size !== owned.size
  )
    throw Error("Carrier and owned escape IDs must be unique and disjoint")
  for (const trace of input.traces ?? [])
    if (ids.has(trace.pcb_trace_id) && !owned.has(trace))
      throw Error(
        `Owned trace ID collides with supplied input: ${trace.pcb_trace_id}`,
      )
  const supplied = (input.traces ?? []).filter((trace) => !owned.has(trace)),
    suppliedInput = { ...input, traces: supplied },
    paired = new Set(
      input.differentialPairs?.flatMap((pair) => pair.connectionNames),
    ),
    requested = options.targetNames ? new Set(options.targetNames) : null,
    clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  let escapes = generatedEscapes,
    local = { ...input, traces: [...supplied, ...escapes] },
    changed = false
  const targets = minimumLengthTargets(local, carriers),
    totalLength = (carrier: Trace) =>
      length(carrier.route) + fixedRouteLength(local, carrier.connection_name!),
    eligible = carriers
      .filter((carrier) => {
        const name = carrier.connection_name!
        return (
          !paired.has(name) &&
          (!requested || requested.has(name)) &&
          (targets.get(name) ?? 0) > totalLength(carrier) + 1e-7 &&
          escapes.some(
            (escape) =>
              escape.connection_name === name &&
              escape.route.filter((point) => point.route_type === "via")
                .length > 1,
          )
        )
      })
      .sort(
        (a, b) =>
          targets.get(b.connection_name!)! -
          totalLength(b) -
          (targets.get(a.connection_name!)! - totalLength(a)),
      )
  for (const carrier of eligible) {
    const name = carrier.connection_name!,
      connection = input.connections.find(
        (candidate) => candidate.name === name,
      )
    if (!connection) continue
    const target = targets.get(name)!,
      maxLength = Math.min(
        Infinity,
        ...(input.buses ?? [])
          .filter(
            (bus) =>
              bus.connectionNames.includes(name) && bus.maxLength !== undefined,
          )
          .map((bus) => bus.maxLength!),
      )
    if (!Number.isFinite(target) || target > maxLength + 1e-7) continue
    const escapeIndices = escapes.flatMap((escape, index) =>
      escape.connection_name === name &&
      escape.route.filter((point) => point.route_type === "via").length > 1
        ? [index]
        : [],
    )
    for (const escapeIndex of escapeIndices) {
      // Back-to-front processing keeps earlier run indices unchanged after a splice.
      const runs = wireRuns(escapes[escapeIndex]).sort(
        (a, b) => b.start - a.start,
      )
      for (const run of runs) {
        if (totalLength(carrier) >= target - 1e-7) break
        const escape = escapes[escapeIndex]
        if (
          escape.coupledSection ||
          !Number.isFinite(run.route[0].width) ||
          run.route[0].width < input.minTraceWidth ||
          run.route.some(
            (point) => Math.abs(point.width - run.route[0].width) > 1e-9,
          )
        )
          continue
        const stub: Trace = {
            ...escape,
            route: run.route,
            curvedSegments: escape.curvedSegments
              ?.filter((index) => index > run.start && index <= run.end)
              .map((index) => index - run.start),
          },
          held: Trace[] = []
        if (run.start)
          held.push({
            ...escape,
            pcb_trace_id: `${escape.pcb_trace_id}_held_prefix`,
            route: escape.route.slice(0, run.start + 1),
          })
        if (run.end < escape.route.length - 1)
          held.push({
            ...escape,
            pcb_trace_id: `${escape.pcb_trace_id}_held_suffix`,
            route: escape.route.slice(run.end),
          })
        const runInput: SimpleRouteJson = {
          ...local,
          connections: local.connections.map((candidate) =>
            candidate.name === name
              ? {
                  ...candidate,
                  pointsToConnect: [run.route[0], run.route.at(-1)!],
                }
              : candidate,
          ),
          traces: [
            ...local.traces.filter((trace) => trace !== escape),
            ...held,
            ...carriers,
          ],
        }
        let tuned: Trace
        try {
          tuned = tuneSmoothLengths(
            runInput,
            [stub],
            new Map([[name, target]]),
            { maxCandidates: limit, packMeanders: true },
          )[0]
        } catch (error) {
          if (!(error instanceof IncompleteLengthTuningError)) {
            yield
            continue
          }
          tuned = error.traces[0]
        }
        if (!tuned || length(tuned.route) <= length(stub.route) + 1e-7) {
          yield
          continue
        }
        if (
          distance(tuned.route[0], run.route[0]) > 1e-8 ||
          distance(tuned.route.at(-1)!, run.route.at(-1)!) > 1e-8
        ) {
          yield
          continue
        }
        // The smooth tuner emits geometric wires; native terminal metadata stays owned by the original endpoints.
        tuned = {
          ...tuned,
          route: [run.route[0], ...tuned.route.slice(1, -1), run.route.at(-1)!],
        }
        const delta = tuned.route.length - run.route.length,
          replacement: Trace = {
            ...escape,
            route: [
              ...escape.route.slice(0, run.start),
              ...tuned.route,
              ...escape.route.slice(run.end + 1),
            ],
            curvedSegments: [
              ...(escape.curvedSegments ?? []).filter(
                (index) => index <= run.start,
              ),
              ...(tuned.curvedSegments ?? []).map((index) => index + run.start),
              ...(escape.curvedSegments ?? [])
                .filter((index) => index > run.end)
                .map((index) => index + delta),
            ].sort((a, b) => a - b),
          },
          proposedEscapes = escapes.map((item, index) =>
            index === escapeIndex ? replacement : item,
          ),
          joined = carriers.map((trace) =>
            joinSignalEscapes(
              trace,
              proposedEscapes.filter(
                (item) => item.connection_name === trace.connection_name,
              ),
            ),
          ),
          own = joined.find((trace) => trace.connection_name === name)!,
          others = joined.filter((trace) => trace.connection_name !== name),
          fullLength =
            length(own.route) + fixedRouteLength(suppliedInput, name),
          // Supplied same-net copper stays hard as well; only explicitly owned
          // contiguous approaches receive the terminal-barrel exemption below.
          suppliedCopper = [
            ...fixedCopper({ ...input, traces: [] }),
            ...fixedCopper({ ...suppliedInput, obstacles: [] }).map((copper) =>
              copper.owners.includes(name) ||
              (connection.source_trace_id &&
                copper.owners.includes(connection.source_trace_id))
                ? { ...copper, owners: [] }
                : copper,
            ),
          ],
          scene = new VectorScene(
            input,
            {
              ...connection,
              pointsToConnect: [run.route[0], run.route.at(-1)!],
            },
            run.route[0].width,
            [
              ...suppliedCopper,
              ...fixedCopper({ ...input, obstacles: [], traces: others }),
            ],
          )
        if (
          !scene.pathVisible(tuned.route) ||
          !tuningPathIsSelfClear(tuned.route, run.route[0].width + clearance) ||
          !createTerminalViaClearanceChecker(runInput, stub, {
            preserveExistingApproach: false,
          })(tuned.route) ||
          !routeAnglesAreConventional([own]) ||
          surfaceBridgeSelfShorts(input, connection, own) ||
          !boardBoundaryReports(input, [own]).valid ||
          fullLength > maxLength + 1e-7 ||
          fullLength > target + 1e-6
        ) {
          yield
          continue
        }
        // Prepared surface inputs use carrier terminals. Restore their unchanged
        // pad ends for complete-route DRC, rather than calling a via an endpoint.
        const byName = new Map(
            joined.map((trace) => [trace.connection_name, trace]),
          ),
          validationInput: SimpleRouteJson = {
            ...input,
            traces: supplied,
            connections: input.connections.map((candidate) => {
              const trace = byName.get(candidate.name)
              return trace
                ? {
                    ...candidate,
                    pointsToConnect: [
                      trace.route[0] as Wire,
                      trace.route.at(-1)! as Wire,
                    ],
                  }
                : candidate
            }),
          }
        const drc = validateRoutedCopperDrc({
          inputSrj: validationInput,
          routedSrj: { ...validationInput, traces: [...supplied, ...joined] },
          clearance,
          allowBlindAndBuriedVias: input.allowBlindAndBuriedVias ?? false,
        } as any)
        if (!drc.valid) {
          yield
          continue
        }
        escapes = proposedEscapes
        local = { ...local, traces: [...supplied, ...escapes] }
        changed = true
        yield
      }
    }
  }
  if (!changed) return null
  const matchedNames: string[] = [],
    unfinishedNames: string[] = []
  for (const carrier of eligible)
    (totalLength(carrier) >= targets.get(carrier.connection_name!)! - 1e-7
      ? matchedNames
      : unfinishedNames
    ).push(carrier.connection_name!)
  return {
    input: local,
    traces: carriers,
    escapes,
    matchedNames,
    unfinishedNames,
  }
}

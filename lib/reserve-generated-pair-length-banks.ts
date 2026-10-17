import {
  getCopperLayerNames,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { boardBoundaryReports } from "./board-boundary"
import { offsetPath } from "./coupled-pair-routing"
import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { signalLayers } from "./flexible-signal-state"
import { distance, length } from "./geometry"
import { joinSignalEscapes } from "./join-signal-escapes"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { fixedRouteLength, pairLengthReports } from "./route-lengths"
import { surfaceBridgeSelfShorts } from "./route-surface-bridge"
import type { Point, SimpleRouteJson, Trace, Via, Wire } from "./types"

export interface GeneratedPairLengthBanks {
  retained: Trace[]
  escapes: Trace[]
}

/** Reserve long common pair banks before ordinary copper occupies the package
 * gap. Only uncurved, parallel shared interiors of explicitly supplied
 * generated carriers may move. Native approaches, vias, fixed copper and
 * sampled curves retain their geometry and provenance.
 *
 * The local U transports both rails through the package gap to an exterior
 * bank. Its reach is solved from the requested full native-to-native length;
 * both outward directions are bounded alternatives, never relaxed clearance.
 * This returns a qualified paired tuple, not full-board routing acceptance. */
export function reserveGeneratedPairLengthBanks(
  native: SimpleRouteJson,
  retained: Trace[],
  escapes: Trace[],
  minimumTotalLengths: ReadonlyMap<string, number>,
): GeneratedPairLengthBanks | null {
  try {
    return reserveBanks(native, retained, escapes, minimumTotalLengths)
  } catch {
    return null
  }
}

function reserveBanks(
  native: SimpleRouteJson,
  retained: Trace[],
  escapes: Trace[],
  minimumTotalLengths: ReadonlyMap<string, number>,
): GeneratedPairLengthBanks | null {
  if (
    [...minimumTotalLengths.values()].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    return null
  const pairs = native.differentialPairs ?? [],
    supplied = native.traces ?? [],
    suppliedIds = new Set(supplied.map((trace) => trace.pcb_trace_id)),
    suppliedOwners = new Set(
      supplied
        .flatMap((trace) => [trace.connection_name, trace.source_trace_id])
        .filter((owner): owner is string => !!owner),
    ),
    paired = new Set(pairs.flatMap((pair) => pair.connectionNames)),
    ownedEscapes = escapes.filter((trace) =>
      paired.has(trace.connection_name!),
    ),
    allPads = native.connections.flatMap(
      (connection) => connection.pointsToConnect,
    ),
    flow = native.connections.reduce(
      (sum, connection) =>
        connection.pointsToConnect.length === 2
          ? {
              x:
                sum.x +
                Math.abs(
                  connection.pointsToConnect[1].x -
                    connection.pointsToConnect[0].x,
                ),
              y:
                sum.y +
                Math.abs(
                  connection.pointsToConnect[1].y -
                    connection.pointsToConnect[0].y,
                ),
            }
          : sum,
      { x: 0, y: 0 },
    ),
    across: "x" | "y" = flow.y >= flow.x ? "x" : "y",
    along: "x" | "y" = across === "x" ? "y" : "x",
    middle =
      allPads.reduce((sum, point) => sum + point[across], 0) /
      Math.max(1, allPads.length),
    domains: Trace[][][] = []
  const total = (trace: Trace) =>
    length(
      joinSignalEscapes(
        trace,
        ownedEscapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      ).route,
    ) + fixedRouteLength(native, trace.connection_name!)
  for (const pair of pairs) {
    const rails = pair.connectionNames.map((name) =>
      retained.find((trace) => trace.connection_name === name),
    )
    if (rails.some((trace) => !trace)) return null
    const current = rails as Trace[],
      targets = current.map(
        (trace) => minimumTotalLengths.get(trace.connection_name!) ?? 0,
      )
    if (
      current.some((trace) => {
        const first = trace.route[0],
          connection = native.connections.find(
            (connection) => connection.name === trace.connection_name,
          )
        return (
          !connection ||
          first?.route_type !== "wire" ||
          !signalLayers(native, connection).includes(first.layer) ||
          trace.route.some(
            (point) =>
              point.route_type !== "wire" || point.layer !== first.layer,
          )
        )
      })
    )
      return null
    if (
      current.every((trace, index) => total(trace) >= targets[index] - 1e-7)
    ) {
      domains.push([current])
      continue
    }
    if (
      current.some(
        (trace) =>
          suppliedIds.has(trace.pcb_trace_id) ||
          (trace.connection_name !== undefined &&
            suppliedOwners.has(trace.connection_name)) ||
          (trace.source_trace_id !== undefined &&
            suppliedOwners.has(trace.source_trace_id)),
      )
    )
      return null
    const choices: Trace[][] = []
    let inspected = 0
    for (
      let i = current[0].coupledSection?.[0] ?? 0;
      i < (current[0].coupledSection?.[1] ?? 0) &&
      choices.length < 8 &&
      inspected < 4096;
      i++
    ) {
      const p = current[0].route[i],
        q = current[0].route[i + 1]
      if (
        p.route_type !== "wire" ||
        q.route_type !== "wire" ||
        current[0].curvedSegments?.includes(i + 1)
      )
        continue
      const span = distance(p, q)
      if (
        span < p.width * 8 ||
        Math.abs(Math.abs(q.x - p.x) - Math.abs(q.y - p.y)) > 1e-7
      )
        continue
      const ux = (q.x - p.x) / span,
        uy = (q.y - p.y) / span,
        width = p.width,
        spacing =
          width +
          (pair.traceGap ??
            native.minTraceToPadEdgeClearance ??
            native.defaultObstacleMargin ??
            0.075)
      for (
        let j = current[1].coupledSection?.[0] ?? 0;
        j < (current[1].coupledSection?.[1] ?? 0) &&
        choices.length < 8 &&
        inspected < 4096;
        j++
      ) {
        inspected++
        const r = current[1].route[j],
          s = current[1].route[j + 1]
        if (
          r.route_type !== "wire" ||
          s.route_type !== "wire" ||
          r.layer !== p.layer ||
          r.width !== width ||
          current[1].curvedSegments?.includes(j + 1)
        )
          continue
        const otherSpan = distance(r, s)
        if (
          otherSpan < width * 8 ||
          Math.abs((s.x - r.x) / otherSpan - ux) > 1e-7 ||
          Math.abs((s.y - r.y) / otherSpan - uy) > 1e-7
        )
          continue
        const offset = -(r.x - p.x) * uy + (r.y - p.y) * ux
        if (Math.abs(Math.abs(offset) - spacing) > 1e-7) continue
        const project = (point: Point) =>
            (point.x - p.x) * ux + (point.y - p.y) * uy,
          trim = width * 2.5,
          lo = Math.max(0, project(r)) + trim,
          hi = Math.min(span, project(s)) - trim
        if (hi - lo < width * 8) continue
        const at = (value: number) => ({
            x: p.x + ux * value - (uy * offset) / 2,
            y: p.y + uy * value + (ux * offset) / 2,
          }),
          start = at(lo),
          end = at(hi),
          sx = Math.sign(end[across] - start[across]),
          sy = -Math.sign(end[along] - start[along]),
          local = (point: Point): Point => ({
            x: sx * point[across],
            y: sy * point[along],
          }),
          world = (point: Point): Point =>
            across === "x"
              ? { x: sx * point.x, y: sy * point.y }
              : { x: sy * point.y, y: sx * point.x },
          originalA = local(start),
          originalB = local(end),
          preferred = (start[across] + end[across]) / 2 >= middle ? sx : -sx
        for (const side of [preferred, -preferred]) {
          const reversed = side > 0,
            A = reversed ? { x: -originalB.x, y: -originalB.y } : originalA,
            B = reversed ? { x: -originalA.x, y: -originalA.y } : originalB,
            pitch = Math.min(width * 3, (A.y - B.y) / 8)
          if (!Number.isFinite(pitch) || pitch <= width) continue
          const build = (reach: number): Trace[] => {
            let path = [
              A,
              { x: A.x + pitch, y: A.y - pitch },
              { x: A.x + pitch, y: A.y - 2 * pitch },
              { x: A.x, y: A.y - 3 * pitch },
              { x: reach + pitch, y: A.y - 3 * pitch },
              { x: reach, y: A.y - 4 * pitch },
              { x: reach, y: B.y + 2 * pitch },
              { x: reach + pitch, y: B.y + pitch },
              { x: B.x - pitch, y: B.y + pitch },
              B,
            ]
            if (reversed)
              path = path
                .map((point) => ({ x: -point.x, y: -point.y }))
                .reverse()
            path = path.map(world)
            const offsets = [
                offsetPath(path, spacing / 2),
                offsetPath(path, -spacing / 2),
              ],
              ordered = offset > 0 ? offsets.toReversed() : offsets
            return current.map((trace, index) => {
              const segment = index ? j : i,
                inserted = ordered[index].map(
                  (point): Wire => ({
                    ...point,
                    route_type: "wire",
                    layer: p.layer,
                    width,
                  }),
                ),
                count = inserted.length
              return {
                ...trace,
                route: [
                  ...trace.route.slice(0, segment + 1),
                  ...inserted,
                  ...trace.route.slice(segment + 1),
                ],
                coupledSection: [
                  trace.coupledSection![0],
                  trace.coupledSection![1] + count,
                ],
                curvedSegments: trace.curvedSegments?.map((value) =>
                  value > segment ? value + count : value,
                ),
              }
            })
          }
          try {
            const initialReach =
                Math.min(A.x, B.x) - Math.max(width * 8, spacing * 4),
              initial = build(initialReach),
              deficit = Math.max(
                0,
                ...initial.map((trace, index) => targets[index] - total(trace)),
              ),
              candidate = build(initialReach - deficit / 2 - width * 1e-6)
            choices.push(candidate)
          } catch {
            /* Degenerate offset paths are ineligible alternatives. */
          }
        }
      }
    }
    if (!choices.length) return null
    domains.push(choices.slice(0, 8))
  }
  let attempts = 0
  const pick = (
    index: number,
    selected: Trace[],
  ): GeneratedPairLengthBanks | null => {
    if (attempts >= 64) return null
    if (index < domains.length) {
      for (const domain of domains[index]) {
        const result = pick(index + 1, [...selected, ...domain])
        if (result) return result
      }
      return null
    }
    attempts++
    const result = [
      ...retained.filter((trace) => !paired.has(trace.connection_name!)),
      ...selected,
    ]
    if (!qualified(native, result, ownedEscapes, minimumTotalLengths))
      return null
    return { retained: result, escapes: [...ownedEscapes] }
  }
  return pick(0, [])
}

function qualified(
  native: SimpleRouteJson,
  retained: Trace[],
  escapes: Trace[],
  targets: ReadonlyMap<string, number>,
) {
  const ownedIds = new Set(
    [...retained, ...escapes].map((trace) => trace.pcb_trace_id),
  )
  if (
    ownedIds.size !== retained.length + escapes.length ||
    (native.traces ?? []).some((trace) => ownedIds.has(trace.pcb_trace_id))
  )
    return false
  const physical = getCopperLayerNames(native.layerCount),
    joined = retained.map((trace) =>
      joinSignalEscapes(
        trace,
        escapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      ),
    ),
    all = [...(native.traces ?? []), ...joined],
    vias = all.flatMap((trace) =>
      trace.route.filter((point): point is Via => point.route_type === "via"),
    )
  for (const trace of joined) {
    const connection = native.connections.find(
        (connection) => connection.name === trace.connection_name,
      ),
      first = trace.route[0],
      last = trace.route.at(-1)
    if (
      !connection ||
      connection.pointsToConnect.length !== 2 ||
      first?.route_type !== "wire" ||
      last?.route_type !== "wire"
    )
      return false
    const [a, b] = connection.pointsToConnect
    if (
      !(
        (distance(first, a) < 1e-7 &&
          first.layer === a.layer &&
          distance(last, b) < 1e-7 &&
          last.layer === b.layer) ||
        (distance(first, b) < 1e-7 &&
          first.layer === b.layer &&
          distance(last, a) < 1e-7 &&
          last.layer === a.layer)
      )
    )
      return false
    if (
      length(trace.route) + fixedRouteLength(native, connection.name) <
        (targets.get(connection.name) ?? 0) - 1e-7 ||
      surfaceBridgeSelfShorts(native, connection, trace)
    )
      return false
    if (
      (native.buses ?? []).some(
        (bus) =>
          bus.connectionNames.includes(connection.name) &&
          bus.maxLength !== undefined &&
          length(trace.route) + fixedRouteLength(native, connection.name) >
            bus.maxLength + 1e-7,
      )
    )
      return false
    for (const point of trace.route) {
      if (![point.x, point.y].every(Number.isFinite)) return false
      if (point.route_type === "wire") {
        if (
          !physical.includes(point.layer) ||
          !Number.isFinite(point.width) ||
          point.width < native.minTraceWidth - 1e-8
        )
          return false
      } else if (
        !Number.isFinite(point.via_diameter) ||
        !Number.isFinite(point.via_hole_diameter) ||
        point.via_diameter! < (native.minViaPadDiameter ?? 0.3) - 1e-8 ||
        point.via_hole_diameter! < (native.minViaHoleDiameter ?? 0.15) - 1e-8 ||
        point.via_hole_diameter! > point.via_diameter! ||
        (!native.allowBlindAndBuriedVias &&
          physical.some((layer) => !point.layers?.includes(layer)))
      )
        return false
    }
  }
  if (
    !routeAnglesAreConventional(joined) ||
    !boardBoundaryReports(native, all).valid ||
    pairLengthReports(native, joined).some((report) => !report.matched) ||
    exteriorPairSpacingReports(native, joined).some(
      (report) => !report.applicable || !report.matched,
    )
  )
    return false
  if (
    vias.some((via, index) =>
      vias.slice(index + 1).some((other) =>
        generatedEscapeHolesConflict(
          native,
          [{ type: "pcb_trace", pcb_trace_id: "first-drill", route: [via] }],
          [
            {
              type: "pcb_trace",
              pcb_trace_id: "second-drill",
              route: [other],
            },
          ],
        ),
      ),
    )
  )
    return false
  try {
    return validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: { ...native, traces: all },
      clearance:
        native.minTraceToPadEdgeClearance ??
        native.defaultObstacleMargin ??
        0.075,
      allowBlindAndBuriedVias: native.allowBlindAndBuriedVias ?? false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid
  } catch {
    return false
  }
}

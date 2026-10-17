import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { boardBoundaryReports } from "./board-boundary"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { chamferPairApproaches } from "./chamfer-pair-approaches"
import { offsetPath } from "./coupled-pair-routing"
import { exteriorPairSpacingReports } from "./exterior-pair-spacing"
import { extendPackageCoupling } from "./extend-package-coupling"
import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import { distance } from "./geometry"
import { joinSignalEscapes } from "./join-signal-escapes"
import { normalizeSurfaceCarriers } from "./normalize-surface-carriers"
import { packageApproachRegions, pointInBox } from "./package-approach-regions"
import { remapCurvedSegments } from "./remap-curved-segments"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { busLengthReports, pairLengthReports } from "./route-lengths"
import { surfaceBridgeSelfShorts } from "./route-surface-bridge"
import { runBoundedRouting } from "./run-bounded-routing"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import { shortenPairApproaches } from "./shorten-pair-approaches"
import { tuneCoupledLengths } from "./tune-coupled-lengths"
import type {
  Point,
  SimpleRouteJson,
  SolverOptions,
  Trace,
  Wire,
} from "./types"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"

export interface GeneratedPairSeed {
  retained: Trace[]
  escapes: Trace[]
}

export interface RefineGeneratedPairSeedOptions {
  maxSteps?: number
  maxNeckCandidates?: number
  /** Optional early total copper reservations. Original input constraints stay
   * unchanged; every supplied minimum is an additional seed search target. */
  minimumTotalLengths?: ReadonlyMap<string, number>
  maxTuningCandidates?: number
}

const reverse = (trace: Trace): Trace => ({
  ...trace,
  route: trace.route.toReversed(),
  coupledSection: trace.coupledSection
    ? [
        trace.route.length - 1 - trace.coupledSection[1],
        trace.route.length - 1 - trace.coupledSection[0],
      ]
    : undefined,
  curvedSegments: trace.curvedSegments
    ?.map((index) => trace.route.length - index)
    .sort((a, b) => a - b),
})

/** Finish explicitly generated pair geometry before ordinary routes consume
 * its package entries and tuning space. Supplied copper is never a candidate
 * for normalization or neck replacement, even if its IDs resemble generated
 * traces. A returned seed is a six-/pair-only result, not full-board routing. */
export function* refineGeneratedPairSeed(
  native: SimpleRouteJson,
  generatedRetained: Trace[],
  generatedEscapes: Trace[],
  _solverOptions: SolverOptions = {},
  options: RefineGeneratedPairSeedOptions = {},
): Generator<void, GeneratedPairSeed | null> {
  const pairs = native.differentialPairs ?? []
  const paired = new Set(pairs.flatMap((pair) => pair.connectionNames))
  const supplied = native.traces ?? []
  if (
    !paired.size ||
    generatedRetained.length !== paired.size ||
    new Set(generatedRetained.map((trace) => trace.connection_name)).size !==
      paired.size ||
    generatedRetained.some(
      (trace) =>
        !paired.has(trace.connection_name!) || supplied.includes(trace),
    ) ||
    generatedEscapes.some(
      (trace) =>
        !paired.has(trace.connection_name!) || supplied.includes(trace),
    ) ||
    // A supplied paired fanout has different ownership from a fresh seed.
    // Preserve that input for the existing fixed-fanout routing strategy.
    supplied.some(
      (trace) =>
        paired.has(trace.connection_name ?? "") ||
        paired.has(trace.source_trace_id ?? ""),
    )
  )
    return null
  const maxSteps = options.maxSteps ?? 30000
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) return null
  for (const [name, target] of options.minimumTotalLengths ?? [])
    if (!paired.has(name) || !Number.isFinite(target) || target < 0) return null
  const localNative: SimpleRouteJson = {
    ...native,
    connections: native.connections.filter((connection) =>
      paired.has(connection.name),
    ),
    buses: (native.buses ?? [])
      .map((bus) => ({
        ...bus,
        connectionNames: bus.connectionNames.filter((name) => paired.has(name)),
      }))
      .filter((bus) => bus.connectionNames.length),
  }
  if (localNative.connections.length !== paired.size) return null
  const retained = structuredClone(generatedRetained)
  const escapes = structuredClone(generatedEscapes)
  const byName = new Map(
    retained.map((trace) => [trace.connection_name, trace]),
  )
  const prepared = normalizeSurfaceCarriers(
    {
      ...localNative,
      connections: localNative.connections.map((connection) => {
        const trace = byName.get(connection.name)!
        return {
          ...connection,
          pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
        }
      }),
      traces: [...supplied, ...escapes],
    },
    retained,
    escapes,
  )
  // An empty curve annotation is semantically unchanged by normalization.
  // Retain it so an already-qualified generated seed also keeps its metadata.
  let traces = prepared.traces.map((trace) =>
    !trace.curvedSegments &&
    byName.get(trace.connection_name)?.curvedSegments?.length === 0
      ? { ...trace, curvedSegments: [] }
      : trace,
  )
  const input = prepared.input
  const join = (values: Trace[]) =>
    values.map((trace) =>
      joinSignalEscapes(
        trace,
        prepared.escapes.filter(
          (escape) => escape.connection_name === trace.connection_name,
        ),
      ),
    )
  const coupling = (values: Trace[]) =>
    exteriorPairSpacingReports(localNative, join(values))
  const qualified = (values: Trace[]) =>
    [
      ...busLengthReports(input, values),
      ...pairLengthReports(input, values),
    ].every(
      (report) =>
        (report.toleranceMm === null || report.matched) &&
        report.withinLengthLimit &&
        report.aboveMinimumLength,
    ) &&
    sharedPairSpacingReports(input, values).every((report) => report.matched) &&
    coupling(values).every((report) => report.matched) &&
    seedCopperIsClear(localNative, input, values, prepared.escapes)
  try {
    // Already qualified generated entries may deliberately reserve native via
    // columns. Keep that geometry instead of re-running approach cleanup.
    if (!options.minimumTotalLengths?.size && qualified(traces))
      return { retained: traces, escapes: prepared.escapes }
    // A pad-layer pair reuses its generated stub. Shape that owned handoff
    // before testing entry replacements; a raw 135-degree handoff otherwise
    // rejects every candidate even when its new coupled neck is clear.
    for (const pair of pairs) {
      const members = pair.connectionNames.map(
        (name) =>
          input.connections.find((connection) => connection.name === name)!,
      )
      const rails = pair.connectionNames.map(
        (name) => traces.find((trace) => trace.connection_name === name)!,
      )
      const shaped = chamferPairApproaches(
        input,
        members,
        rails,
        [
          ...fixedCopper(input),
          ...traces
            .filter(
              (trace) => !pair.connectionNames.includes(trace.connection_name!),
            )
            .flatMap(routeCopper),
        ],
        (rails[0].route[0] as Wire).width,
        input.minTraceToPadEdgeClearance ??
          input.defaultObstacleMargin ??
          0.075,
      )
      traces = traces.map(
        (trace) =>
          shaped.find(
            (candidate) => candidate.connection_name === trace.connection_name,
          ) ?? trace,
      )
      yield
    }
    for (let pass = 0; pass < 3; pass++) {
      traces = chamferOrdinaryCorners(input, traces, fixedCopper(input))
      yield
    }
    const extended = yield* runBoundedRouting(
      extendPackageCoupling(input, traces, { preserveMatching: false }),
      maxSteps,
    )
    if (!extended) return null
    traces = extended
    if (coupling(traces).some((pair) => !pair.matched)) {
      const retried = yield* runBoundedRouting(
        extendPackageCoupling(input, shortenPairApproaches(input, traces), {
          preserveMatching: false,
        }),
        maxSteps,
      )
      if (!retried) return null
      traces = retried
    }
    for (const pair of pairs)
      for (const fromEnd of [false, true]) {
        const before = coupling(traces).find(
          (report) => report.connectionNames[0] === pair.connectionNames[0],
        )!
        if (before.matched) break
        const indices = pair.connectionNames.map((name) =>
          traces.findIndex((trace) => trace.connection_name === name),
        )
        const rails = indices.map((index) =>
          fromEnd ? reverse(traces[index]) : traces[index],
        )
        let attempts = 0
        for (const replacement of coupledEntryNecks(input, rails)) {
          if (++attempts > (options.maxNeckCandidates ?? 48)) break
          const candidate = traces.map((trace, index) => {
            const side = indices.indexOf(index)
            return side < 0
              ? trace
              : fromEnd
                ? reverse(replacement[side])
                : replacement[side]
          })
          if (
            !seedCopperIsClear(localNative, input, candidate, prepared.escapes)
          )
            continue
          const after = coupling(candidate).find(
            (report) => report.connectionNames[0] === pair.connectionNames[0],
          )!
          if (
            after.applicable &&
            (after.matched ||
              (after.separatedExteriorLengthMm ?? Infinity) <
                (before.separatedExteriorLengthMm ?? Infinity) - 1e-7)
          ) {
            traces = candidate
            break
          }
          yield
        }
        yield
      }
    const additional = options.minimumTotalLengths
    if (additional) {
      input.buses = [
        ...(input.buses ?? []),
        ...pairs.flatMap((pair, index) => {
          const target = Math.max(
            ...pair.connectionNames.map((name) => additional.get(name) ?? 0),
          )
          return target > 0
            ? [
                {
                  busId: `generated_pair_seed_minimum_${index}`,
                  connectionNames: pair.connectionNames,
                  minLength: target,
                },
              ]
            : []
        }),
      ]
    }
    traces = tuneCoupledLengths(input, traces, {
      maxCandidates: options.maxTuningCandidates ?? 4096,
      packMeanders: true,
    })
    if (!qualified(traces)) return null
    return { retained: traces, escapes: prepared.escapes }
  } catch {
    return null
  }
}

/** Offer a normal shared neck before a diagonal trunk. Both pad-side channels
 * retain their original upstream copper; their inward 45-degree ramps meet
 * inside the actual package coupling boundary. The existing downstream trunk
 * is rejoined on its first parallel segment, without moving its later copper. */
function* coupledEntryNecks(
  input: SimpleRouteJson,
  rails: Trace[],
): Generator<Trace[]> {
  if (
    rails.length !== 2 ||
    rails.some(
      (trace) =>
        !trace.coupledSection ||
        trace.route.some((point) => point.route_type !== "wire"),
    )
  )
    return
  const pair = input.differentialPairs!.find((pair) =>
    pair.connectionNames.includes(rails[0].connection_name!),
  )!
  const width = (rails[0].route[0] as Wire).width
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const halfSpacing = (width + (pair.traceGap ?? clearance)) / 2
  const region = packageApproachRegions(
    input,
    width + (pair.traceGap ?? clearance) / 2 + clearance,
  ).find((region) =>
    rails.every((rail) => pointInBox(rail.route[0], region.copper)),
  )
  if (!region) return
  const start = {
    x: (rails[0].route[0].x + rails[1].route[0].x) / 2,
    y: (rails[0].route[0].y + rails[1].route[0].y) / 2,
  }
  const end = {
    x: (rails[0].route.at(-1)!.x + rails[1].route.at(-1)!.x) / 2,
    y: (rails[0].route.at(-1)!.y + rails[1].route.at(-1)!.y) / 2,
  }
  const axis: "x" | "y" =
    Math.abs(end.x - start.x) > Math.abs(end.y - start.y) ? "x" : "y"
  const cross: "x" | "y" = axis === "x" ? "y" : "x"
  const fromAxes = (along: number, across: number): Point =>
    axis === "x" ? { x: along, y: across } : { x: across, y: along }
  const sign = Math.sign(end[axis] - start[axis])
  if (!sign) return
  const boundary =
    axis === "x"
      ? sign > 0
        ? region.copper.maxX
        : region.copper.minX
      : sign > 0
        ? region.copper.maxY
        : region.copper.minY
  const starts = rails.map((rail) => rail.coupledSection![0])
  const a = rails[0].route[starts[0]],
    b = rails[0].route[starts[0] + 1]
  const span = distance(a, b)
  if (span < width || rails[0].curvedSegments?.includes(starts[0] + 1)) return
  const u = { x: (b.x - a.x) / span, y: (b.y - a.y) / span }
  if (
    Math.abs(Math.abs(u.x) - Math.SQRT1_2) > 1e-6 ||
    Math.abs(Math.abs(u.y) - Math.SQRT1_2) > 1e-6 ||
    u[axis] * sign <= 0
  )
    return
  const c = rails[1].route[starts[1]],
    d = rails[1].route[starts[1] + 1]
  const mateSpan = distance(c, d)
  if (
    mateSpan < width ||
    rails[1].curvedSegments?.includes(starts[1] + 1) ||
    Math.abs((d.x - c.x) / mateSpan - u.x) > 1e-6 ||
    Math.abs((d.y - c.y) / mateSpan - u.y) > 1e-6
  )
    return
  const n = { x: -u.y, y: u.x }
  const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
  const h = (dot(n, a) + dot(n, c)) / 2
  if (Math.abs(Math.abs(dot(n, a) - dot(n, c)) - 2 * halfSpacing) > 1e-6) return
  const lo = Math.max(dot(u, a), dot(u, c)),
    hi = Math.min(dot(u, b), dot(u, d))
  if (hi - lo < width) return
  const at = lo + Math.min((hi - lo) / 2, 3 * width)
  const anchor = { x: u.x * at + n.x * h, y: u.y * at + n.y * h }
  const channels = rails.map((rail, side) =>
    rail.route
      .slice(0, starts[side])
      .flatMap((point, index) => {
        const next = rail.route[index + 1]
        return next &&
          Math.abs(next[cross] - point[cross]) < 1e-7 &&
          sign * (next[axis] - point[axis]) >= width &&
          !rail.curvedSegments?.includes(index + 1)
          ? [{ index, point, cross: point[cross] }]
          : []
      })
      .toReversed()
      .slice(0, 3),
  )
  for (const first of channels[0])
    for (const second of channels[1]) {
      if (Math.abs(first.cross - second.cross) < 2 * halfSpacing - 1e-7)
        continue
      for (const shift of [0, -width / 8, width / 8])
        for (const depth of [width / 32, width / 8, width / 2, width]) {
          const middle = (first.cross + second.cross) / 2 + shift
          const neck = fromAxes(boundary - sign * depth, middle)
          const corner = fromAxes((h - n[cross] * middle) / n[axis], middle)
          if (
            sign * (corner[axis] - neck[axis]) < width / 2 ||
            dot(u, corner) >= at - width
          )
            continue
          const center = [neck, corner, anchor]
          const candidate = rails.map((rail, side): Trace | null => {
            const channel = side ? second : first
            const offset =
              Math.sign(dot(n, rail.route[starts[side]]) - h) * halfSpacing
            const corridor = offsetPath(center, offset)
            const bend = fromAxes(
              corridor[0][axis] -
                sign * Math.abs(corridor[0][cross] - channel.cross),
              channel.cross,
            )
            if (sign * (bend[axis] - channel.point[axis]) < -1e-7) return null
            const wire = (point: Point): Wire => ({
              ...point,
              route_type: "wire",
              width,
              layer: (rail.route[0] as Wire).layer,
            })
            const route = [...rail.route.slice(0, channel.index + 1)]
            for (const point of [bend, ...corridor])
              if (distance(route.at(-1)!, point) > 1e-8) route.push(wire(point))
            const neckIndex = route.findIndex(
              (point) => distance(point, corridor[0]) < 1e-8,
            )
            const tail = starts[side] + 1
            const delta = route.length - tail
            route.push(...rail.route.slice(tail))
            return {
              ...rail,
              route,
              curvedSegments: remapCurvedSegments(rail, route),
              coupledSection: [neckIndex, rail.coupledSection![1] + delta] as [
                number,
                number,
              ],
            }
          })
          if (candidate.every((trace): trace is Trace => trace !== null))
            yield candidate
        }
    }
}

function seedCopperIsClear(
  native: SimpleRouteJson,
  input: SimpleRouteJson,
  traces: Trace[],
  escapes: Trace[],
) {
  if (!routeAnglesAreConventional(traces)) return false
  const copper = [...fixedCopper(input), ...traces.flatMap(routeCopper)]
  const joined = traces.map((trace) =>
    joinSignalEscapes(
      trace,
      escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
  for (const trace of joined) {
    const connection = native.connections.find(
      (connection) => connection.name === trace.connection_name,
    )
    if (!connection || trace.route.length < 2) return false
    const ends = [trace.route[0], trace.route.at(-1)!]
    const matches = (
      point: Point & { layer?: string },
      end: Trace["route"][number],
    ) =>
      end.route_type === "wire" &&
      point.layer === end.layer &&
      distance(point, end) < 1e-7
    if (
      !connection.pointsToConnect.every((point) =>
        ends.some((end) => matches(point, end)),
      ) ||
      !ends.every((end) =>
        connection.pointsToConnect.some((point) => matches(point, end)),
      ) ||
      trace.route.some(
        (point) =>
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          (point.route_type === "wire" &&
            (!Number.isFinite(point.width) ||
              point.width < native.minTraceWidth - 1e-7)),
      )
    )
      return false
  }
  if (
    !boardBoundaryReports(native, [...(native.traces ?? []), ...joined]).valid
  )
    return false
  for (const [index, trace] of traces.entries()) {
    const connection = input.connections.find(
      (connection) => connection.name === trace.connection_name,
    )!
    const width = (trace.route[0] as Wire).width
    if (
      !new VectorScene(input, connection, width, copper).pathVisible(
        trace.route,
      ) ||
      surfaceBridgeSelfShorts(
        native,
        native.connections.find(
          (connection) => connection.name === trace.connection_name,
        )!,
        joined[index],
      )
    )
      return false
    if (
      generatedEscapeHolesConflict(
        native,
        [joined[index]],
        [
          ...(native.traces ?? []),
          ...joined.filter((_, other) => other !== index),
        ],
      )
    )
      return false
  }
  // Supplied copper may be an unrelated power net without a routing request.
  // Give its explicit name to the independent checker without inventing
  // terminals or excluding that copper from the obstacle/trace audit.
  const known = new Set(native.connections.map((connection) => connection.name))
  const suppliedNames = new Set(
    (native.traces ?? [])
      .map((trace) => trace.connection_name)
      .filter((name): name is string => !!name && !known.has(name)),
  )
  const validationInput = {
    ...native,
    connections: [
      ...native.connections,
      ...[...suppliedNames].map((name) => ({ name, pointsToConnect: [] })),
    ],
  }
  return validateRoutedCopperDrc({
    inputSrj: validationInput,
    routedSrj: {
      ...validationInput,
      traces: [...(native.traces ?? []), ...joined],
    },
    clearance:
      native.minTraceToPadEdgeClearance ??
      native.defaultObstacleMargin ??
      0.075,
    allowBlindAndBuriedVias: native.allowBlindAndBuriedVias,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).valid
}

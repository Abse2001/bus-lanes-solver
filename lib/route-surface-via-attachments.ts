import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { boardBoundaryReports } from "./board-boundary"
import { criticalSurfaceGridOrigins } from "./critical-surface-grid-origins"
import { generatedEscapeHolesConflict } from "./expanded-signal-sites"
import { distance, length, simplify } from "./geometry"
import { joinSignalEscapes } from "./join-signal-escapes"
import {
  nativeTerminalPoints,
  nativeTerminalTolerance,
} from "./native-terminal-sites"
import { signalWidth } from "./repair-bus-dogbones"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { maximumCarrierLength } from "./route-lengths"
import {
  routeSurfaceBridge,
  surfaceBridgeEligible,
  surfaceBridgeSelfShorts,
  type SurfaceBridgeOptions,
  type SurfaceBridgeRoute,
} from "./route-surface-bridge"
import { SoftCopperCostIndex } from "./soft-copper-cost"
import type {
  Connection,
  Point,
  SimpleRouteJson,
  Terminal,
  Trace,
  Via,
} from "./types"
import { fixedCopper, VectorScene } from "./vector-scene"
import { connectors } from "./vector-visibility"

export interface SurfaceViaAttachmentOptions extends SurfaceBridgeOptions {
  /** Caller-computed owned endpoint domains. Each path starts at a native
   * pad and reaches the opposite surface through one full-stack barrel.
   * Every primitive is revalidated against current hard copper before reuse. */
  candidateEscapes?: readonly Trace[]
  /** Native pad-to-via planar length, independently bounded at each end. */
  maxAttachmentLength?: number
  /** Bounded endpoint portfolio, including distinct narrow-channel phases. */
  maxEndpointCandidates?: number
  maxAttachmentPairs?: number
}

interface Site {
  point: Terminal
  escape: Trace
  length: number
  cost: number
  phase: number
}

/** Supplemental four-via domain: each native pad gets an independently phased
 * local manufactured handoff. The ordinary bridge then joins their exact
 * opposite-surface endpoints, with at most two further barrels. This explicit
 * mode is useful even when a different ordinary bridge path already exists.
 * Input connections and supplied fanout copper remain unchanged. */
export function* routeSurfaceViaAttachments(
  input: SimpleRouteJson,
  connection: Connection,
  options: SurfaceViaAttachmentOptions = {},
): Generator<void, SurfaceBridgeRoute | null> {
  if (
    options.maxVias !== 4 ||
    !surfaceBridgeEligible(input, connection) ||
    input.allowedLayers?.length !== 2
  )
    return null
  const physical = getCopperLayerNames(input.layerCount),
    pads = connection.pointsToConnect,
    surface = pads[0].layer,
    opposite = surface === physical[0] ? physical.at(-1)! : physical[0],
    step = options.gridStep ?? Math.min(0.05, signalWidth(input, connection)),
    reach = options.maxAttachmentLength ?? 0.65,
    samplingStep = Math.max(step, reach / 64),
    limit = options.maxEndpointCandidates ?? 6,
    pairLimit = options.maxAttachmentPairs ?? 16,
    diameter = input.minViaPadDiameter ?? 0.3,
    hole = input.minViaHoleDiameter ?? 0.15,
    width = signalWidth(input, connection),
    clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    holeClearance = Math.max(
      input.minViaHoleEdgeToViaHoleEdgeClearance ?? 0.1,
      (
        input as SimpleRouteJson & {
          minPlatedHoleDrillEdgeToDrillEdgeClearance?: number
        }
      ).minPlatedHoleDrillEdgeToDrillEdgeClearance ?? 0,
    )
  if (
    ![step, reach, diameter, hole, width].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    hole > diameter ||
    !Number.isFinite(holeClearance) ||
    holeClearance < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 32 ||
    !Number.isInteger(pairLimit) ||
    pairLimit < 1 ||
    pairLimit > 256 ||
    (options.gridOrigin &&
      ![options.gridOrigin.x, options.gridOrigin.y].every(Number.isFinite)) ||
    (options.history &&
      (!Number.isFinite(options.history.step) || options.history.step <= 0)) ||
    (options.softNetWeights &&
      Object.values(options.softNetWeights).some(
        (weight) => !Number.isFinite(weight) || weight < 0,
      ))
  )
    return null
  const budget = Math.min(
    options.maxLength ?? Infinity,
    maximumCarrierLength(input, connection.name),
  )
  if (budget < distance(pads[0], pads[1]) - 1e-8) return null
  const fixed = fixedCopper(input),
    scene = new VectorScene(input, connection, width, fixed),
    lands = physical.map(
      (layer) =>
        new VectorScene(
          input,
          {
            ...connection,
            pointsToConnect: pads.map((pad) => ({ ...pad, layer })),
          },
          diameter,
          fixed,
        ),
    ),
    oldVias = (input.traces ?? []).flatMap((trace) =>
      trace.route.filter((point): point is Via => point.route_type === "via"),
    ),
    nativePads = nativeTerminalPoints(input, connection),
    soft = options.softTraces?.length
      ? new SoftCopperCostIndex(
          input,
          connection,
          options.softTraces,
          options.softNetWeights,
        )
      : undefined,
    softPenalty = options.softPenalty ?? 20,
    binary = options.softConflictCost === "binary",
    preferred = (input.buses ?? [])
      .filter((bus) => bus.connectionNames.includes(connection.name))
      .flatMap((bus) => [bus.preferredLayer, ...(bus.preferredLayers ?? [])])
      .find((layer) => layer && input.allowedLayers!.includes(layer)),
    history = options.history,
    columns = history
      ? Math.floor((history.bounds.maxX - history.bounds.minX) / history.step) +
        1
      : 0,
    rows = history
      ? Math.floor((history.bounds.maxY - history.bounds.minY) / history.step) +
        1
      : 0,
    historic = (at: Point, layer: string) => {
      if (!history) return 0
      const x = Math.round((at.x - history.bounds.minX) / history.step),
        y = Math.round((at.y - history.bounds.minY) / history.step)
      return x >= 0 && x < columns && y >= 0 && y < rows
        ? (history.values[layer === surface ? 0 : 1]?.[x + y * columns] ?? 0)
        : 0
    },
    connectorCost = (path: Point[], layer = surface, actualWidth = width) => {
      let cost = 0
      const layerCost =
        preferred && preferred !== layer
          ? (options.nonPreferredLayerCost ?? 2)
          : 1
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1],
          b = path[i],
          span = distance(a, b),
          count = Math.max(1, Math.min(64, Math.ceil(span / samplingStep)))
        let previous = a
        for (let j = 1; j <= count; j++) {
          const next = {
            x: a.x + ((b.x - a.x) * j) / count,
            y: a.y + ((b.y - a.y) * j) / count,
          }
          cost +=
            (span / count) *
            (layerCost +
              historic(next, layer) +
              softPenalty *
                (soft?.edgeCost(
                  previous,
                  next,
                  layer,
                  actualWidth / 2,
                  clearance,
                  binary,
                ) ?? 0))
          previous = next
        }
      }
      return cost
    },
    usedIds = new Set(
      [...(input.traces ?? []), ...(options.softTraces ?? [])].map(
        (trace) => trace.pcb_trace_id,
      ),
    ),
    uniqueId = (base: string) => {
      let id = base,
        suffix = 0
      while (usedIds.has(id)) id = `${base}_${++suffix}`
      usedIds.add(id)
      return id
    },
    ends: Site[][] = [[], []],
    wireScenes = new Map<string, VectorScene>(),
    wireScene = (layer: string, actualWidth: number) => {
      const key = `${layer}:${actualWidth}`
      let result = wireScenes.get(key)
      if (!result) {
        result = new VectorScene(
          input,
          {
            ...connection,
            pointsToConnect: pads.map((pad) => ({ ...pad, layer })),
          },
          actualWidth,
          fixed,
        )
        wireScenes.set(key, result)
      }
      return result
    }
  for (const end of [0, 1]) {
    const pad = pads[end],
      local = { ...connection, pointsToConnect: [pad, pad] },
      origins = [
        { x: input.bounds.minX, y: input.bounds.minY },
        ...(options.gridOrigin ? [options.gridOrigin] : []),
        ...criticalSurfaceGridOrigins(input, local, step, 4),
      ],
      candidates = new Map<string, Site>()
    for (const [index, supplied] of (
      options.candidateEscapes ?? []
    ).entries()) {
      if (
        supplied.connection_name !== connection.name ||
        (supplied.source_trace_id !== undefined &&
          supplied.source_trace_id !==
            (connection.source_trace_id ?? connection.name)) ||
        !supplied.route.length ||
        supplied.route[0].route_type !== "wire" ||
        supplied.route[0].layer !== surface ||
        distance(supplied.route[0], pad) > 1e-8
      )
        continue
      const viaIndexes = supplied.route.flatMap((point, i) =>
          point.route_type === "via" ? [i] : [],
        ),
        viaIndex = viaIndexes[0],
        via = supplied.route[viaIndex] as Via | undefined,
        last = supplied.route.at(-1)!
      if (
        viaIndexes.length !== 1 ||
        viaIndex < 1 ||
        viaIndex >= supplied.route.length - 1 ||
        !via ||
        ![via.x, via.y].every(Number.isFinite) ||
        ![via.via_diameter ?? diameter, via.via_hole_diameter ?? hole].every(
          Number.isFinite,
        ) ||
        via.from_layer !== surface ||
        via.to_layer !== opposite ||
        Math.abs((via.via_diameter ?? diameter) - diameter) > 1e-8 ||
        Math.abs((via.via_hole_diameter ?? hole) - hole) > 1e-8 ||
        (via.layers &&
          (via.layers.length !== physical.length ||
            new Set(via.layers).size !== physical.length ||
            physical.some((layer) => !via.layers!.includes(layer)))) ||
        last.route_type !== "wire" ||
        last.layer !== opposite ||
        nativePads.some(
          (native) => distance(native, via) <= nativeTerminalTolerance,
        ) ||
        oldVias.some(
          (old) =>
            distance(old, via) <
            hole / 2 +
              (old.via_hole_diameter ?? hole) / 2 +
              holeClearance -
              1e-8,
        ) ||
        lands.some((land) => !land.visible(via, via))
      )
        continue
      let valid = true,
        cost = 0
      for (let i = 0; i < supplied.route.length; i++) {
        const point = supplied.route[i],
          previous = supplied.route[i - 1]
        if (point.route_type === "via") {
          if (!previous || distance(previous, point) > 1e-8) valid = false
          continue
        }
        if (
          ![point.x, point.y, point.width].every(Number.isFinite) ||
          point.width < width - 1e-8 ||
          point.layer !== (i < viaIndex ? surface : opposite) ||
          !wireScene(point.layer, point.width).visible(point, point)
        ) {
          valid = false
          break
        }
        if (!previous) continue
        if (previous.route_type === "via") {
          if (distance(previous, point) > 1e-8) valid = false
        } else {
          if (
            !wireScene(
              point.layer,
              Math.max(previous.width, point.width),
            ).visible(previous, point)
          )
            valid = false
          cost += connectorCost(
            [previous, point],
            point.layer,
            Math.max(previous.width, point.width),
          )
        }
      }
      if (!valid) continue
      const escape = structuredClone(supplied)
      escape.pcb_trace_id = uniqueId(
        `surface_via_computed_${connection.name}_${end}_${index}`,
      )
      escape.source_trace_id = connection.source_trace_id ?? connection.name
      escape.route[viaIndex] = {
        ...via,
        layers: [...physical],
        via_diameter: diameter,
        via_hole_diameter: hole,
      }
      if (
        !routeAnglesAreConventional([escape]) ||
        !boardBoundaryReports(input, [escape]).valid ||
        surfaceBridgeSelfShorts(input, connection, escape)
      )
        continue
      cost +=
        softPenalty *
        (soft?.landingCost(
          via,
          diameter / 2,
          clearance,
          hole / 2,
          holeClearance,
          binary,
        ) ?? 0)
      const key = `${last.x.toFixed(8)},${last.y.toFixed(8)}`,
        candidate = {
          point: { x: last.x, y: last.y, layer: opposite },
          escape,
          length: length(escape.route),
          cost,
          phase: origins.length + index,
        }
      if (!candidates.has(key) || candidates.get(key)!.cost > cost)
        candidates.set(key, candidate)
    }
    for (const [phase, requestedOrigin] of origins.entries()) {
      const origin = {
        x: input.bounds.minX + ((requestedOrigin.x - input.bounds.minX) % step),
        y: input.bounds.minY + ((requestedOrigin.y - input.bounds.minY) % step),
      }
      // This is a bounded supplemental domain, even if the caller requests a
      // microscopic carrier grid. Subsample integer lattice offsets around the
      // nearest pad cell, retaining this phase rather than shifting it.
      const stride = Math.max(1, Math.ceil((2 * reach) / (64 * step))),
        centerX = Math.round((pad.x - origin.x) / step),
        centerY = Math.round((pad.y - origin.y) / step),
        firstX =
          centerX +
          Math.ceil(((pad.x - reach - origin.x) / step - centerX) / stride) *
            stride,
        lastX = Math.floor((pad.x + reach - origin.x) / step),
        firstY =
          centerY +
          Math.ceil(((pad.y - reach - origin.y) / step - centerY) / stride) *
            stride,
        lastY = Math.floor((pad.y + reach - origin.y) / step)
      const countX = Math.floor((lastX - firstX) / stride) + 1,
        countY = Math.floor((lastY - firstY) / stride) + 1
      if (
        ![stride, firstX, lastX, firstY, lastY, countX, countY].every(
          Number.isFinite,
        ) ||
        countX > 66 ||
        countY > 66
      )
        return null
      // Counted loops also terminate when large finite world coordinates have
      // less floating-point resolution than an individual lattice increment.
      for (let x = 0; x < countX; x++)
        for (let y = 0; y < countY; y++) {
          const ix = firstX + x * stride,
            iy = firstY + y * stride
          const at = { x: origin.x + ix * step, y: origin.y + iy * step }
          if (
            distance(pad, at) > reach + 1e-8 ||
            // Search meaningful local approaches, rather than almost-coincident
            // offsets that only evade the native via-in-pad coincidence test.
            distance(pad, at) < step / 2 - 1e-8 ||
            nativePads.some((native) => distance(native, at) <= 1e-6) ||
            oldVias.some(
              (via) =>
                distance(via, at) <
                hole / 2 +
                  (via.via_hole_diameter ?? hole) / 2 +
                  holeClearance -
                  1e-8,
            ) ||
            lands.some((land) => !land.visible(at, at))
          )
            continue
          const paths = connectors(pad, at)
            .map((path) => simplify(path))
            .filter(
              (path) => length(path) <= reach + 1e-8 && scene.pathVisible(path),
            )
            .map((path) => ({ path, cost: connectorCost(path) }))
            .sort((a, b) => a.cost - b.cost)
          for (const { path, cost } of paths) {
            const point = { ...at, layer: opposite },
              via: Via = {
                ...at,
                route_type: "via",
                from_layer: surface,
                to_layer: opposite,
                layers: physical,
                via_diameter: diameter,
                via_hole_diameter: hole,
              },
              escape: Trace = {
                type: "pcb_trace",
                pcb_trace_id: uniqueId(
                  `surface_via_attachment_${connection.name}_${end}`,
                ),
                connection_name: connection.name,
                source_trace_id: connection.source_trace_id ?? connection.name,
                route: [
                  ...path.map((p) => ({
                    ...p,
                    route_type: "wire" as const,
                    layer: surface,
                    width,
                  })),
                  via,
                  { ...point, route_type: "wire", width },
                ],
              }
            if (
              !routeAnglesAreConventional([escape]) ||
              surfaceBridgeSelfShorts(input, connection, escape)
            )
              continue
            const key = `${at.x.toFixed(8)},${at.y.toFixed(8)}`,
              score =
                cost +
                softPenalty *
                  (soft?.landingCost(
                    at,
                    diameter / 2,
                    clearance,
                    hole / 2,
                    holeClearance,
                    binary,
                  ) ?? 0),
              candidate = {
                point,
                escape,
                length: length(path),
                cost: score,
                phase,
              }
            if (!candidates.has(key) || candidates.get(key)!.cost > score)
              candidates.set(key, candidate)
            break
          }
        }
      yield
    }
    const ordered = [...candidates.values()].sort(
      (a, b) =>
        a.cost - b.cost ||
        a.length - b.length ||
        a.point.x - b.point.x ||
        a.point.y - b.point.y,
    )
    // Preserve one legal site from each phase before filling by cost. Otherwise
    // many adjacent default cells can hide the only off-grid escape channel.
    for (const site of ordered)
      if (
        !ends[end].some((other) => other.phase === site.phase) &&
        ends[end].length < limit
      )
        ends[end].push(site)
    // A cluster of very short approaches can land in one enclosed copper
    // pocket. Also retain distant local interstices in distinct directions,
    // while keeping the same bounded endpoint and pair budgets.
    const sectors = new Set<number>()
    for (const site of [...ordered].sort(
      (a, b) =>
        distance(pad, b.point) - distance(pad, a.point) || a.cost - b.cost,
    )) {
      const sector =
        (Math.round(
          Math.atan2(site.point.y - pad.y, site.point.x - pad.x) /
            (Math.PI / 4),
        ) +
          8) %
        8
      if (sectors.has(sector)) continue
      sectors.add(sector)
      if (!ends[end].includes(site) && ends[end].length < limit)
        ends[end].push(site)
    }
    for (const site of ordered)
      if (!ends[end].includes(site) && ends[end].length < limit)
        ends[end].push(site)
    if (!ends[end].length) return null
  }
  const rankedPairs = ends[0]
      .flatMap((a) => ends[1].map((b) => ({ a, b, cost: a.cost + b.cost })))
      .sort((a, b) => a.cost - b.cost),
    pairs: typeof rankedPairs = [],
    seenStarts = new Set<Site>(),
    seenEnds = new Set<Site>()
  // Preserve endpoint diversity through the pair cap too. Merely retaining
  // phases at each end is insufficient if the cheapest Cartesian prefix
  // contains only one end's first few sites.
  for (const pair of rankedPairs)
    if (
      pairs.length < pairLimit &&
      (!seenStarts.has(pair.a) || !seenEnds.has(pair.b))
    ) {
      pairs.push(pair)
      seenStarts.add(pair.a)
      seenEnds.add(pair.b)
    }
  for (const pair of rankedPairs)
    if (pairs.length < pairLimit && !pairs.includes(pair)) pairs.push(pair)
  for (const { a, b } of pairs) {
    const outer = [a.escape, b.escape],
      usedLength = a.length + b.length
    if (
      usedLength > budget ||
      generatedEscapeHolesConflict(input, [a.escape], [b.escape])
    )
      continue
    const localInput = {
        ...input,
        traces: [...(input.traces ?? []), ...outer],
      },
      localConnection = { ...connection, pointsToConnect: [a.point, b.point] },
      body = yield* routeSurfaceBridge(localInput, localConnection, {
        ...options,
        maxVias: 2,
        maxLength: (options.maxLength ?? Infinity) - usedLength,
        // Core orders its cost planes by native layer, now opposite to the
        // original pad layer. Preserve the caller's physical history mapping.
        history: history
          ? { ...history, values: [history.values[1], history.values[0]] }
          : undefined,
      })
    if (!body) continue
    const escapes = outer.map((escape, end) => {
      const inner = body.escapes.find(
        (trace) =>
          trace.route[0].route_type === "wire" &&
          trace.route[0].layer === opposite &&
          distance(trace.route[0], end ? b.point : a.point) < 1e-8,
      )
      if (!inner) return undefined
      const offset = escape.route.length - 1
      const curves = [
        ...(escape.curvedSegments ?? []),
        ...(inner.curvedSegments?.map((index) => index + offset) ?? []),
      ]
      return {
        ...escape,
        pcb_trace_id: uniqueId(
          `surface_via_attachment_combined_${connection.name}_${end}`,
        ),
        route: [...escape.route.slice(0, -1), ...inner.route],
        curvedSegments: curves.length ? curves : undefined,
      }
    })
    if (escapes.some((escape) => !escape)) continue
    const result = { carrier: body.carrier, escapes: escapes as Trace[] },
      joined = joinSignalEscapes(result.carrier, result.escapes),
      vias = joined.route.filter(
        (point): point is Via => point.route_type === "via",
      )
    if (
      vias.length > 4 ||
      vias.length < 2 ||
      length(joined.route) > budget + 1e-8 ||
      !routeAnglesAreConventional([joined]) ||
      !boardBoundaryReports(input, [joined]).valid ||
      surfaceBridgeSelfShorts(input, connection, joined) ||
      vias.some((via, i) =>
        vias
          .slice(i + 1)
          .some((other) =>
            generatedEscapeHolesConflict(
              input,
              [{ ...joined, route: [via] }],
              [{ ...joined, route: [other] }],
            ),
          ),
      )
    )
      continue
    return result
  }
  return null
}

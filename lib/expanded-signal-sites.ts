import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { distance, length } from "./geometry"
import { GridVisibilitySearch } from "./grid-visibility"
import { tuningPathIsSelfClear } from "./length-tuning"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { signalWidth } from "./repair-bus-dogbones"
import { routeAnglesAreConventional } from "./route-angle-validation"
import type { Connection, SimpleRouteJson, Terminal, Trace, Via } from "./types"
import { fixedCopper, VectorScene } from "./vector-scene"

export interface ExpandedSignalSite {
  point: Terminal
  escape: Trace
  length: number
}

export interface ExpandedSignalSiteChoice {
  connection: Connection
  escapes: Trace[]
  route: Trace["route"]
  length: number
}

/** Internal diagnostics distinguish a bounded search exit from a failed search.
 * Cancellation never reports a completed bounded search. */
export interface ExpandedSignalSiteSearchOptions {
  onSearchIncomplete?: () => void
  /** Preserve the coarse policy unless a failed caller explicitly widens it. */
  allowFineNativeApproachRetry?: boolean
  /** Only a completed, empty coarse endpoint can defer an eligible retry. */
  onDeferredFineNativeApproachRetry?: () => void
}

const viaHoleClearance = (input: SimpleRouteJson) =>
  Math.max(
    input.minViaHoleEdgeToViaHoleEdgeClearance ?? 0.1,
    (
      input as SimpleRouteJson & {
        minPlatedHoleDrillEdgeToDrillEdgeClearance?: number
      }
    ).minPlatedHoleDrillEdgeToDrillEdgeClearance ?? 0,
  )

const escapeVias = new WeakMap<Trace[], Via[]>()
/** Drill clearance also applies between independently negotiated owned
 * escapes. Pad copper clearance alone can be weaker than this rule. */
export function generatedEscapeHolesConflict(
  input: SimpleRouteJson,
  first: Trace[],
  second: Trace[],
): boolean {
  const vias = (escapes: Trace[]) => {
    let result = escapeVias.get(escapes)
    if (!result) {
      result = escapes.flatMap((escape) =>
        escape.route.filter(
          (point): point is Via => point.route_type === "via",
        ),
      )
      escapeVias.set(escapes, result)
    }
    return result
  }
  const physical = getCopperLayerNames(input.layerCount)
  const span = (via: Via) =>
    via.layers ??
    (input.allowBlindAndBuriedVias
      ? physical.slice(
          Math.min(
            physical.indexOf(via.from_layer),
            physical.indexOf(via.to_layer),
          ),
          Math.max(
            physical.indexOf(via.from_layer),
            physical.indexOf(via.to_layer),
          ) + 1,
        )
      : physical)
  for (const a of vias(first))
    for (const b of vias(second))
      if (
        distance(a, b) <
          (a.via_hole_diameter ?? input.minViaHoleDiameter ?? 0.15) / 2 +
            (b.via_hole_diameter ?? input.minViaHoleDiameter ?? 0.15) / 2 +
            viaHoleClearance(input) -
            1e-8 &&
        span(a).some((layer) => span(b).includes(layer))
      )
        return true
  return false
}

/** Keep a bounded set of successful endpoint combinations. A multi-terminal
 * carrier search retains sites that actually reach the opposite package; short
 * surface stubs alone can all end in the same enclosed via-cell pocket. */
export function* expandedSignalSiteChoices(
  input: SimpleRouteJson,
  connection: Connection,
  targetLayer: string,
  limit = 8,
  options: ExpandedSignalSiteSearchOptions = {},
): Generator<void, ExpandedSignalSiteChoice[]> {
  const ends = yield* expandedSignalSites(
    input,
    connection,
    targetLayer,
    options,
  )
  if (ends.some((sites) => !sites.length)) return []
  const available = ends.map((sites) => [...sites])
  const choices: ExpandedSignalSiteChoice[] = []
  const fixed = fixedCopper(input),
    width = signalWidth(input, connection)
  let attempts = 0
  while (
    choices.length < limit &&
    attempts++ < limit * 4 &&
    available.every((sites) => sites.length)
  ) {
    const starts = available[0].map((site) => site.point),
      goals = available[1].map((site) => site.point)
    const local = { ...connection, pointsToConnect: [starts[0], goals[0]] }
    const scene = new VectorScene(input, local, width, fixed)
    const search = new GridVisibilitySearch(
      scene,
      starts[0],
      goals[0],
      [],
      0,
      undefined,
      {
        checkReachability: true,
        allTerminalAttachments: true,
        starts,
        ends: goals,
      },
    )
    try {
      let steps = 0
      while (!search.solved && !search.failed && steps++ < 10000) {
        search.step()
        yield
      }
      if (!search.solved) {
        if (!search.failed) options.onSearchIncomplete?.()
        break
      }
      const a = available[0].find(
          (site) => distance(site.point, search.result[0]) < 1e-6,
        )!,
        b = available[1].find(
          (site) => distance(site.point, search.result.at(-1)!) < 1e-6,
        )!
      // Alternate the package supplying a new endpoint, retaining the sole
      // surviving site when only the opposite package can still vary.
      let end = (attempts - 1) % 2
      if (available[end].length === 1 && available[1 - end].length > 1)
        end = 1 - end
      const used = end ? b : a
      available[end].splice(available[end].indexOf(used), 1)
      if (generatedEscapeHolesConflict(input, [a.escape], [b.escape])) continue
      let route = reduceOrdinaryTurns(search.result, scene).map((p) => ({
        ...p,
        route_type: "wire" as const,
        layer: targetLayer,
        width,
      }))
      const carrier: Trace = {
        type: "pcb_trace",
        pcb_trace_id: `expanded_carrier_${connection.name}`,
        connection_name: connection.name,
        route,
      }
      route = chamferOrdinaryCorners(
        { ...input, connections: [local] },
        [carrier],
        fixed,
      )[0].route as typeof route
      if (
        !scene.pathVisible(route) ||
        !routeAnglesAreConventional([{ ...carrier, route }]) ||
        !tuningPathIsSelfClear(
          route,
          width +
            (input.minTraceToPadEdgeClearance ??
              input.defaultObstacleMargin ??
              0.075),
        )
      )
        continue
      choices.push({
        connection: { ...connection, pointsToConnect: [a.point, b.point] },
        escapes: [a.escape, b.escape],
        route,
        length: length(route) + a.length + b.length,
      })
    } finally {
      search.cancel()
    }
    yield
  }
  return choices
}

/** New solver-owned terminal escapes may use a nearby interstitial cell beyond
 * the four immediately adjacent cells. Derive sites from the native pad pitch,
 * retain a full-stack manufactured barrel, and bound the native-layer approach
 * by both 2 mm and 2.5 pad pitches. Supplied copper is read-only. */
export function* expandedSignalSites(
  input: SimpleRouteJson,
  connection: Connection,
  targetLayer: string,
  options: ExpandedSignalSiteSearchOptions = {},
): Generator<void, [ExpandedSignalSite[], ExpandedSignalSite[]]> {
  const ends: [ExpandedSignalSite[], ExpandedSignalSite[]] = [[], []]
  let deferredFineNativeApproachRetry = false
  const physical = getCopperLayerNames(input.layerCount)
  if (!physical.includes(targetLayer)) return ends
  const fixed = fixedCopper(input)
  const width = signalWidth(input, connection)
  const diameter = input.minViaPadDiameter ?? 0.3
  const hole = input.minViaHoleDiameter ?? 0.15
  const holeClearance = viaHoleClearance(input)
  if (
    !Number.isFinite(diameter) ||
    diameter <= 0 ||
    !Number.isFinite(hole) ||
    hole <= 0 ||
    hole > diameter ||
    !Number.isFinite(holeClearance) ||
    holeClearance < 0
  )
    return ends
  const existingVias = (input.traces ?? []).flatMap((t) =>
    t.route.filter((p) => p.route_type === "via"),
  ) as Via[]
  for (const end of [0, 1]) {
    const pad = connection.pointsToConnect[end]
    if (pad.layer === targetLayer) {
      ends[end].push({
        point: pad,
        length: 0,
        escape: {
          type: "pcb_trace",
          pcb_trace_id: `expanded_surface_${connection.name}_${end}`,
          connection_name: connection.name,
          source_trace_id: connection.source_trace_id ?? connection.name,
          route: [{ ...pad, route_type: "wire", width }],
        },
      })
      continue
    }
    const owner = input.obstacles.find(
      (o) => o.componentId && distance(o.center, pad) < 1e-4,
    )
    if (!owner) continue
    const pitch = Math.min(
      ...input.obstacles
        .filter((o) => o.componentId === owner.componentId)
        .map((o) => distance(o.center, pad))
        .filter((d) => d > 1e-4),
    )
    if (!Number.isFinite(pitch)) continue
    const surfaceLimit = Math.min(2, 2.5 * pitch)
    const candidates: Terminal[] = []
    for (let ix = -5; ix <= 5; ix++)
      for (let iy = -5; iy <= 5; iy++) {
        if (!ix && !iy) continue
        const point = {
          x: pad.x + (ix * pitch) / 2,
          y: pad.y + (iy * pitch) / 2,
          layer: targetLayer,
        }
        if (distance(pad, point) <= surfaceLimit + 1e-8) candidates.push(point)
      }
    candidates.sort(
      (a, b) => distance(pad, a) - distance(pad, b) || a.x - b.x || a.y - b.y,
    )
    const viaScenes = physical.map(
      (layer) =>
        new VectorScene(
          input,
          {
            ...connection,
            pointsToConnect: [
              { ...pad, layer },
              { ...pad, layer },
            ],
          },
          diameter,
          fixed,
        ),
    )
    const failedCandidates: Terminal[] = []
    // Complete the coarse endpoint domain first. A successful coarse site
    // keeps the existing geometry and ordering. Only grid-unsolved candidates
    // receive a precision retry, and only when the endpoint has no accepted
    // coarse approach; postprocessing rejection keeps its original behavior.
    for (const fine of [false, true]) {
      if (fine && ends[end].length) break
      if (fine && !options.allowFineNativeApproachRetry) {
        deferredFineNativeApproachRetry ||= failedCandidates.length > 0
        break
      }
      for (const point of fine ? failedCandidates : candidates) {
        if (viaScenes.some((scene) => !scene.visible(point, point))) continue
        if (
          existingVias.some(
            (via) =>
              distance(via, point) <
              hole / 2 +
                (via.via_hole_diameter ?? input.minViaHoleDiameter ?? 0.15) /
                  2 +
                holeClearance -
                1e-8,
          )
        )
          continue
        const local = {
          ...connection,
          pointsToConnect: [pad, { ...point, layer: pad.layer }],
        }
        const scene = new VectorScene(input, local, width, fixed)
        const search = new GridVisibilitySearch(
          scene,
          pad,
          point,
          [],
          0,
          undefined,
          {
            checkReachability: true,
            allTerminalAttachments: true,
            maxLength: surfaceLimit,
            paretoLength: true,
            ...(!fine ? { limitLengthBounds: true } : {}),
            ...(fine
              ? {
                  step: Math.max(0.01, input.minTraceWidth / 10),
                  bounds: {
                    minX: Math.max(input.bounds.minX, pad.x - surfaceLimit),
                    maxX: Math.min(input.bounds.maxX, pad.x + surfaceLimit),
                    minY: Math.max(input.bounds.minY, pad.y - surfaceLimit),
                    maxY: Math.min(input.bounds.maxY, pad.y + surfaceLimit),
                  },
                }
              : {}),
          },
        )
        try {
          let steps = 0
          while (!search.solved && !search.failed && steps++ < 4000) {
            search.step()
            yield
          }
          if (!search.solved) {
            if (!search.failed) options.onSearchIncomplete?.()
            if (!fine) failedCandidates.push(point)
            continue
          }
          let top = reduceOrdinaryTurns(search.result, scene).map((p) => ({
            ...p,
            route_type: "wire" as const,
            layer: pad.layer,
            width,
          }))
          const topTrace: Trace = {
            type: "pcb_trace",
            pcb_trace_id: `expanded_surface_${connection.name}_${end}`,
            connection_name: connection.name,
            route: top,
          }
          top = chamferOrdinaryCorners(
            { ...input, connections: [local] },
            [topTrace],
            fixed,
          )[0].route as typeof top
          if (
            !scene.pathVisible(top) ||
            length(top) > surfaceLimit + 1e-8 ||
            !routeAnglesAreConventional([{ ...topTrace, route: top }]) ||
            !tuningPathIsSelfClear(
              top,
              width +
                (input.minTraceToPadEdgeClearance ??
                  input.defaultObstacleMargin ??
                  0.075),
            )
          )
            continue
          const via: Via = {
            x: point.x,
            y: point.y,
            route_type: "via",
            from_layer: pad.layer,
            to_layer: targetLayer,
            layers: physical,
            via_diameter: diameter,
            via_hole_diameter: hole,
          }
          ends[end].push({
            point,
            length: length(top),
            escape: {
              type: "pcb_trace",
              pcb_trace_id: `expanded_dogbone_${connection.name}_${end}_${ends[end].length}`,
              connection_name: connection.name,
              source_trace_id: connection.source_trace_id ?? connection.name,
              route: [...top, via, { ...point, route_type: "wire", width }],
            },
          })
        } finally {
          search.cancel()
        }
        yield
      }
    }
  }
  if (deferredFineNativeApproachRetry)
    options.onDeferredFineNativeApproachRetry?.()
  return ends
}

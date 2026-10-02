import { offsetPath } from "./coupled-pair-routing"
import { GridVisibilitySearch } from "./grid-visibility"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { distance, simplify } from "./geometry"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import { tuningPathIsSelfClear } from "./length-tuning"
import type { PairedNetwork, PairedNetworkTransform } from "./paired-network"
import type { Point, Trace, Wire } from "./types"

/** Reconstruct native rails only after the shared demand has a tangent,
 * clearance-safe route. Short straight leads avoid returning raster hooks. */
export function* rebuildPairedNetwork(
  network: PairedNetwork,
  raw: Trace[],
): Generator<void, Trace[] | null> {
  const { input, local, transforms } = network,
    fixed = fixedCopper(input)
  const traces = [...raw]
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const result = traces.filter((t) =>
    input.connections.some((c) => c.name === t.connection_name),
  )
  for (const transform of transforms) {
    const { connection, center, width, envelope, offsets } = transform
    const index = traces.findIndex((t) => t.connection_name === connection.name)
    if (index < 0) return null
    const layer = (traces[index].route[0] as Wire).layer
    const others = traces.filter((_, i) => i !== index)
    let accepted: Trace[] | null = null
    for (const lead of [0, width * 6, width * 10]) {
      const directions = [
        {
          x: connection.pointsToConnect[0].x - center[0].x,
          y: connection.pointsToConnect[0].y - center[0].y,
        },
        {
          x: center.at(-1)!.x - connection.pointsToConnect[1].x,
          y: center.at(-1)!.y - connection.pointsToConnect[1].y,
        },
      ]
      const scene = new VectorScene({ ...local }, connection, envelope, [
        ...network.copper,
        ...others.flatMap(routeCopper),
      ])
      const visible = scene.visible.bind(scene)
      const aligned = (a: Point, b: Point, d: Point) =>
        (b.x - a.x) * d.x + (b.y - a.y) * d.y > 0 &&
        Math.abs((b.x - a.x) * d.y - (b.y - a.y) * d.x) < 1e-8
      scene.visible = (a, b) => {
        for (const [end, p] of connection.pointsToConnect.entries()) {
          const d = directions[end],
            reverse = { x: -d.x, y: -d.y }
          if (distance(a, p) < 1e-8 && !aligned(a, b, end ? reverse : d))
            return false
          if (distance(b, p) < 1e-8 && !aligned(a, b, end ? d : reverse))
            return false
        }
        return visible(a, b)
      }
      const ends = connection.pointsToConnect.map((p, i) => {
        const d = directions[i],
          factor = ((i ? -1 : 1) * lead) / Math.hypot(d.x, d.y)
        return { ...p, x: p.x + factor * d.x, y: p.y + factor * d.y }
      })
      if (
        lead &&
        (!scene.pathVisible([connection.pointsToConnect[0], ends[0]]) ||
          !scene.pathVisible([ends[1], connection.pointsToConnect[1]]))
      )
        continue
      const search = new GridVisibilitySearch(
        scene,
        ends[0],
        ends[1],
        [],
        4,
        undefined,
        { allTerminalAttachments: true },
      )
      let path: Point[] | null = null
      try {
        let steps = 0
        while (!search.solved && !search.failed && steps++ < 1000) {
          search.step()
          yield
        }
        if (search.solved) path = reduceOrdinaryTurns(search.result, scene)
      } finally {
        search.cancel()
      }
      if (!path) continue
      if (lead)
        path = [
          connection.pointsToConnect[0],
          ...path,
          connection.pointsToConnect[1],
        ]
      if (!tuningPathIsSelfClear(path, envelope + clearance)) continue
      const demand: Trace = {
        ...traces[index],
        route: path.map((p) => ({
          ...p,
          route_type: "wire",
          layer,
          width: envelope,
        })),
      }
      const carrier: Trace = {
        ...demand,
        route: simplify([center[0], ...path, center.at(-1)!]).map((p) => ({
          ...p,
          route_type: "wire",
          layer,
          width: envelope,
        })),
      }
      const shapingInput = {
        ...local,
        connections: local.connections.map((c) =>
          c.name === connection.name
            ? {
                ...c,
                pointsToConnect: [center[0], center.at(-1)!].map((p) => ({
                  ...p,
                  layer,
                })),
              }
            : c,
        ),
      }
      const shaped = chamferOrdinaryCorners(
        shapingInput,
        [carrier],
        [
          ...fixed,
          ...others
            .filter(
              (t) =>
                !transform.approaches.some((c) => c.name === t.connection_name),
            )
            .flatMap(routeCopper),
        ],
        2,
      )[0]
      const candidate = restoreRails(transform, shaped, traces)
      if (!candidate) continue
      const nativeCopper = [...fixed, ...candidate.flatMap(routeCopper)]
      if (
        transform.approaches.length &&
        candidate.some(
          (t) =>
            !new VectorScene(
              input,
              input.connections.find((c) => c.name === t.connection_name)!,
              width,
              nativeCopper,
            ).pathVisible(t.route),
        )
      )
        continue
      // Approaches may still contain returning grid jogs; the shared section
      // itself must already have sufficient room for the two offset rails.
      if (
        candidate.some(
          (t) =>
            !tuningPathIsSelfClear(
              t.route.slice(t.coupledSection![0], t.coupledSection![1] + 1),
              width + clearance,
            ),
        )
      )
        continue
      traces[index] = demand
      accepted = candidate
      break
    }
    if (!accepted) return null
    result.push(...accepted)
  }
  for (const c of input.connections) {
    const trace = result.find((t) => t.connection_name === c.name)!
    for (const p of c.pointsToConnect) p.layer = (trace.route[0] as Wire).layer
  }
  return result
}

function restoreRails(
  transform: PairedNetworkTransform,
  carrier: Trace,
  traces: Trace[],
): Trace[] | null {
  const { width, offsets } = transform,
    layer = (carrier.route[0] as Wire).layer
  const rails: Trace[] = []
  for (const [side, original] of transform.rails.entries()) {
    const [s, e] = original.coupledSection!
    const prefix =
      traces.find(
        (t) => t.connection_name === `approach_${original.connection_name}_0`,
      )?.route ??
      (transform.approaches.length ? undefined : original.route.slice(0, s + 1))
    const suffix =
      traces
        .find(
          (t) => t.connection_name === `approach_${original.connection_name}_1`,
        )
        ?.route.toReversed() ??
      (transform.approaches.length ? undefined : original.route.slice(e))
    if (!prefix || !suffix) return null
    const mid = offsetPath(carrier.route, offsets[side]).map((p) => ({
      ...p,
      route_type: "wire" as const,
      layer,
      width,
    }))
    if (
      distance(prefix.at(-1)!, mid[0]) > 1e-8 ||
      distance(suffix[0], mid.at(-1)!) > 1e-8
    )
      return null
    rails.push({
      ...original,
      curvedSegments: transform.approaches.length
        ? []
        : original.curvedSegments?.flatMap((k) =>
            k <= s ? [k] : k > e ? [k + mid.length - (e - s + 1)] : [],
          ),
      route: [...prefix.slice(0, -1), ...mid, ...suffix.slice(1)],
      coupledSection: [prefix.length - 1, prefix.length + mid.length - 2],
    })
  }
  return rails
}

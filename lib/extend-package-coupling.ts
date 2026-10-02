import { bevelCoupledCorners } from "./bevel-coupled-corners"
import { offsetPath } from "./coupled-pair-routing"
import { distance, pointSegmentDistanceToPoints, simplify } from "./geometry"
import { GridVisibilitySearch } from "./grid-visibility"
import { tuningPathIsSelfClear } from "./length-tuning"
import { packageApproachRegions, pointInBox } from "./package-approach-regions"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { remapCurvedSegments } from "./remap-curved-segments"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { busLengthReports, pairLengthReports } from "./route-lengths"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

const reverse = (t: Trace): Trace => ({
  ...t,
  route: t.route.toReversed(),
  coupledSection: t.coupledSection
    ? [
        t.route.length - 1 - t.coupledSection[1],
        t.route.length - 1 - t.coupledSection[0],
      ]
    : undefined,
  curvedSegments: t.curvedSegments?.map((i) => t.route.length - i),
})
const indexOf = (path: Point[], point: Point) =>
  path.findIndex((p) => distance(p, point) < 1e-7)
const preservePoint = (path: Wire[], point: Wire) => {
  if (indexOf(path, point) >= 0) return path
  const i = path.findIndex(
    (p, i) =>
      i > 0 && pointSegmentDistanceToPoints(point, path[i - 1], p) < 1e-8,
  )
  return i < 0 ? path : [...path.slice(0, i), point, ...path.slice(i)]
}

/** Continue an existing shared corridor as far as the actual local package
 * copper permits. Keep existing internal tuning, fixed copper, and all length
 * constraints. A bounded search may decline an edit; it never weakens checks. */
export function* extendPackageCoupling(
  input: SimpleRouteJson,
  original: Trace[],
  options: { preserveMatching?: boolean } = {},
): Generator<void, Trace[]> {
  let result = original
  const fixed = fixedCopper(input)
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  let budget = 2000
  for (const pair of input.differentialPairs ?? []) {
    for (const reversed of [false, true]) {
      for (const side of [0, 1]) {
        if (budget <= 0) return result
        const nativeRails = pair.connectionNames.map((name) =>
          result.find((t) => t.connection_name === name),
        )
        if (nativeRails.some((t) => !t?.coupledSection)) continue
        const rails = (nativeRails as Trace[]).map((t) =>
          reversed ? reverse(t) : t,
        )
        const ref = rails[side],
          other = rails[1 - side]
        const [rs, re] = ref.coupledSection!,
          [os, oe] = other.coupledSection!
        const width = (other.route[0] as Wire).width,
          separation = width + (pair.traceGap ?? clearance)
        if (
          re < 1 ||
          oe < 1 ||
          distance(ref.route[re - 1], ref.route[re]) < 1e-7
        )
          continue
        const regions = packageApproachRegions(input, width / 2 + clearance)
        const region = regions.find(
          (r) =>
            pointInBox(ref.route.at(-1)!, r.copper) &&
            pointInBox(other.route.at(-1)!, r.copper),
        )
        if (!region || pointInBox(ref.route[re], region.copper)) continue
        let stop = re + 1
        while (
          stop < ref.route.length &&
          !pointInBox(ref.route[stop], region.copper)
        )
          stop++
        if (
          stop === ref.route.length ||
          ref.curvedSegments?.some((i) => i >= re && i <= stop)
        )
          continue
        const a = ref.route[stop - 1],
          b = ref.route[stop]
        let lo = 0,
          hi = 1
        for (let i = 0; i < 40; i++) {
          const t = (lo + hi) / 2
          if (
            pointInBox(
              { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
              region.copper,
            )
          )
            hi = t
          else lo = t
        }
        const cut = { x: a.x + (b.x - a.x) * hi, y: a.y + (b.y - a.y) * hi }
        const anchor = {
          x: (ref.route[re - 1].x + ref.route[re].x) / 2,
          y: (ref.route[re - 1].y + ref.route[re].y) / 2,
        }
        let section = simplify([anchor, ...ref.route.slice(re, stop), cut])
        let paths: Point[][]
        try {
          paths = [separation, -separation].map((d) => offsetPath(section, d))
        } catch {
          continue
        }
        let path = paths.find(
          (p) =>
            pointSegmentDistanceToPoints(
              p[0],
              other.route[oe - 1],
              other.route[oe],
            ) < 1e-7,
        )
        if (!path) continue
        const localWire = (p: Point): Wire => ({
          ...p,
          route_type: "wire",
          width,
          layer: (other.route[0] as Wire).layer,
        })
        const localRails = [
          {
            ...ref,
            route: section.map(localWire),
            curvedSegments: [],
            coupledSection: [0, section.length - 1] as [number, number],
          },
          {
            ...other,
            route: path.map(localWire),
            curvedSegments: [],
            coupledSection: [0, path.length - 1] as [number, number],
          },
        ]
        const bevel = bevelCoupledCorners(input, [
          ...result.filter(
            (t) => !pair.connectionNames.includes(t.connection_name!),
          ),
          ...localRails,
        ])
        section = bevel.find(
          (t) => t.connection_name === ref.connection_name,
        )!.route
        path = bevel.find(
          (t) => t.connection_name === other.connection_name,
        )!.route
        const refRoute = [
          ...ref.route.slice(0, re),
          ...section,
          ...ref.route.slice(stop),
        ].map(localWire)
        const connection = input.connections.find(
          (c) => c.name === other.connection_name,
        )!
        const scene = new VectorScene(input, connection, width, [
          ...fixed,
          ...result
            .filter((t) => t.connection_name !== ref.connection_name)
            .flatMap(routeCopper),
          ...routeCopper({ ...ref, route: refRoute }),
        ])
        if (!scene.pathVisible(path)) continue
        // A local dogbone via may sit outside the pad field. Its native fanout
        // copper is still a valid place to reconnect the package approach.
        let join = oe + 1
        while (
          join < other.route.length &&
          !pointInBox(other.route[join], region.copper)
        )
          join++
        if (join === other.route.length) continue
        const search = new GridVisibilitySearch(
          scene,
          path.at(-1)!,
          other.route[join],
        )
        try {
          let steps = 0
          while (
            !search.solved &&
            !search.failed &&
            steps++ < 256 &&
            budget-- > 0
          ) {
            search.step()
            yield
          }
          if (!search.solved) continue
        } finally {
          search.cancel()
        }
        const wire = (p: Point): Wire => ({
          ...p,
          route_type: "wire",
          layer: (other.route[0] as Wire).layer,
          width,
        })
        const next = preservePoint(
          preservePoint(
            simplify([
              ...other.route.slice(0, oe),
              ...path,
              ...reduceOrdinaryTurns(search.result, scene).slice(1),
              ...other.route.slice(join + 1),
            ]).map(wire),
            wire(other.route[os]),
          ),
          wire(path.at(-1)!),
        )
        if (
          !scene.pathVisible(next) ||
          !tuningPathIsSelfClear(next, width + clearance)
        )
          continue
        const replacement = [
          {
            ...ref,
            route: refRoute,
            curvedSegments: remapCurvedSegments(ref, refRoute),
            coupledSection: [rs, re + section.length - 1] as [number, number],
          },
          {
            ...other,
            route: next,
            curvedSegments: remapCurvedSegments(other, next),
            coupledSection: [
              indexOf(next, other.route[os]),
              indexOf(next, path.at(-1)!),
            ] as [number, number],
          },
        ].map((t) => (reversed ? reverse(t) : t))
        const unchanged = result.filter(
          (t) => !pair.connectionNames.includes(t.connection_name!),
        )
        const surrounding = [...fixed, ...unchanged.flatMap(routeCopper)]
        for (const trim of [
          1.5, 0.75, 0.375, 0.1875, 0.09375, 0.046875, 0.0234375,
        ]) {
          // Only these two rails changed. Keep all other completed routes
          // immutable, and use their copper as hard clearance obstacles.
          const refinedPair = chamferOrdinaryCorners(
            input,
            result
              .filter((t) => pair.connectionNames.includes(t.connection_name!))
              .map(
                (t) =>
                  replacement.find(
                    (r) => r.connection_name === t.connection_name,
                  )!,
              ),
            surrounding,
            trim,
          )
          const refined = result.map(
            (t) =>
              refinedPair.find(
                (r) => r.connection_name === t.connection_name,
              ) ?? t,
          )
          if (
            !routeAnglesAreConventional(refinedPair) ||
            (options.preserveMatching !== false &&
              [
                ...busLengthReports(input, refined),
                ...pairLengthReports(input, refined),
              ].some((r) => r.toleranceMm !== null && !r.matched)) ||
            sharedPairSpacingReports(input, refined).some((r) => !r.matched)
          )
            continue
          const copper = [...surrounding, ...refinedPair.flatMap(routeCopper)]
          if (
            refinedPair.some((t) => {
              const w = (t.route[0] as Wire).width
              return (
                !tuningPathIsSelfClear(t.route, w + clearance) ||
                !new VectorScene(
                  input,
                  input.connections.find((c) => c.name === t.connection_name)!,
                  w,
                  copper,
                ).pathVisible(t.route)
              )
            })
          )
            continue
          result = refined
          break
        }
      }
    }
  }
  return result
}

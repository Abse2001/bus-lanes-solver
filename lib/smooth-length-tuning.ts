import { createTerminalViaClearanceChecker } from "./terminal-via-clearance"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { foldedTuningLobes } from "./folded-tuning"
import { packageApproachRegions, pointInBox } from "./package-approach-regions"
import { tuningPathIsSelfClear } from "./length-tuning"
import { smoothTuningLobes, roundedTuningLobes } from "./smooth-tuning"
import { fixedRouteLength } from "./route-lengths"
import { distance, length, simplify, segmentDistance } from "./geometry"
import { VectorScene, fixedCopper, routeCopper } from "./vector-scene"
import type { SimpleRouteJson, Trace, Point, Wire } from "./types"

/** Generate continuous octilinear tuning patterns while preserving every other
 * lane as hard copper. Revisit blocked lanes after neighboring tuning frees space. */
export function tuneSmoothLengths(
  input: SimpleRouteJson,
  traces: Trace[],
  targets: Map<string, number>,
  options: {
    maxCandidates?: number
    packMeanders?: boolean
    packageOnlyPairTuning?: boolean
  } = {},
) {
  let attempted = 0
  let attemptedFolded = 0
  let allowFolded = false
  const fixed = fixedCopper(input)
  function* candidates(
    t: Trace,
    scene: VectorScene,
    fractionOfDeficit = 1,
  ): Generator<Trace> {
    const connection = input.connections.find(
      (c) => c.name === t.connection_name,
    )!
    // Keep the existing coupled-pair correction path unchanged. Independent
    // lane tuning must not spend additional copper length in its via land.
    const terminalViaCopperIsClear = t.coupledSection
      ? (_path: Point[]) => true
      : createTerminalViaClearanceChecker(input, t)
    const width = (t.route[0] as Wire).width
    const fixedLength = fixedRouteLength(input, connection.name)
    const currentLength = length(t.route) + fixedLength
    const delta =
      (targets.get(connection.name)! - currentLength) * fractionOfDeficit
    if (delta < 1e-8) {
      yield t
      return
    }
    const clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
    const pair = input.differentialPairs?.find((p) =>
      p.connectionNames.includes(t.connection_name!),
    )
    const regions =
      pair && options.packageOnlyPairTuning
        ? packageApproachRegions(
            input,
            width + (pair.traceGap ?? clearance) / 2 + clearance,
          )
        : []
    const returnSpacing = width + clearance
    const pitch = 4 * Math.max(width * 1.2, clearance)
    // Tune the long interior runs before considering short terminal approaches.
    const segments = t.route
      .slice(1)
      .map((p, i) => {
        const a = t.route[i],
          span = distance(a, p)
        const midpoint = { x: (a.x + p.x) / 2, y: (a.y + p.y) / 2 }
        const normal =
          span > 1e-8
            ? { x: -(p.y - a.y) / span, y: (p.x - a.x) / span }
            : { x: 0, y: 0 }
        const height = 2 * Math.max(width * 1.2, clearance)
        const openSides = [-1, 1].filter((side) =>
          scene.visible(midpoint, {
            x: midpoint.x + side * normal.x * height,
            y: midpoint.y + side * normal.y * height,
          }),
        ).length
        return { i, span, openSides }
      })
      .sort((a, b) => b.openSides - a.openSides || b.span - a.span)
    // Keep the established wide-bank search first. Package approaches can have
    // a small free pocket at an endpoint, so retry with compact, endpoint-aligned
    // banks only after every ordinary run has exhausted the original choices.
    const folded = allowFolded
    for (const compact of folded ? [false] : [false, true])
      for (const { i } of segments) {
        // A second bank must use an ordinary run; never place new teeth inside
        // the sampled arcs of a previously accepted smooth correction.
        if (t.curvedSegments?.includes(i + 1)) continue
        if (
          t.coupledSection &&
          i >= t.coupledSection[0] &&
          i < t.coupledSection[1]
        )
          continue
        const a = t.route[i],
          b = t.route[i + 1],
          span = distance(a, b)
        if (span < 0.01) continue
        const ux = (b.x - a.x) / span,
          uy = (b.y - a.y) / span
        // Spread substantial deficits over several lobes without turning small
        // corrections into dozens of microscopic teeth.
        const maximumTeeth = Math.floor((span * 0.9) / pitch)
        // Compact banks spend the available run on more rounded cells, so
        // added length fills the allocated bank without a tall sparse lobe.
        const preferredTeeth = Math.min(
          maximumTeeth,
          options.packMeanders
            ? maximumTeeth
            : Math.max(2, Math.ceil(delta / (12 * width))),
        )
        const counts = Array.from(
          { length: maximumTeeth },
          (_, i) => i + 1,
        ).sort(
          (a, b) =>
            Math.abs(a - preferredTeeth) - Math.abs(b - preferredTeeth) ||
            b - a,
        )
        function* placements() {
          if (folded) {
            for (const teeth of [1, 2, 3])
              for (const fraction of [0.9, 0.65, 0.4])
                for (const position of [0.5, 0, 1])
                  yield { teeth, fraction, position }
            return
          }
          for (const teeth of counts) {
            if (!compact) {
              for (const fraction of [0.9, 0.65, 0.4])
                for (const phase of [0.5, 0, 1])
                  yield {
                    teeth,
                    fraction,
                    position: 0.05 + 0.9 * phase,
                  }
            } else {
              for (const fraction of [0.9, 0.65, 0.4])
                for (const position of [0, 1])
                  yield { teeth, fraction, position }
              for (const fraction of [0.25, 0.15, 0.1])
                for (const position of [0.5, 0.05, 0.95, 0, 1])
                  yield { teeth, fraction, position }
            }
          }
        }
        for (const { teeth, fraction, position } of placements()) {
          const w = (span * fraction) / teeth
          if (!folded && w < pitch) continue
          for (const side of [1, -1])
            for (const createLobes of folded
              ? [foldedTuningLobes]
              : [roundedTuningLobes, smoothTuningLobes]) {
              const offset = span * (1 - fraction) * position
              const start = { x: a.x + ux * offset, y: a.y + uy * offset }
              const end = {
                x: start.x + ux * span * fraction,
                y: start.y + uy * span * fraction,
              }
              if (
                folded &&
                ++attemptedFolded > Math.min(128, options.maxCandidates ?? 128)
              )
                return
              if (
                !folded &&
                ++attempted > (options.maxCandidates ?? Infinity)
              ) {
                if (options.packMeanders) return
                throw Error("Smooth tuning candidate budget exhausted")
              }
              const lobes = createLobes(
                start,
                end,
                delta,
                teeth,
                side,
                Math.max(width * 1.2, clearance),
              )
              if (
                !lobes ||
                (regions.length &&
                  !regions.some((r) =>
                    lobes.every((p) => pointInBox(p, r.copper)),
                  ))
              )
                continue
              const bump: Point[] = [a, ...lobes, b]
              if (!scene.pathVisible(bump)) continue
              const next = (
                t.coupledSection ? (points: Point[]) => points : simplify
              )([...t.route.slice(0, i), ...bump, ...t.route.slice(i + 2)])
              if (
                Math.abs(length(next) + fixedLength - (currentLength + delta)) >
                1e-6
              )
                continue
              if (
                !terminalViaCopperIsClear(next) ||
                !tuningPathIsSelfClear(next, returnSpacing)
              )
                continue
              const candidate: Trace = {
                ...t,
                coupledSection: t.coupledSection
                  ? (t.coupledSection.map((v) =>
                      v > i ? v + next.length - t.route.length : v,
                    ) as [number, number])
                  : undefined,
                curvedSegments: next.slice(1).flatMap((p, i) => {
                  const dx = Math.abs(p.x - next[i].x),
                    dy = Math.abs(p.y - next[i].y)
                  return Math.min(dx, dy) > 1e-8 && Math.abs(dx - dy) > 1e-8
                    ? [i + 1]
                    : []
                }),
                route: next.map((p) => ({
                  ...p,
                  route_type: "wire",
                  layer: connection.pointsToConnect[0].layer,
                  width,
                })),
              }
              if (routeAnglesAreConventional([candidate])) yield candidate
            }
        }
      }
  }
  const result = [...traces]
  const pending = new Set(traces.map((_, i) => i))
  const partialBanks = new Map<number, number>()
  let allowPartial = false
  let changed = true
  while (pending.size && changed) {
    changed = false
    for (const index of pending) {
      const connection = input.connections.find(
        (c) => c.name === traces[index].connection_name,
      )!
      const scene = new VectorScene(
        input,
        connection,
        (result[index].route[0] as Wire).width,
        [...fixed, ...result.flatMap(routeCopper)],
      )
      let next = candidates(result[index], scene).next().value
      // A narrow approach may have enough aggregate space in several runs,
      // even though no individual run can fit the whole deficit. Preserve the
      // original single-bank choice when possible; only split after every
      // pending lane has exhausted those candidates.
      if (!next && allowPartial && (partialBanks.get(index) ?? 0) < 8) {
        for (const fraction of [0.5, 0.25]) {
          next = candidates(result[index], scene, fraction).next().value
          if (next) {
            partialBanks.set(index, (partialBanks.get(index) ?? 0) + 1)
            break
          }
        }
      }
      if (!next) continue
      result[index] = next
      if (
        length(next.route) + fixedRouteLength(input, connection.name) >=
        targets.get(connection.name)! - 1e-8
      )
        pending.delete(index)
      changed = true
    }
    if (!changed && !allowPartial) {
      allowPartial = true
      changed = true
    } else if (!changed && !allowFolded && options.packMeanders) {
      // Preserve all ordinary and partial-bank solutions before trying folded
      // pockets. Their separate bounded budget cannot starve package tuning.
      allowFolded = true
      allowPartial = false
      // A partial ordinary bank can occupy the pocket the folded replacement
      // needs. Restart this bounded fallback from the untouched input geometry.
      result.splice(0, result.length, ...traces)
      pending.clear()
      traces.forEach((_, i) => pending.add(i))
      partialBanks.clear()
      changed = true
    }
  }
  if (pending.size)
    throw Error(
      `Insufficient tuning clearance for ${[...pending].map((i) => traces[i].connection_name).join(", ")}`,
    )
  return result
}

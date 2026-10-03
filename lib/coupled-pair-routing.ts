import { packageApproachRegions, pointInBox } from "./package-approach-regions"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import { tuneSmoothLengths } from "./smooth-length-tuning"
import { minimumLengthTargets } from "./route-lengths"
import { backwardFacingPackageTerminals } from "./backward-facing-package-terminals"
import { extendCoupledSectionEnds } from "./extend-coupled-section"
import { fixedRouteLength } from "./route-lengths"
import { coupledPairCache } from "./coupled-pair-cache"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { tuningPathIsSelfClear } from "./length-tuning"
import { distance, length, simplify } from "./geometry"
import { VectorScene, routeCopper, type Copper } from "./vector-scene"
import { VectorVisibilitySearch, connectors } from "./vector-visibility"
import { GridVisibilitySearch } from "./grid-visibility"
import type { SimpleRouteJson, Point, Trace, Connection } from "./types"

/** Offset an octilinear centerline in board-world mm, +X right/+Y up. Positive
 * distance is left of travel. Intersections preserve segment headings. */
export function offsetPath(path: Point[], offset: number): Point[] {
  const normals = path.slice(1).map((b, i) => {
    const a = path[i],
      d = distance(a, b)
    return { x: -(b.y - a.y) / d, y: (b.x - a.x) / d }
  })
  return path.map((p, i) => {
    const a = normals[Math.max(0, i - 1)],
      b = normals[Math.min(normals.length - 1, i)]
    const denominator = 1 + a.x * b.x + a.y * b.y
    if (denominator < 1e-5) throw Error("Pair centerline reverses direction")
    return {
      x: p.x + (offset * (a.x + b.x)) / denominator,
      y: p.y + (offset * (a.y + b.y)) / denominator,
    }
  })
}

/** Route two rails through a shared corridor; only the package approaches may
 * separate. The return value remains subject to total-length and coupling checks. */
export function* routeCoupledPair(
  input: SimpleRouteJson,
  pair: NonNullable<SimpleRouteJson["differentialPairs"]>[number],
  fixed: Copper[],
  negotiation?: {
    copper: Copper[]
    penalty: number
    history?: Float32Array
    variant?: number
    handoffOffsets?: readonly [number, number]
  },
): Generator<void, Trace[] | null> {
  const members = pair.connectionNames.map(
    (n) => input.connections.find((c) => c.name === n)!,
  )
  if (members.some((c) => !c || c.pointsToConnect.length !== 2))
    throw Error("Pair requires two two-terminal connections")
  const widths = members.map(
    (c) =>
      (input.buses ?? []).find((b) => b.connectionNames.includes(c.name))
        ?.traceWidth ??
      c.nominalTraceWidth ??
      c.width ??
      input.minTraceWidth,
  )
  if (Math.abs(widths[0] - widths[1]) > 1e-8)
    throw Error("Coupled pair requires equal trace widths")
  const width = widths[0],
    gap =
      pair.traceGap ??
      input.minTraceToPadEdgeClearance ??
      input.defaultObstacleMargin ??
      0.075
  const fixedLengths = members.map((member) =>
    fixedRouteLength(input, member.name),
  )
  const inside = (point: Point, polygon: Point[]) => {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i],
        b = polygon[j]
      if (
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside
    }
    return inside
  }
  const layer = members[0].pointsToConnect[0].layer
  if (members.some((c) => c.pointsToConnect.some((p) => p.layer !== layer)))
    throw Error("Pair requires a common signal layer")
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  if (gap < clearance - 1e-8) throw Error("Pair gap is below trace clearance")
  const centers = [0, 1].map((i) => ({
    x: (members[0].pointsToConnect[i].x + members[1].pointsToConnect[i].x) / 2,
    y: (members[0].pointsToConnect[i].y + members[1].pointsToConnect[i].y) / 2,
  }))
  const vertical =
    Math.abs(centers[1].y - centers[0].y) >=
    Math.abs(centers[1].x - centers[0].x)
  const axis = vertical ? "y" : "x",
    crossAxis = vertical ? "x" : "y"
  const sign = Math.sign(centers[1][axis] - centers[0][axis]) || 1
  // Original pads, rather than via IDs, identify each package's approach region.
  const originalPads = members.map((c) =>
    (input.obstacles ?? []).filter(
      (o) => o.componentId && o.connectedTo.includes(c.name),
    ),
  )
  const pairInBus = (input.buses ?? []).some((b) =>
    pair.connectionNames.some((n) => b.connectionNames.includes(n)),
  )
  const handoffChoices = centers.map((p, i) => {
    const pads = originalPads
      .flat()
      .filter(
        (o) =>
          Math.abs(o.center[axis] - p[axis]) <
          Math.abs(centers[1][axis] - centers[0][axis]) / 2,
      )
    const ids = new Set(pads.map((o) => o.componentId))
    const field = input.obstacles.filter(
      (o) => o.componentId && ids.has(o.componentId),
    )
    const s = i === 0 ? sign : -sign
    const edge = field.length
      ? s > 0
        ? Math.max(
            ...field.map(
              (o) => o.center[axis] + (vertical ? o.height : o.width) / 2,
            ),
          )
        : Math.min(
            ...field.map(
              (o) => o.center[axis] - (vertical ? o.height : o.width) / 2,
            ),
          )
      : p[axis]
    const margin = 2 * width + gap + clearance
    const front = { ...p, [axis]: edge + s * margin }
    if (!field.length) return [front]
    const left =
      Math.min(...field.map((o) => o.center.x - o.width / 2)) - margin
    const right =
      Math.max(...field.map((o) => o.center.x + o.width / 2)) + margin
    const bottom =
      Math.min(...field.map((o) => o.center.y - o.height / 2)) - margin
    const top =
      Math.max(...field.map((o) => o.center.y + o.height / 2)) + margin
    const openFront = pairInBus
      ? front
      : i === 0
        ? {
            ...front,
            [axis]:
              front[axis] +
              s *
                Math.max(
                  4 * width,
                  distance(
                    members[0].pointsToConnect[i],
                    members[1].pointsToConnect[i],
                  ),
                ),
          }
        : {
            ...front,
            [crossAxis]: vertical ? (left + right) / 2 : (top + bottom) / 2,
          }
    return [
      openFront,
      front,
      { x: left, y: p.y },
      { x: right, y: p.y },
      { x: p.x, y: bottom },
      { x: p.x, y: top },
    ]
  })
  const sharingBuses = (input.buses ?? []).filter((bus) =>
    input.connections.some(
      (c) =>
        bus.connectionNames.includes(c.name) &&
        c.pointsToConnect[0].layer === layer,
    ),
  )
  // A standalone pair sharing a bus layer needs alternatives outside the lane
  // bank, otherwise a locally short package approach can seal the whole bus.
  if (!pairInBus && sharingBuses.length) {
    const field = input.obstacles.filter((o) => o.componentId)
    if (field.length) {
      const reserve =
        Math.max(...sharingBuses.map((bus) => bus.connectionNames.length)) *
        (width + clearance)
      const extent = (o: (typeof field)[number]) => {
        const angle = ((o.ccwRotationDegrees ?? 0) * Math.PI) / 180
        return (
          (vertical
            ? Math.abs(Math.cos(angle)) * o.width +
              Math.abs(Math.sin(angle)) * o.height
            : Math.abs(Math.sin(angle)) * o.width +
              Math.abs(Math.cos(angle)) * o.height) / 2
        )
      }
      const low =
        Math.min(...field.map((o) => o.center[crossAxis] - extent(o))) -
        reserve -
        width -
        gap -
        clearance
      const high =
        Math.max(...field.map((o) => o.center[crossAxis] + extent(o))) +
        reserve +
        width +
        gap +
        clearance
      for (let end = 0; end < 2; end++)
        handoffChoices[end].push(
          { ...centers[end], [crossAxis]: low },
          { ...centers[end], [crossAxis]: high },
        )
    }
  }
  // Keep a coupled corridor outside its bus envelope so it does not cut
  // through the remaining lanes' package approaches. Derive the reserve from
  // bus membership and trace pitch, never from board-specific coordinates.
  const busNames = new Set(
    (input.buses ?? [])
      .filter((b) =>
        pair.connectionNames.some((n) => b.connectionNames.includes(n)),
      )
      .flatMap((b) => b.connectionNames),
  )
  const busMembers = input.connections.filter((c) => busNames.has(c.name))
  if (busMembers.length > 2 && originalPads.some((p) => p.length)) {
    const reserve = busMembers.length * (width + clearance)
    // Aligned pad columns can differ by a rounding residue after translation.
    // Use the travel direction for alignment instead of moving the corridor to
    // the opposite package edge because of a sub-nanometer difference.
    const crossDelta = centers[1][crossAxis] - centers[0][crossAxis]
    const side = Math.abs(crossDelta) < 1e-8 ? sign : Math.sign(crossDelta)
    const positions = busMembers.flatMap((c) =>
      c.pointsToConnect.map((p) => p[crossAxis]),
    )
    const outer =
      (side > 0 ? Math.max(...positions) : Math.min(...positions)) +
      side * (reserve + 2 * width + gap + clearance)
    for (let end = 0; end < 2; end++) {
      const front = handoffChoices[end][0]
      handoffChoices[end].unshift({
        ...handoffChoices[end][0],
        [axis]:
          handoffChoices[end][0][axis] + (end === 0 ? sign : -sign) * reserve,
        [crossAxis]: outer,
      })
      if (end === 0)
        handoffChoices[end].unshift({
          ...front,
          [axis]: front[axis] + (sign * reserve) / 2,
        })
    }
  }
  // A retry must explore another handoff topology instead of repeatedly
  // returning the first viable corridor. All choices come from package geometry.
  for (let end = 0; end < 2; end++) {
    handoffChoices[end] = handoffChoices[end].filter(
      (point, index, choices) =>
        choices.findIndex((other) => distance(point, other) < 1e-8) === index,
    )
    // Pads on the back of a package should first try its nearby edges rather
    // than crossing the entire via field to reach the edge facing the target.
    // Keep the remaining corridor distance in the score so a short local
    // escape does not win by sending the pair away from its destination.
    const cost = (point: Point) =>
      2 * distance(point, centers[end]) + distance(point, centers[1 - end])
    handoffChoices[end].sort((a, b) => cost(a) - cost(b))
  }
  const variant = negotiation?.variant ?? 0
  // Change both package approaches on each retry. A slow sweep of target
  // handoffs can otherwise leave a blocked source escape unchanged for many
  // stagnant bus passes. This diagonal traversal still visits every pairing.
  const sourceOffset = variant % handoffChoices[0].length
  const offsets = negotiation?.handoffOffsets ?? [
    sourceOffset,
    sourceOffset + Math.floor(variant / handoffChoices[0].length),
  ]
  for (let end = 0; end < 2; end++) {
    const offset = offsets[end] % handoffChoices[end].length
    handoffChoices[end] = [
      ...handoffChoices[end].slice(offset),
      ...handoffChoices[end].slice(0, offset),
    ]
  }
  const names = new Set(
    members.flatMap((c) => [c.name, c.source_trace_id ?? c.name]),
  )
  const corridorCopper = fixed.filter(
    (c) => !c.owners.some((n) => names.has(n)),
  )
  const envelope = 2 * width + gap
  const makeTrace = (
    c: Connection,
    points: Point[],
    keepVertices = false,
  ): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `bus_lane_${c.name}`,
    connection_name: c.name,
    source_trace_id: c.source_trace_id ?? c.name,
    route: (keepVertices ? points : simplify(points)).map((p) => ({
      ...p,
      route_type: "wire",
      layer,
      width,
    })),
  })
  let best: Trace[] | null = null,
    bestScore = Infinity,
    viable = 0
  const reachability = new Map<string, { reachable: boolean; length: number }>()
  // Most package approaches fit the same half-width grid used by the main
  // search. Explore those handoffs first, then retain the fine grid for narrow
  // gaps. Every grid edge is still checked against continuous copper geometry.
  const fine = originalPads.some((pads) => pads.length > 0)
  const approachChoices = (
    fine ? [width / 2, width / 10] : [undefined]
  ).flatMap((approachStep) =>
    handoffChoices[0].map((point) => ({ point, approachStep })),
  )
  const cached =
    negotiation &&
    !negotiation.copper.length &&
    !negotiation.penalty &&
    !negotiation.history
      ? coupledPairCache(input, fixed)
      : undefined
  for (const { point: first, approachStep } of approachChoices)
    for (const second of handoffChoices[1])
      candidates: for (const shift of [0, -1, 1, -2, 2]) {
        const ends = [first, second].map((p) => ({
          ...p,
          [crossAxis]: p[crossAxis] + shift * envelope,
        }))
        const key = JSON.stringify([
          pair,
          layer,
          width,
          gap,
          approachStep,
          ends,
        ])
        const remembered = cached?.get(key)
        if (remembered) {
          if (remembered.traces && remembered.score < bestScore) {
            bestScore = remembered.score
            best = remembered.traces
          }
          if (remembered.hasMatchedAlternative) return best
          if (remembered.countsAttempt && best && ++viable >= 4) return best
          continue
        }
        let handoffBest: Trace[] | null = null,
          handoffScore = Infinity
        const virtual = {
          name: "pair_corridor",
          pointsToConnect: ends.map((p) => ({ ...p, layer })),
        }
        const scene = new VectorScene(input, virtual, envelope, corridorCopper)
        const visibleScene = negotiation
          ? new VectorScene(input, virtual, envelope, [
              ...corridorCopper,
              ...negotiation.copper,
            ])
          : scene
        const direct = connectors(ends[0], ends[1]).find((p) =>
          visibleScene.pathVisible(p),
        )
        const centerSearch = direct
          ? {
              solved: true,
              failed: false,
              expanded: 0,
              result: direct,
              step() {},
            }
          : fine || input.connections.length > 12
            ? new GridVisibilitySearch(
                scene,
                ends[0],
                ends[1],
                negotiation?.copper,
                negotiation?.penalty,
                negotiation?.history,
              )
            : new VectorVisibilitySearch(scene, ends[0], ends[1])
        try {
          while (
            !centerSearch.solved &&
            !centerSearch.failed &&
            centerSearch.expanded <
              (centerSearch instanceof GridVisibilitySearch ? 500000 : 1000)
          ) {
            centerSearch.step()
            yield
          }
        } finally {
          if (centerSearch instanceof GridVisibilitySearch)
            centerSearch.cancel()
        }
        if (!centerSearch.solved) {
          cached?.set(key, {
            traces: null,
            score: Infinity,
            hasMatchedAlternative: false,
            countsAttempt: false,
          })
          continue
        }
        const centerPath = reduceOrdinaryTurns(
          centerSearch.result,
          visibleScene,
        )
        // Grid endpoint attachments can briefly backtrack at a blocked
        // handoff. Reject that candidate instead of aborting the whole phase
        // when the parallel offset has no finite intersection.
        if (
          centerPath.length < 2 ||
          centerPath.some((point, i) => {
            if (!i) return false
            const previous = centerPath[i - 1],
              span = distance(previous, point)
            if (span < 1e-8) return true
            if (i < 2) return false
            const before = centerPath[i - 2],
              oldSpan = distance(before, previous)
            const dot =
              ((previous.x - before.x) * (point.x - previous.x) +
                (previous.y - before.y) * (point.y - previous.y)) /
              (oldSpan * span)
            return 1 + dot < 1e-5
          })
        ) {
          cached?.set(key, {
            traces: null,
            score: Infinity,
            hasMatchedAlternative: false,
            countsAttempt: false,
          })
          continue
        }
        const rails = [
          offsetPath(centerPath, (width + gap) / 2),
          offsetPath(centerPath, -(width + gap) / 2),
        ]
        const flips = [false, true].sort((a, b) => {
          const cost = (flip: boolean) =>
            members.reduce((sum, c, i) => {
              const rail = rails[flip ? 1 - i : i]
              return (
                sum +
                distance(c.pointsToConnect[0], rail[0]) +
                distance(c.pointsToConnect[1], rail.at(-1)!)
              )
            }, 0)
          return cost(a) - cost(b)
        })
        for (const flip of flips) {
          const ordered = flip ? rails.toReversed() : rails
          const main = members.map((c, i) => makeTrace(c, ordered[i]))
          for (const escapeOrders of [
            [
              [0, 1],
              [0, 1],
            ],
            [
              [0, 1],
              [1, 0],
            ],
            [
              [1, 0],
              [0, 1],
            ],
            [
              [1, 0],
              [1, 0],
            ],
          ]) {
            const escapes: Trace[][] = [[], []]
            let failed = false
            for (let end = 0; end < 2; end++)
              for (const i of escapeOrders[end]) {
                const c = members[i],
                  target = ordered[i][end === 0 ? 0 : ordered[i].length - 1],
                  source = c.pointsToConnect[end]
                const escapeInput = input
                const ownRail = end === 0 ? ordered[i] : ordered[i].toReversed()
                let skip = 4 * width
                const tail: Copper[] = []
                for (let k = 1; k < ownRail.length; k++) {
                  const a = ownRail[k - 1],
                    b = ownRail[k],
                    d = distance(a, b)
                  if (skip >= d) {
                    skip -= d
                    continue
                  }
                  tail.push({
                    a: {
                      x: a.x + ((b.x - a.x) * skip) / d,
                      y: a.y + ((b.y - a.y) * skip) / d,
                    },
                    b,
                    radius: width / 2,
                    layer,
                    owners: ["reserved_pair_tail"],
                  })
                  skip = 0
                }
                const escapeScene = new VectorScene(escapeInput, c, width, [
                  ...fixed,
                  ...tail,
                  ...main.flatMap(routeCopper),
                  ...escapes.flat().flatMap(routeCopper),
                ])
                const visibleEscapeScene = negotiation
                  ? new VectorScene(escapeInput, c, width, [
                      ...fixed,
                      ...tail,
                      ...main.flatMap(routeCopper),
                      ...escapes.flat().flatMap(routeCopper),
                      ...negotiation.copper,
                    ])
                  : escapeScene
                const directEscape = connectors(source, target).find((p) =>
                  visibleEscapeScene.pathVisible(p),
                )
                const padding = 30 * width
                const localBounds = {
                  minX: Math.max(
                    input.bounds.minX,
                    Math.min(source.x, target.x) - padding,
                  ),
                  maxX: Math.min(
                    input.bounds.maxX,
                    Math.max(source.x, target.x) + padding,
                  ),
                  minY: Math.max(
                    input.bounds.minY,
                    Math.min(source.y, target.y) - padding,
                  ),
                  maxY: Math.min(
                    input.bounds.maxY,
                    Math.max(source.y, target.y) + padding,
                  ),
                }
                const search = directEscape
                  ? {
                      solved: true,
                      failed: false,
                      expanded: 0,
                      result: directEscape,
                      step() {},
                    }
                  : new GridVisibilitySearch(
                      escapeScene,
                      source,
                      target,
                      negotiation?.copper,
                      negotiation?.penalty,
                      fine ? undefined : negotiation?.history,
                      fine
                        ? { step: approachStep, bounds: localBounds }
                        : undefined,
                    )
                try {
                  while (
                    !search.solved &&
                    !search.failed &&
                    search.expanded < 500000
                  ) {
                    search.step()
                    yield
                  }
                } finally {
                  if (search instanceof GridVisibilitySearch) search.cancel()
                }
                if (!search.solved) {
                  failed = true
                  break
                }
                escapes[i][end] = makeTrace(
                  c,
                  reduceOrdinaryTurns(search.result, visibleEscapeScene),
                )
              }
            if (failed) continue
            let traces = extendCoupledSectionEnds(
              members.map((c, i) => ({
                ...makeTrace(
                  c,
                  [
                    ...escapes[i][0].route,
                    ...ordered[i].slice(1),
                    ...escapes[i][1].route.toReversed().slice(1),
                  ],
                  true,
                ),
                coupledSection: [
                  escapes[i][0].route.length - 1,
                  escapes[i][0].route.length + ordered[i].length - 2,
                ] as [number, number],
              })),
            )
            if (
              !traces.every((t, i) =>
                new VectorScene(input, members[i], width, [
                  ...fixed,
                  ...traces.flatMap(routeCopper),
                ]).pathVisible(t.route),
              )
            )
              continue
            // Finish the pair before ordinary lanes occupy its approach space.
            // A raw connection with a hairpin at its handoff is not a usable
            // corridor: later matching cannot fix it without moving neighbors.
            const pairInput: SimpleRouteJson = {
              ...input,
              connections: members,
              buses: [],
              differentialPairs: [pair],
            }
            let finished: Trace[] | undefined
            for (const trim of [1.5, 0.75, 0.375, 0.1875]) {
              const shaped = chamferOrdinaryCorners(
                pairInput,
                traces,
                fixed,
                trim,
              )
              if (
                !routeAnglesAreConventional(shaped) ||
                sharedPairSpacingReports(pairInput, shaped).some(
                  (p) => !p.matched,
                )
              )
                continue
              try {
                let tuned = tuneSmoothLengths(
                  pairInput,
                  shaped,
                  minimumLengthTargets(pairInput, shaped),
                  { maxCandidates: 512 },
                )
                const regions = packageApproachRegions(
                  pairInput,
                  width + gap / 2 + clearance,
                )
                // Fresh two-ended escapes have no completed plane copper to
                // bound a local correction. Retain established pre-fanouted
                // choices; only retry those fresh banks inside their packages.
                const dogboneCounts = new Map<string, number>()
                for (const t of pairInput.traces ?? [])
                  dogboneCounts.set(
                    t.connection_name!,
                    (dogboneCounts.get(t.connection_name!) ?? 0) + 1,
                  )
                const freshSignalEscapes =
                  (pairInput.traces?.length ?? 0) > 0 &&
                  [...dogboneCounts.values()].every((n) => n === 2) &&
                  pairInput.traces!.every(
                    (t) =>
                      t.route.filter((p) => p.route_type === "via").length ===
                      1,
                  )
                if (
                  freshSignalEscapes &&
                  regions.length &&
                  tuned.some((t) =>
                    t.curvedSegments?.some(
                      (i) =>
                        !regions.some(
                          (r) =>
                            pointInBox(t.route[i - 1], r.copper) &&
                            pointInBox(t.route[i], r.copper),
                        ),
                    ),
                  )
                ) {
                  tuned = tuneSmoothLengths(
                    pairInput,
                    shaped,
                    minimumLengthTargets(pairInput, shaped),
                    { maxCandidates: 512, packageOnlyPairTuning: true },
                  )
                }
                if (
                  routeAnglesAreConventional(tuned) &&
                  sharedPairSpacingReports(pairInput, tuned).every(
                    (p) => p.matched,
                  )
                ) {
                  finished = tuned
                  break
                }
              } catch {}
            }
            if (!finished) continue
            traces = finished
            // The polygon includes imaginary closures between separate pair
            // terminals. A lane may legally leave through those openings, so
            // check actual reachability before treating this as a sealed pocket.
            // Completed plane vias and terminals on other layers do not need a
            // planar escape; their physical clearance is already checked above.
            const polygon = [
              ...traces[0].route,
              ...traces[1].route.toReversed(),
            ]
            const enclosed = input.connections.filter(
              (c) =>
                !pair.connectionNames.includes(c.name) &&
                c.pointsToConnect.some(
                  (p) => p.layer === layer && inside(p, polygon),
                ),
            )
            // A pair approach must not seal another terminal into a pocket.
            // Only geometrically enclosed terminals need a reachability search.
            let trapsTerminal = false
            const skew = Math.abs(
              length(traces[0].route) +
                fixedLengths[0] -
                length(traces[1].route) -
                fixedLengths[1],
            )
            let candidateScore = negotiation
              ? skew +
                0.05 * traces.reduce((sum, t) => sum + length(t.route), 0)
              : traces.reduce((sum, t) => sum + length(t.route), 0)
            const pending = (negotiation ? enclosed : input.connections).filter(
              (c) =>
                !pair.connectionNames.includes(c.name) &&
                c.pointsToConnect[0].layer === layer,
            )
            const corridorKey = pending.length
              ? JSON.stringify(traces.map((trace) => trace.route))
              : ""
            for (const other of pending) {
              const key = `${other.name}:${corridorKey}`
              let result = reachability.get(key)
              if (!result) {
                const otherWidth =
                  (input.buses ?? []).find((b) =>
                    b.connectionNames.includes(other.name),
                  )?.traceWidth ??
                  other.nominalTraceWidth ??
                  other.width ??
                  input.minTraceWidth
                const otherScene = new VectorScene(input, other, otherWidth, [
                  ...fixed,
                  ...traces.flatMap(routeCopper),
                ])
                const attachments = connectors(
                  other.pointsToConnect[0],
                  other.pointsToConnect[1],
                )
                const shortest = length(attachments[0])
                const direct = attachments.find(
                  (path) =>
                    length(path) <= shortest + 1e-8 &&
                    otherScene.pathVisible(path),
                )
                const check = direct
                  ? {
                      solved: true,
                      failed: false,
                      expanded: 0,
                      result: direct,
                      step() {},
                      cancel() {},
                    }
                  : new GridVisibilitySearch(
                      otherScene,
                      other.pointsToConnect[0],
                      other.pointsToConnect[1],
                    )
                try {
                  while (
                    !check.solved &&
                    !check.failed &&
                    check.expanded < 500000
                  ) {
                    check.step()
                    yield
                  }
                } finally {
                  check.cancel()
                }
                result = {
                  reachable: check.solved,
                  length: check.solved ? length(check.result) : Infinity,
                }
                reachability.set(key, result)
              }
              if (!result.reachable) {
                trapsTerminal = true
                break
              }
              candidateScore += negotiation
                ? 0.05 *
                  Math.max(
                    0,
                    result.length -
                      length(
                        connectors(
                          other.pointsToConnect[0],
                          other.pointsToConnect[1],
                        )[0],
                      ),
                  )
                : result.length
            }
            if (
              !trapsTerminal &&
              traces.every((t) =>
                tuningPathIsSelfClear(t.route, width + clearance),
              )
            ) {
              if (candidateScore < handoffScore) {
                handoffScore = candidateScore
                handoffBest = traces
              }
              if (candidateScore < bestScore) {
                bestScore = candidateScore
                best = traces
              }
              if (negotiation && skew <= pair.lengthTolerance) {
                // A matched option bounds further exploration, but the compact
                // best-scoring corridor may still need final approach tuning.
                // Forcing the longer option here can seal ordinary bus lanes.
                cached?.set(key, {
                  traces: handoffBest,
                  score: handoffScore,
                  hasMatchedAlternative: true,
                  countsAttempt: true,
                })
                return best
              }
              if (!negotiation && ++viable >= 2) return best
              if (!negotiation) continue candidates
            }
          }
        }
        // A first connected corridor can leave one rail with a large package
        // detour that matching cannot repair. Explore a bounded set of other
        // handoffs before falling back to the shortest, least skewed candidate.
        cached?.set(key, {
          traces: handoffBest,
          score: handoffScore,
          hasMatchedAlternative: false,
          countsAttempt: true,
        })
        if (negotiation && best && ++viable >= 4) return best
      }
  return best
}

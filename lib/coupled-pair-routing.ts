import { pairInteriorSpacing } from "./pair-interior-spacing"
import { tuneSmoothLengths } from "./smooth-length-tuning"
import { minimumLengthTargets } from "./route-lengths"
import { extendCoupledSectionEnds } from "./extend-coupled-section"
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
    matchPairSkew?: boolean
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
  const approachAllowance = Math.min(5.5, distance(centers[0], centers[1]) / 5)
  const packageEdges: Point[][] = []
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
    packageEdges[i] = [
      { x: left, y: p.y },
      { x: right, y: p.y },
      { x: p.x, y: bottom },
      { x: p.x, y: top },
    ].sort((a, b) => distance(a, p) - distance(b, p))
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
      {
        ...p,
        [axis]:
          p[axis] +
          s *
            (margin +
              distance(
                members[0].pointsToConnect[i],
                members[1].pointsToConnect[i],
              )),
      },
      openFront,
      front,
      { x: left, y: p.y },
      { x: right, y: p.y },
      { x: p.x, y: bottom },
      { x: p.x, y: top },
    ]
  })
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
  const outsideCorridors: number[] = []
  if (busMembers.length > 2 && originalPads.some((p) => p.length)) {
    const reserve = busMembers.length * (width + clearance)
    const front = handoffChoices[0][1]
    handoffChoices[0].unshift({
      ...front,
      [axis]: front[axis] + (sign * reserve) / 2,
    })
    const positions = busMembers.flatMap((c) =>
      c.pointsToConnect.map((p) => p[crossAxis]),
    )
    const side = Math.sign(centers[1][crossAxis] - centers[0][crossAxis]) || 1
    const low = Math.min(...positions) - reserve - envelopeMargin()
    const high = Math.max(...positions) + reserve + envelopeMargin()
    outsideCorridors.push(...(side > 0 ? [high, low] : [low, high]))
    const ids = new Set(originalPads.flat().map((p) => p.componentId))
    const field = input.obstacles.filter(
      (o) => o.componentId && ids.has(o.componentId),
    )
    const outerLow =
      Math.min(
        ...field.map(
          (o) => o.center[crossAxis] - (vertical ? o.width : o.height) / 2,
        ),
      ) - envelopeMargin()
    const outerHigh =
      Math.max(
        ...field.map(
          (o) => o.center[crossAxis] + (vertical ? o.width : o.height) / 2,
        ),
      ) + envelopeMargin()
    outsideCorridors.push(
      ...(side > 0 ? [outerHigh, outerLow] : [outerLow, outerHigh]),
    )
    for (let end = 0; end < 2; end++) {
      const extended = (packageEdges[end] ?? []).map((p) => {
        const axis =
          Math.abs(p.x - centers[end].x) > Math.abs(p.y - centers[end].y)
            ? "x"
            : "y"
        return {
          ...p,
          [axis]:
            p[axis] + (Math.sign(p[axis] - centers[end][axis]) * reserve) / 2,
        }
      })
      packageEdges[end] = [...extended, ...(packageEdges[end] ?? [])]
    }
  }
  function envelopeMargin() {
    return 2 * width + gap + clearance
  }
  // A retry must explore another handoff topology instead of repeatedly
  // returning the first viable corridor. All choices come from package geometry.
  for (let end = 0; end < 2; end++) {
    handoffChoices[end] = handoffChoices[end].filter(
      (point, index, choices) =>
        choices.findIndex((other) => distance(point, other) < 1e-8) === index,
    )
  }
  const variant = negotiation?.variant ?? 0
  if (variant % (outsideCorridors.length + 1) >= 2)
    for (let end = 0; end < 2; end++) {
      handoffChoices[end] = [
        ...(packageEdges[end] ?? []),
        ...handoffChoices[end],
      ]
    }
  const handoffVariant = Math.floor(variant / (outsideCorridors.length + 1))
  const offsets = [
    Math.floor(handoffVariant / handoffChoices[1].length),
    handoffVariant,
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
  searchTier: for (const searchBudget of negotiation?.matchPairSkew
    ? [100000, 0, 10000, 50000]
    : [500000]) {
    let searched = 0
    const tierBudget = !negotiation?.matchPairSkew
      ? Infinity
      : searchBudget === 100000
        ? 100000
        : searchBudget === 10000
          ? 300000
          : 500000
    for (const first of handoffChoices[0])
      for (const second of handoffChoices[1])
        candidates: for (const shift of [0, -1, 1, -2, 2]) {
          const ends = [first, second].map((p) => ({
            ...p,
            [crossAxis]: p[crossAxis] + shift * envelope,
          }))
          const virtual = {
            name: "pair_corridor",
            pointsToConnect: ends.map((p) => ({ ...p, layer })),
          }
          const scene = new VectorScene(
            input,
            virtual,
            envelope,
            corridorCopper,
          )
          const visibleScene = negotiation
            ? new VectorScene(input, virtual, envelope, [
                ...corridorCopper,
                ...negotiation.copper,
              ])
            : scene
          const paths = connectors(ends[0], ends[1])
          // Move the shared corridor around the bus, not its uncoupled handoffs.
          // The rails join immediately outside each package and stay together
          // through an outside detour when that topology frees the other lanes.
          const corridor =
            outsideCorridors[variant % (outsideCorridors.length + 1)]
          if (corridor !== undefined) {
            const reach = Math.abs(ends[1][axis] - ends[0][axis]) / 4
            const bends = [
              {
                ...ends[0],
                [axis]: ends[0][axis] + sign * reach,
                [crossAxis]: corridor,
              },
              {
                ...ends[1],
                [axis]: ends[1][axis] - sign * reach,
                [crossAxis]: corridor,
              },
            ]
            const detours = connectors(ends[0], bends[0]).flatMap((first) =>
              connectors(bends[1], ends[1]).map((last) =>
                simplify([...first, bends[1], ...last.slice(1)]),
              ),
            )
            paths.unshift(...detours)
          }
          const direct = paths.find((p) => visibleScene.pathVisible(p))
          const centerSearch = direct
            ? {
                solved: true,
                failed: false,
                expanded: 0,
                result: direct,
                step() {},
              }
            : input.connections.length > 12
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
                (centerSearch instanceof GridVisibilitySearch
                  ? searchBudget
                  : Math.min(searchBudget, 1000))
            ) {
              if (searched++ >= tierBudget) {
                if (best) return best
                continue searchTier
              }
              centerSearch.step()
              yield
            }
          } finally {
            if (centerSearch instanceof GridVisibilitySearch)
              centerSearch.cancel()
          }
          if (!centerSearch.solved) continue
          let centerPath =
            corridor !== undefined && direct
              ? simplify(centerSearch.result)
              : reduceOrdinaryTurns(centerSearch.result, visibleScene)
          // Bevel square/acute centerline bends so the outer rail does not open
          // a large gap at a miter. Both rails are then offset from this same path.
          centerPath = centerPath.flatMap((p, i, path) => {
            if (!i || i === path.length - 1) return [p]
            const a = path[i - 1],
              b = path[i + 1]
            const before = distance(a, p),
              after = distance(p, b)
            const u = { x: (p.x - a.x) / before, y: (p.y - a.y) / before }
            const v = { x: (b.x - p.x) / after, y: (b.y - p.y) / after }
            const dot = u.x * v.x + u.y * v.y
            if (dot >= Math.SQRT1_2 - 1e-8 || dot < -0.8) return [p]
            const trim = Math.min(envelope, before / 3, after / 3)
            const start = { x: p.x - u.x * trim, y: p.y - u.y * trim }
            const end = { x: p.x + v.x * trim, y: p.y + v.y * trim }
            if (dot > -1e-7) return [start, end]
            const turn = Math.sign(u.x * v.y - u.y * v.x)
            const bevel = (Math.SQRT2 - 1) * trim
            return [
              start,
              {
                x: start.x + (u.x - turn * u.y) * Math.SQRT1_2 * bevel,
                y: start.y + (u.y + turn * u.x) * Math.SQRT1_2 * bevel,
              },
              end,
            ]
          })
          if (!visibleScene.pathVisible(centerPath)) continue
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
          )
            continue
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
                  const ownRail =
                    end === 0 ? ordered[i] : ordered[i].toReversed()
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
                  const fine = originalPads.some((pads) => pads.length > 0)
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
                          ? { step: width / 10, bounds: localBounds }
                          : undefined,
                      )
                  try {
                    while (
                      !search.solved &&
                      !search.failed &&
                      search.expanded < searchBudget
                    ) {
                      if (searched++ >= tierBudget) {
                        if (best) return best
                        continue searchTier
                      }
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
              // Reserve skew-correction copper before neighboring lanes consume the
              // package approach. The two rails remain one atomic graph candidate.
              if (negotiation?.matchPairSkew) {
                const pairInput = {
                  ...input,
                  buses: [],
                  differentialPairs: [pair],
                }
                try {
                  traces = tuneSmoothLengths(
                    pairInput,
                    traces,
                    minimumLengthTargets(pairInput, traces),
                    true,
                  )
                } catch {
                  continue
                }
              }
              // Prefer local package breakouts: a gap-only pair must not turn
              // a long, independently routed approach into its main interconnect.
              // This is a candidate-search bound, separate from any explicit
              // maxUncoupledLength electrical constraint checked by the solver.
              if (negotiation?.matchPairSkew) {
                const spacing = pairInteriorSpacing(
                  { ...input, differentialPairs: [pair] },
                  traces,
                  approachAllowance,
                  0.04,
                )[0]
                if (
                  spacing.conductors.some(
                    (c) =>
                      c.samples &&
                      (c.minGapMm! < gap - Math.max(0.02, gap * 0.2) ||
                        c.maxGapMm! > gap + Math.max(0.035, gap * 0.25)),
                  )
                )
                  continue
              }
              // The reference pair-variants.py scores foreign terminals enclosed
              // between rails. Reject that topology: it forces other bus lanes to
              // cross a pair or take an avoidable trip around a package.
              const polygon = [
                ...traces[0].route,
                ...traces[1].route.toReversed(),
              ]
              if (
                input.connections.some(
                  (c) =>
                    !pair.connectionNames.includes(c.name) &&
                    c.pointsToConnect.some((p) => inside(p, polygon)),
                ) ||
                fixed.some(
                  (copper) =>
                    copper.layer === layer &&
                    !copper.owners.some((owner) => names.has(owner)) &&
                    distance(copper.a, copper.b) < 1e-8 &&
                    inside(copper.a, polygon),
                )
              )
                continue
              // A pair approach must not seal another terminal into a pocket. Check
              // remaining same-layer connections before locking this corridor.
              let trapsTerminal = false
              let longestCarrier = Math.max(
                ...traces.map((t) => length(t.route)),
              )
              let candidateScore = negotiation
                ? Math.abs(length(traces[0].route) - length(traces[1].route)) +
                  0.01 * traces.reduce((sum, t) => sum + length(t.route), 0)
                : traces.reduce((sum, t) => sum + length(t.route), 0)
              for (const other of (negotiation && !negotiation.matchPairSkew
                ? []
                : input.connections
              ).filter(
                (c) =>
                  !pair.connectionNames.includes(c.name) &&
                  c.pointsToConnect[0].layer === layer,
              )) {
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
                const check = new GridVisibilitySearch(
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
                if (check.solved) {
                  candidateScore += length(check.result)
                  longestCarrier = Math.max(
                    longestCarrier,
                    length(check.result),
                  )
                }
                if (!check.solved) {
                  trapsTerminal = true
                  break
                }
              }
              if (
                !trapsTerminal &&
                traces.every((t) =>
                  tuningPathIsSelfClear(t.route, width + clearance),
                )
              ) {
                if (negotiation?.matchPairSkew)
                  candidateScore += 1000 * longestCarrier
                if (candidateScore < bestScore) {
                  bestScore = candidateScore
                  best = traces
                }
                if (++viable >= 2) return best
                continue candidates
              }
            }
          }
        }
  }
  return best
}

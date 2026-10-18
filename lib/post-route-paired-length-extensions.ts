import { bipolarPairedLobes } from "./bipolar-tuning"
import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { boardBoundaryReports } from "./board-boundary"
import { findFixedPathRanges } from "./fixed-route-paths"
import { distance, length } from "./geometry"
import { physicalRoutingAcceptance } from "./physical-routing-acceptance"
import { fixedRouteLength } from "./route-lengths"
import { roundedPairedLobes, smoothPairedLobes } from "./smooth-tuning"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"
import { fixedCopper, VectorScene } from "./vector-scene"

export interface PairedBodyLengthExtensionOptions {
  connectionNames: readonly [string, string]
  minimumLength: number
  maximumLength: number
  fixedEscapes: readonly Trace[]
  maximumCandidates?: number
  maximumAttempts?: number
  /** Absolute monotonic performance.now() deadline in milliseconds, using the
   * same clock as routing stages. A complete physical audit is atomic; an
   * expired audit is never emitted as a proposal. */
  deadlineMs?: number
  /** Smaller, fully physical extensions remain useful to an external best-
   * checkpoint controller. Every emitted pair strictly improves band error. */
  allowPartialProgress?: boolean
  /** Optional preferred clear bays. A proposed lobe must visit one matching
   * bay; its approach remains subject to the complete native copper checks. */
  tuningBays?: readonly (SimpleRouteJson["bounds"] & { layer?: string })[]
  onAttempt?: (result: {
    attempt: number
    addedLength: number
    method: string
    accepted: boolean
    reason: "bay" | "target" | "physical" | "accepted"
    physicalGates?: Readonly<Record<string, boolean>>
    sharedEdgeEndingIndices: readonly [number, number]
  }) => void
}

export interface PairedBodyLengthExtensionProposal {
  traces: [Trace, Trace]
  fullOwnedLengths: [number, number]
  withinTargetBand: boolean
  distanceToTargetBand: number
  previousDistanceToTargetBand: number
  addedVias: 0
  method: string
  attempt: number
  sharedEdgeEndingIndices: readonly [number, number]
}

const bandDistance = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum - value, value - maximum, 0)

/** Search-only foreign-copper rejection. Query only the new planar intervals;
 * unchanged native fanouts may have legal ownership/contact exceptions. The
 * complete native physical oracle remains mandatory for every proposal. */
export function createPairedBodyForeignPrefilter(
  input: SimpleRouteJson,
  joinedRoutes: readonly Trace[],
  connectionNames: readonly [string, string],
) {
  const normalize = (trace: Trace): Trace => ({
    ...trace,
    route: trace.route.map((point, index) =>
      point.route_type === "via"
        ? {
            ...point,
            via_diameter: point.via_diameter ?? input.minViaPadDiameter ?? 0.3,
            layers:
              point.layers ??
              (!(input.allowBlindAndBuriedVias ?? false)
                ? getCopperLayerNames(input.layerCount)
                : undefined),
          }
        : {
            ...point,
            width:
              trace.route[index + 1]?.route_type === "wire" &&
              (trace.route[index + 1] as Wire).layer === point.layer
                ? Math.max(point.width, (trace.route[index + 1] as Wire).width)
                : point.width,
          },
    ),
  })
  const aliasGroups = [
    ...input.obstacles.map((obstacle) => obstacle.connectedTo),
    ...input.connections.map((connection) =>
      [
        connection.name,
        connection.source_trace_id,
        ...connection.pointsToConnect.flatMap((point) => [
          point.pointId,
          point.pcb_port_id,
        ]),
      ].filter((token): token is string => !!token),
    ),
    ...(input.traces ?? []).map((trace) =>
      [trace.connection_name, trace.source_trace_id, trace.pcb_trace_id].filter(
        (token): token is string => !!token,
      ),
    ),
  ]
  const ownerAliases = connectionNames.map((name) => {
    const aliases = new Set([name])
    let changed = true
    while (changed) {
      changed = false
      for (const tokens of aliasGroups) {
        if (!tokens.some((token) => aliases.has(token))) continue
        for (const token of tokens)
          if (!aliases.has(token)) {
            aliases.add(token)
            changed = true
          }
      }
    }
    return aliases
  })
  const resolveOwners = (copper: ReturnType<typeof fixedCopper>) =>
    copper.map((item) => ({
      ...item,
      // Native DRC follows chained pad aliases. Expanding only search metadata
      // avoids treating same-net alias pads as foreign; ambiguous groups are
      // allowed through to the unchanged full native audit.
      owners: [
        ...item.owners,
        ...connectionNames.filter((_, side) =>
          item.owners.some((owner) => ownerAliases[side].has(owner)),
        ),
      ],
    }))
  const foreign = resolveOwners(
    fixedCopper({
      ...input,
      // An AABB of a rotated rectangle or a package-body ownership exemption
      // can be stricter than native DRC. Defer those ambiguous pads/bodies to
      // the mandatory full audit instead of pruning legal search geometry.
      obstacles: input.obstacles.filter(
        (obstacle) =>
          !(obstacle.componentId && obstacle.connectedTo.length === 0) &&
          (obstacle.shape === "circle" ||
            Math.abs(
              Math.sin(
                (2 * (obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180,
              ),
            ) < 1e-10),
      ),
      traces: [
        ...(input.traces ?? []),
        ...joinedRoutes.filter(
          (trace) => !connectionNames.includes(trace.connection_name ?? ""),
        ),
      ].map(normalize),
    }),
  )
  const members = connectionNames.map((name) =>
    input.connections.find((connection) => connection.name === name),
  )
  if (members.some((connection) => !connection))
    throw Error("Foreign paired prefilter requires native pair owners")
  const pair = input.differentialPairs?.find((candidate) =>
    candidate.connectionNames.every((name) => connectionNames.includes(name)),
  )
  const foreignInput = {
    ...input,
    minTraceToPadEdgeClearance: Math.max(
      0,
      (input.minTraceToPadEdgeClearance ??
        input.defaultObstacleMargin ??
        0.075) - 1e-6,
    ),
  }
  const mateInput = {
    ...input,
    minTraceToPadEdgeClearance: Math.max(
      0,
      Math.min(
        input.minTraceToPadEdgeClearance ??
          input.defaultObstacleMargin ??
          0.075,
        pair?.traceGap ?? Infinity,
      ) - 1e-6,
    ),
  }
  const scenes = new Map<string, VectorScene>()
  return (
    proposed: readonly [Trace, Trace],
    changedPaths: readonly [readonly Wire[], readonly Wire[]],
  ): boolean =>
    changedPaths.every((path, side) => {
      const first = path[0]
      if (
        !first ||
        path.some(
          (point) => point.layer !== first.layer || point.width !== first.width,
        )
      )
        return false
      const connection = {
        ...members[side]!,
        pointsToConnect: members[side]!.pointsToConnect.map((point) => ({
          ...point,
          layer: first.layer,
        })),
      }
      const key = `${side}/${first.layer}/${first.width}`
      let scene = scenes.get(key)
      if (!scene) {
        scene = new VectorScene(foreignInput, connection, first.width, foreign)
        scenes.set(key, scene)
      }
      if (!scene.pathVisible([...path])) return false
      const mate = new VectorScene(
        mateInput,
        connection,
        first.width,
        resolveOwners(
          fixedCopper({
            ...input,
            obstacles: [],
            traces: [normalize(proposed[1 - side])],
          }),
        ),
      )
      return mate.pathVisible([...path])
    })
}

/** Insert new body copper without rebuilding any original point record. */
function insertSharedSegment(
  trace: Trace,
  index: number,
  points: Point[],
): Trace {
  const wire = trace.route[index] as Wire
  const added = points.map((point) => ({
    ...point,
    route_type: "wire" as const,
    width: wire.width,
    layer: wire.layer,
  }))
  const curves = [
    ...(trace.curvedSegments ?? []).map((ending) =>
      ending > index ? ending + added.length : ending,
    ),
    // The paired generators emit tangent-continuous sampled curves, including
    // their straight legs. Preserve permissions only on these new edges.
    ...added.slice(1).map((_, offset) => index + offset + 2),
  ].sort((a, b) => a - b)
  return {
    ...trace,
    route: [
      ...trace.route.slice(0, index + 1),
      ...added,
      ...trace.route.slice(index + 1),
    ],
    curvedSegments: curves,
    coupledSection: [
      trace.coupledSection![0],
      trace.coupledSection![1] + added.length,
    ],
  }
}

/** Propose joint extensions of an already routed pair's free shared sections.
 * Native endpoints, every immutable escape and every other joined route stay
 * unchanged. This generator never installs a candidate or weakens timing:
 * partial progress is explicit, and each proposal passes complete physical
 * acceptance, including intrinsic pair skew and shared/exterior coupling. */
export function* enumeratePairedBodyLengthExtensions(
  input: SimpleRouteJson,
  joinedRoutes: readonly Trace[],
  options: PairedBodyLengthExtensionOptions,
): Generator<void | PairedBodyLengthExtensionProposal, void> {
  const { minimumLength, maximumLength, connectionNames } = options
  const maximumCandidates = options.maximumCandidates ?? 16
  const maximumAttempts = options.maximumAttempts ?? 256
  if (
    !Number.isFinite(minimumLength) ||
    minimumLength < 0 ||
    !Number.isFinite(maximumLength) ||
    maximumLength < minimumLength ||
    new Set(connectionNames).size !== 2 ||
    !Number.isInteger(maximumCandidates) ||
    maximumCandidates < 0 ||
    maximumCandidates > 256 ||
    !Number.isInteger(maximumAttempts) ||
    maximumAttempts < 0 ||
    maximumAttempts > 4096 ||
    (options.deadlineMs !== undefined &&
      !Number.isFinite(options.deadlineMs)) ||
    options.tuningBays?.some(
      (bay) =>
        ![bay.minX, bay.maxX, bay.minY, bay.maxY].every(Number.isFinite) ||
        bay.minX >= bay.maxX ||
        bay.minY >= bay.maxY,
    )
  )
    throw Error("Invalid paired body extension request or budget")
  const expired = () =>
    options.deadlineMs !== undefined && performance.now() >= options.deadlineMs
  if (!maximumCandidates || !maximumAttempts || expired()) return
  const pair = input.differentialPairs?.find((candidate) =>
    candidate.connectionNames.every((name) => connectionNames.includes(name)),
  )
  if (!pair)
    throw Error(
      "Paired body extension requires an unchanged native differential pair",
    )
  const indices = connectionNames.map((name) =>
    joinedRoutes.findIndex((trace) => trace.connection_name === name),
  )
  if (indices.some((index) => index < 0))
    throw Error("Missing joined paired route")
  const rails = indices.map((index) => joinedRoutes[index]) as [Trace, Trace]
  const baseline = physicalRoutingAcceptance(input, joinedRoutes, {
    escapes: options.fixedEscapes,
  })
  if (!baseline.physicalRoutingAccepted)
    throw Error(
      "Paired body extension requires a complete physically accepted incumbent",
    )
  if (expired()) return
  if (rails.some((trace) => !trace.coupledSection)) return
  const fixedRanges = rails.map((trace) =>
    findFixedPathRanges(trace, options.fixedEscapes),
  )
  if (fixedRanges.some((ranges) => ranges === null))
    throw Error("Immutable paired escape is absent")
  const freeEdge = (rail: number, index: number) =>
    !fixedRanges[rail]!.some(
      (range) => index >= range.start && index < range.end,
    ) && !(rails[rail].curvedSegments ?? []).includes(index + 1)
  const total = (trace: Trace) =>
    length(trace.route) + fixedRouteLength(input, trace.connection_name!)
  const originalTotals = rails.map(total)
  const previousDistance = originalTotals.reduce(
    (sum, value) => sum + bandDistance(value, minimumLength, maximumLength),
    0,
  )
  const deficit = Math.max(
    0,
    ...originalTotals.map((value) => minimumLength - value),
  )
  const room = Math.min(...originalTotals.map((value) => maximumLength - value))
  if (deficit <= 1e-8 || room <= 1e-8) return
  const request = Math.min(
    room,
    deficit + Math.min(1e-6, Math.max(0, room - deficit) / 2),
  )
  const ratios =
    options.allowPartialProgress === false
      ? [1]
      : [1, 0.75, 0.5, 0.25, 0.125, 0.0625]
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const gap = pair.traceGap ?? clearance
  const patterns = [
    { method: "rounded-shared-bay", create: roundedPairedLobes },
    { method: "balanced-shared-bay", create: bipolarPairedLobes },
    { method: "smooth-shared-bay", create: smoothPairedLobes },
  ]
  let attempts = 0,
    emitted = 0
  const seen = new Set<string>()
  const spans: Array<{
    i: number
    j: number
    a: Wire
    b: Wire
    first: Wire
    last: Wire
    forward: boolean
    offset: number
    lo: number
    hi: number
    ux: number
    uy: number
  }> = []
  for (
    let i = rails[0].coupledSection![0];
    i < rails[0].coupledSection![1];
    i++
  ) {
    if (expired()) return
    if (!freeEdge(0, i)) continue
    const a = rails[0].route[i],
      b = rails[0].route[i + 1]
    if (
      a.route_type !== "wire" ||
      b.route_type !== "wire" ||
      a.layer !== b.layer ||
      a.width !== b.width
    )
      continue
    const span = distance(a, b)
    if (span < a.width * 8) continue
    const ux = (b.x - a.x) / span,
      uy = (b.y - a.y) / span
    for (
      let j = rails[1].coupledSection![0];
      j < rails[1].coupledSection![1];
      j++
    ) {
      if (!freeEdge(1, j)) continue
      const first = rails[1].route[j],
        last = rails[1].route[j + 1]
      if (
        first.route_type !== "wire" ||
        last.route_type !== "wire" ||
        first.layer !== a.layer ||
        last.layer !== a.layer ||
        first.width !== a.width ||
        last.width !== a.width
      )
        continue
      const otherSpan = distance(first, last)
      if (otherSpan < first.width * 8) continue
      const vx = (last.x - first.x) / otherSpan,
        vy = (last.y - first.y) / otherSpan
      const forward = Math.hypot(vx - ux, vy - uy) < 1e-6
      if (!forward && Math.hypot(vx + ux, vy + uy) >= 1e-6) continue
      const c = forward ? first : last,
        d = forward ? last : first
      const spacing = a.width + gap
      const offset = -(c.x - a.x) * uy + (c.y - a.y) * ux
      if (Math.abs(Math.abs(offset) - spacing) > 1e-6) continue
      const project = (point: Point) =>
        (point.x - a.x) * ux + (point.y - a.y) * uy
      const lo = Math.max(0, project(c)) + a.width * 2
      const hi = Math.min(span, project(d)) - a.width * 2
      if (hi - lo < a.width * 8) continue
      spans.push({ i, j, a, b, first, last, forward, offset, lo, hi, ux, uy })
    }
  }
  const foreignClear = createPairedBodyForeignPrefilter(
    input,
    joinedRoutes,
    connectionNames,
  )
  // Each span advances to its next generated shape before another span gets
  // another attempt. Even spans whose early parameter combinations are
  // infeasible receive a fair share of a small global attempt budget.
  function* spanShapes(span: (typeof spans)[number]) {
    const { a, offset, lo, hi, ux, uy } = span
    const center = (at: number): Point => ({
      x: a.x + ux * at - (uy * offset) / 2,
      y: a.y + uy * at + (ux * offset) / 2,
    })
    for (const ratio of ratios)
      for (const fraction of [0.9, 0.65, 0.4])
        for (const lobes of [1, 2, 4])
          for (const pattern of patterns)
            for (const side of [1, -1]) {
              if (expired()) return
              const margin = ((hi - lo) * (1 - fraction)) / 2
              const addedLength = request * ratio
              const waves = pattern.create(
                center(lo + margin),
                center(hi - margin),
                a.width + gap,
                addedLength,
                lobes,
                side,
                Math.max(a.width * 1.2, clearance),
              )
              if (waves) yield { waves, addedLength, method: pattern.method }
            }
  }
  const queue = spans.map((span) => ({ span, shapes: spanShapes(span) }))
  while (queue.length) {
    if (
      attempts >= maximumAttempts ||
      emitted >= maximumCandidates ||
      expired()
    )
      return
    const current = queue.shift()!
    const next = current.shapes.next()
    if (next.done) continue
    queue.push(current)
    const { i, j, a, b, first, last, forward, offset } = current.span
    const { waves, addedLength, method } = next.value
    attempts++
    yield
    if (expired()) return
    const ordered = offset > 0 ? waves.toReversed() : waves
    const paths = [ordered[0], forward ? ordered[1] : ordered[1].toReversed()]
    const diagnostic = {
      attempt: attempts,
      addedLength,
      method,
      sharedEdgeEndingIndices: [i + 1, j + 1] as const,
    }
    if (
      options.tuningBays?.length &&
      !options.tuningBays.some(
        (bay) =>
          (!bay.layer || bay.layer === a.layer) &&
          paths
            .flat()
            .some(
              (point) =>
                point.x >= bay.minX &&
                point.x <= bay.maxX &&
                point.y >= bay.minY &&
                point.y <= bay.maxY,
            ),
      )
    ) {
      options.onAttempt?.({
        ...diagnostic,
        accepted: false,
        reason: "bay",
      })
      continue
    }
    const proposed: [Trace, Trace] = [
      insertSharedSegment(rails[0], i, paths[0]),
      insertSharedSegment(rails[1], j, paths[1]),
    ]
    if (!boardBoundaryReports(input, proposed).valid) {
      options.onAttempt?.({
        ...diagnostic,
        accepted: false,
        reason: "physical",
        physicalGates: { boardBoundaryValid: false },
      })
      continue
    }
    const fullOwnedLengths = proposed.map(total) as [number, number]
    const distanceToTargetBand = fullOwnedLengths.reduce(
      (sum, value) => sum + bandDistance(value, minimumLength, maximumLength),
      0,
    )
    const withinTargetBand = fullOwnedLengths.every(
      (value) => value >= minimumLength - 1e-7 && value <= maximumLength + 1e-7,
    )
    if (
      distanceToTargetBand >= previousDistance - 1e-8 ||
      (options.allowPartialProgress === false && !withinTargetBand)
    ) {
      options.onAttempt?.({
        ...diagnostic,
        accepted: false,
        reason: "target",
      })
      continue
    }
    const key = JSON.stringify(proposed)
    if (seen.has(key)) continue
    seen.add(key)
    const changedPaths = [
      [a, ...paths[0].map((point) => ({ ...a, ...point })), b],
      [first, ...paths[1].map((point) => ({ ...first, ...point })), last],
    ] as const
    if (!foreignClear(proposed, changedPaths)) {
      options.onAttempt?.({
        ...diagnostic,
        accepted: false,
        reason: "physical",
        physicalGates: { foreignCopperClear: false },
      })
      continue
    }
    if (expired()) return
    const replaced = joinedRoutes.map((trace, index) =>
      index === indices[0]
        ? proposed[0]
        : index === indices[1]
          ? proposed[1]
          : trace,
    )
    const acceptance = physicalRoutingAcceptance(input, replaced, {
      escapes: options.fixedEscapes,
    })
    if (expired()) return
    if (!acceptance.physicalRoutingAccepted) {
      options.onAttempt?.({
        ...diagnostic,
        accepted: false,
        reason: "physical",
        physicalGates: { ...acceptance.gates },
      })
      continue
    }
    options.onAttempt?.({
      ...diagnostic,
      accepted: true,
      reason: "accepted",
      physicalGates: { ...acceptance.gates },
    })
    emitted++
    yield {
      traces: structuredClone(proposed),
      fullOwnedLengths,
      withinTargetBand,
      distanceToTargetBand,
      previousDistanceToTargetBand: previousDistance,
      addedVias: 0,
      method,
      attempt: attempts,
      sharedEdgeEndingIndices: diagnostic.sharedEdgeEndingIndices,
    }
  }
}

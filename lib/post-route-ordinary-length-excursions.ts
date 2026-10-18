import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { BoardBoundary } from "./board-boundary"
import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { findFixedPathRanges } from "./fixed-route-paths"
import { distance, length, simplify } from "./geometry"
import { GridVisibilitySearch } from "./grid-visibility"
import {
  nativeTerminalPoints,
  nativeTerminalTolerance,
} from "./native-terminal-sites"
import { physicalRoutingAcceptance } from "./physical-routing-acceptance"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { fixedRouteLength } from "./route-lengths"
import { roundedTuningLobes, smoothTuningLobes } from "./smooth-tuning"
import type {
  Connection,
  Point,
  SimpleRouteJson,
  Trace,
  Via,
  Wire,
} from "./types"
import { fixedCopper, VectorScene, type Copper } from "./vector-scene"
import { connectors } from "./vector-visibility"

export type OrdinaryLengthExcursionBay = SimpleRouteJson["bounds"] & {
  side?: "north" | "south" | "east" | "west"
}
export interface OrdinaryLengthExcursionOptions {
  connectionName: string
  /** Complete joined XY copper plus native supplied copper, counted once. */
  minimumLength: number
  maximumLength: number
  fixedEscapes?: readonly Trace[]
  /** Fully physical candidates strictly closer to the band may be proposed. */
  allowPartialProgress?: boolean
  maximumCandidates?: number
  maximumAttempts?: number
  maximumAttachmentPairs?: number
  maximumPortalSites?: number
  maximumBaysPerPair?: number
  maximumExpansions?: number
  attachmentStep?: number
  maximumPortalOffset?: number
  gridStep?: number
  deadlineMs?: number
  tuningBays?: readonly OrdinaryLengthExcursionBay[]
}
export interface OrdinaryLengthExcursionProposal {
  trace: Trace
  fullOwnedLength: number
  withinTargetBand: boolean
  distanceToTargetBand: number
  previousDistanceToTargetBand: number
  addedVias: 2
}
interface Run {
  start: number
  end: number
  layer: string
  width: number
}
interface Portal {
  edge: number
  along: number
  startCut: Wire
  endCut: Wire
  point: Wire
}
type Bay = OrdinaryLengthExcursionBay & {
  side: NonNullable<OrdinaryLengthExcursionBay["side"]>
}
const epsilon = 1e-7
const wire = (p: Point, layer: string, width: number): Wire => ({
  x: p.x,
  y: p.y,
  layer,
  width,
  route_type: "wire",
})
const bandDistance = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum - value, value - maximum, 0)

/** Fixed edges and identity-bearing internal vertices split editable runs.
 * Existing smooth arcs may be removed inside a run; portal cuts use straight
 * chords only, preserving both untouched curve-index ranges exactly. */
function freeRuns(trace: Trace, fixedEscapes: readonly Trace[]): Run[] {
  const ranges = findFixedPathRanges(trace, fixedEscapes)
  if (!ranges || trace.coupledSection !== undefined) return []
  const edges = new Set<number>(),
    vertices = new Set<number>()
  for (const { start, end } of ranges) {
    for (let i = start + 1; i <= end; i++) edges.add(i)
    for (let i = start; i <= end; i++) vertices.add(i)
  }
  const result: Run[] = []
  let start: number | undefined
  const finish = (end: number) => {
    if (start !== undefined && end > start) {
      const p = trace.route[start]
      if (p.route_type === "wire")
        result.push({ start, end, layer: p.layer, width: p.width })
    }
    start = undefined
  }
  for (let i = 1; i < trace.route.length; i++) {
    const a = trace.route[i - 1],
      b = trace.route[i]
    if (
      a.route_type !== "wire" ||
      b.route_type !== "wire" ||
      a.layer !== b.layer ||
      a.width !== b.width ||
      edges.has(i)
    ) {
      finish(i - 1)
      continue
    }
    if (start === undefined) start = i - 1
    const identity = Object.keys(b).some(
      (k) => !["x", "y", "layer", "width", "route_type"].includes(k),
    )
    if (vertices.has(i) || identity) finish(i)
  }
  finish(trace.route.length - 1)
  return result
}

function nativeVoidPoints(
  input: SimpleRouteJson,
  bounds: SimpleRouteJson["bounds"],
): Point[] {
  const groups = new Map<string, typeof input.obstacles>()
  for (const pad of input.obstacles)
    if (pad.componentId) {
      const group = groups.get(pad.componentId) ?? []
      group.push(pad)
      groups.set(pad.componentId, group)
    }
  const unique = (values: number[]) => {
    const result: number[] = []
    for (const v of values.sort((a, b) => a - b))
      if (!result.length || v - result.at(-1)! > epsilon) result.push(v)
    return result
  }
  return [...groups.values()].flatMap((pads) => {
    const xs = unique(pads.map((p) => p.center.x)),
      ys = unique(pads.map((p) => p.center.y))
    if (xs.length > 128 || ys.length > 128) return []
    return xs.slice(1).flatMap((x, i) => {
      const px = (x + xs[i]) / 2
      if (px < bounds.minX || px > bounds.maxX) return []
      return ys.slice(1).flatMap((y, j) => {
        const py = (y + ys[j]) / 2
        return py < bounds.minY || py > bounds.maxY ? [] : [{ x: px, y: py }]
      })
    })
  })
}

function portals(
  input: SimpleRouteJson,
  connection: Connection,
  original: Trace,
  hard: Copper[],
  run: Run,
  opposite: string,
  options: OrdinaryLengthExcursionOptions,
): Portal[] {
  const stack = getCopperLayerNames(input.layerCount),
    diameter = input.minViaPadDiameter ?? 0.3,
    hole = input.minViaHoleDiameter ?? 0.15,
    step = options.attachmentStep ?? 0.1,
    clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    offset = options.maximumPortalOffset ?? 4 * (run.width + clearance),
    sceneInput = input,
    lands = stack.map(
      (layer) =>
        new VectorScene(
          sceneInput,
          {
            ...connection,
            pointsToConnect: connection.pointsToConnect.map((p) => ({
              ...p,
              layer,
            })),
          },
          diameter,
          hard,
        ),
    ),
    planar = new VectorScene(
      sceneInput,
      {
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((p) => ({
          ...p,
          layer: run.layer,
        })),
      },
      run.width,
      hard,
    ),
    terminalPoints = nativeTerminalPoints(input, connection),
    boundary = new BoardBoundary(input),
    oldVias = [...(input.traces ?? []), original].flatMap((t) =>
      t.route.filter((p): p is Via => p.route_type === "via"),
    ),
    drillClearance = input.minViaHoleEdgeToViaHoleEdgeClearance ?? 0,
    raw: Portal[] = [],
    seen = new Set<string>(),
    runPoints = original.route.slice(run.start, run.end + 1),
    voids = nativeVoidPoints(input, {
      minX: Math.min(...runPoints.map((p) => p.x)) - offset,
      maxX: Math.max(...runPoints.map((p) => p.x)) + offset,
      minY: Math.min(...runPoints.map((p) => p.y)) - offset,
      maxY: Math.max(...runPoints.map((p) => p.y)) + offset,
    })
  let walked = 0
  for (let edge = run.start; edge < run.end; edge++) {
    if (performance.now() >= (options.deadlineMs ?? Infinity)) break
    const a = original.route[edge] as Wire,
      b = original.route[edge + 1] as Wire,
      span = distance(a, b),
      before = walked
    walked += span
    if (span < 1e-5 || original.curvedSegments?.includes(edge + 1)) continue
    const ux = (b.x - a.x) / span,
      uy = (b.y - a.y) / span
    const add = (along: number, normal: number) => {
      if (performance.now() >= (options.deadlineMs ?? Infinity)) return
      const lead = Math.abs(normal)
      if (
        Math.abs(normal) > offset + epsilon ||
        along - lead <= epsilon ||
        along + lead >= span - epsilon
      )
        return
      const point = wire(
          {
            x: a.x + ux * along - uy * normal,
            y: a.y + uy * along + ux * normal,
          },
          run.layer,
          run.width,
        ),
        startCut = wire(
          { x: a.x + ux * (along - lead), y: a.y + uy * (along - lead) },
          run.layer,
          run.width,
        ),
        endCut = wire(
          { x: a.x + ux * (along + lead), y: a.y + uy * (along + lead) },
          run.layer,
          run.width,
        ),
        key = [
          edge,
          point.x,
          point.y,
          startCut.x,
          startCut.y,
          endCut.x,
          endCut.y,
        ]
          .map((x) => x.toFixed(8))
          .join(":")
      if (seen.has(key)) return
      seen.add(key)
      if (
        terminalPoints.some(
          (p) => distance(p, point) <= nativeTerminalTolerance,
        ) ||
        !boundary.containsSegment(point, point, diameter / 2) ||
        oldVias.some(
          (v) =>
            distance(v, point) <
            (hole + (v.via_hole_diameter ?? hole)) / 2 +
              drillClearance -
              epsilon,
        ) ||
        lands.some((scene) => !scene.visible(point, point)) ||
        !planar.visible(startCut, point) ||
        !planar.visible(point, endCut)
      )
        return
      raw.push({ edge, along: before + along, startCut, endCut, point })
    }
    const samples = Math.min(64, Math.max(2, Math.ceil(span / step)))
    for (let i = 1; i < samples; i++)
      for (const normal of [0, step, -step, 2 * step, -2 * step])
        add((span * i) / samples, normal)
    for (const point of voids) {
      const dx = point.x - a.x,
        dy = point.y - a.y
      add(dx * ux + dy * uy, -dx * uy + dy * ux)
    }
  }
  raw.sort(
    (a, b) =>
      a.along - b.along ||
      distance(a.startCut, a.point) - distance(b.startCut, b.point),
  )
  const limit = options.maximumPortalSites ?? 64
  if (raw.length <= limit) return raw
  return Array.from(
    { length: limit },
    (_, i) => raw[Math.round((i * (raw.length - 1)) / (limit - 1))],
  )
}

function baySide(
  box: OrdinaryLengthExcursionBay,
  a: Point,
  b: Point,
): Bay["side"] {
  if (box.side) return box.side
  const dx = (box.minX + box.maxX - a.x - b.x) / 2,
    dy = (box.minY + box.maxY - a.y - b.y) / 2
  return Math.abs(dx) > Math.abs(dy)
    ? dx > 0
      ? "east"
      : "west"
    : dy > 0
      ? "north"
      : "south"
}
function proposedBays(
  a: Point,
  b: Point,
  pitch: number,
  provided?: readonly OrdinaryLengthExcursionBay[],
): Bay[] {
  if (provided)
    return provided.map((box) => ({ ...box, side: baySide(box, a, b) }))
  const result: Bay[] = [],
    cx = (a.x + b.x) / 2,
    cy = (a.y + b.y) / 2
  for (const size of [8, 16, 32].map((k) => k * pitch))
    for (const gap of [3, 8, 16, 32, 64].map((k) => k * pitch))
      for (const offset of [0, -size / 2, size / 2]) {
        result.push({
          side: "north",
          minX: cx - size / 2 + offset,
          maxX: cx + size / 2 + offset,
          minY: Math.max(a.y, b.y) + gap,
          maxY: Math.max(a.y, b.y) + gap + size,
        })
        result.push({
          side: "south",
          minX: cx - size / 2 + offset,
          maxX: cx + size / 2 + offset,
          maxY: Math.min(a.y, b.y) - gap,
          minY: Math.min(a.y, b.y) - gap - size,
        })
        result.push({
          side: "east",
          minY: cy - size / 2 + offset,
          maxY: cy + size / 2 + offset,
          minX: Math.max(a.x, b.x) + gap,
          maxX: Math.max(a.x, b.x) + gap + size,
        })
        result.push({
          side: "west",
          minY: cy - size / 2 + offset,
          maxY: cy + size / 2 + offset,
          maxX: Math.min(a.x, b.x) - gap,
          minX: Math.min(a.x, b.x) - gap - size,
        })
      }
  return result
}
function inside(box: OrdinaryLengthExcursionBay, p: Point) {
  return (
    p.x >= box.minX - epsilon &&
    p.x <= box.maxX + epsilon &&
    p.y >= box.minY - epsilon &&
    p.y <= box.maxY + epsilon
  )
}
function clearBay(scene: VectorScene, box: Bay) {
  if (
    ![box.minX, box.maxX, box.minY, box.maxY].every(Number.isFinite) ||
    box.minX >= box.maxX ||
    box.minY >= box.maxY
  )
    return false
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.minX, y: box.maxY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
  ]
  if (!corners.every((p) => scene.visible(p, p))) return false
  return !scene.copper.some((c) => {
    const r = c.rect ?? {
      minX: Math.min(c.a.x, c.b.x) - c.radius,
      maxX: Math.max(c.a.x, c.b.x) + c.radius,
      minY: Math.min(c.a.y, c.b.y) - c.radius,
      maxY: Math.max(c.a.y, c.b.y) + c.radius,
    }
    return (
      r.maxX + scene.margin > box.minX &&
      r.minX - scene.margin < box.maxX &&
      r.maxY + scene.margin > box.minY &&
      r.minY - scene.margin < box.maxY
    )
  })
}
function bayEnds(box: Bay, a: Point, b: Point, pitch: number): [Point, Point] {
  let ends: [Point, Point]
  if (box.side === "north" || box.side === "south") {
    const y = box.side === "north" ? box.minY : box.maxY
    ends = [
      { x: box.minX + pitch, y },
      { x: box.maxX - pitch, y },
    ]
  } else {
    const x = box.side === "east" ? box.minX : box.maxX
    ends = [
      { x, y: box.minY + pitch },
      { x, y: box.maxY - pitch },
    ]
  }
  return distance(a, ends[0]) + distance(b, ends[1]) <=
    distance(a, ends[1]) + distance(b, ends[0])
    ? ends
    : (ends.toReversed() as [Point, Point])
}
function* routeLead(
  scene: VectorScene,
  start: Point,
  end: Point,
  box: Bay,
  maximum: number,
  options: OrdinaryLengthExcursionOptions,
): Generator<void, Point[] | null> {
  const allowed = (p: Point) =>
    box.side === "north"
      ? p.y <= box.minY + epsilon
      : box.side === "south"
        ? p.y >= box.maxY - epsilon
        : box.side === "east"
          ? p.x <= box.minX + epsilon
          : p.x >= box.maxX - epsilon
  for (const path of connectors(start, end)
    .map(simplify)
    .sort((a, b) => length(a) - length(b)))
    if (path.every(allowed) && scene.pathVisible(path)) return path
  const bounds = {
    minX: Math.max(scene.input.bounds.minX, Math.min(start.x, end.x) - 2),
    maxX: Math.min(scene.input.bounds.maxX, Math.max(start.x, end.x) + 2),
    minY: Math.max(scene.input.bounds.minY, Math.min(start.y, end.y) - 2),
    maxY: Math.min(scene.input.bounds.maxY, Math.max(start.y, end.y) + 2),
  }
  if (box.side === "north") bounds.maxY = Math.min(bounds.maxY, box.minY)
  if (box.side === "south") bounds.minY = Math.max(bounds.minY, box.maxY)
  if (box.side === "east") bounds.maxX = Math.min(bounds.maxX, box.minX)
  if (box.side === "west") bounds.minX = Math.max(bounds.minX, box.maxX)
  const search = new GridVisibilitySearch(scene, start, end, [], 4, undefined, {
    step: options.gridStep ?? 0.1,
    bounds,
    maxLength: maximum,
    paretoLength: Number.isFinite(maximum),
    allTerminalAttachments: true,
  })
  try {
    while (
      !search.solved &&
      !search.failed &&
      search.expanded < (options.maximumExpansions ?? 5000) &&
      performance.now() < (options.deadlineMs ?? Infinity)
    ) {
      search.step()
      if ((search.expanded & 63) === 0) yield
    }
    return search.solved && search.result.every(allowed) ? search.result : null
  } finally {
    search.cancel()
  }
}

function splice(
  original: Trace,
  a: Portal,
  b: Portal,
  carrier: Trace,
  opposite: string,
  stack: string[],
  diameter: number,
  hole: number,
): Trace {
  const from = a.point.layer,
    firstVia: Via = {
      x: a.point.x,
      y: a.point.y,
      route_type: "via",
      from_layer: from,
      to_layer: opposite,
      layers: [...stack],
      via_diameter: diameter,
      via_hole_diameter: hole,
    },
    lastVia: Via = {
      x: b.point.x,
      y: b.point.y,
      route_type: "via",
      from_layer: opposite,
      to_layer: from,
      layers: [...stack],
      via_diameter: diameter,
      via_hole_diameter: hole,
    },
    before = [
      ...original.route.slice(0, a.edge + 1),
      a.startCut,
      ...(distance(a.startCut, a.point) > epsilon ? [a.point] : []),
      firstVia,
    ],
    after = [
      lastVia,
      b.point,
      ...(distance(b.point, b.endCut) > epsilon ? [b.endCut] : []),
      ...original.route.slice(b.edge + 1),
    ],
    route = [...before, ...carrier.route, ...after],
    delta = route.length - original.route.length,
    curves = [
      ...(original.curvedSegments ?? []).filter((i) => i <= a.edge),
      ...(carrier.curvedSegments ?? []).map((i) => before.length + i),
      ...(original.curvedSegments ?? [])
        .filter((i) => i > b.edge + 1)
        .map((i) => i + delta),
    ].sort((x, y) => x - y)
  return {
    ...structuredClone(original),
    route: structuredClone(route),
    curvedSegments: curves.length ? curves : undefined,
  }
}

/** Bounded proposals only. No state is adopted here. Every emitted replacement
 * has exactly two additional full-stack PTHs, retains all immutable paths and
 * passes the complete generic physical audit with every other route hard.
 * `undefined` yields permit cooperative budgets during visibility searches. */
export function* enumerateOrdinaryTwoViaLengthExcursions(
  input: SimpleRouteJson,
  joinedRoutes: readonly Trace[],
  options: OrdinaryLengthExcursionOptions,
): Generator<OrdinaryLengthExcursionProposal | void, void> {
  const ints = [
    options.maximumCandidates ?? 8,
    options.maximumAttempts ?? 256,
    options.maximumAttachmentPairs ?? 24,
    options.maximumPortalSites ?? 64,
    options.maximumBaysPerPair ?? 12,
    options.maximumExpansions ?? 5000,
  ]
  if (
    !Number.isFinite(options.minimumLength) ||
    options.minimumLength < 0 ||
    !(
      Number.isFinite(options.maximumLength) ||
      options.maximumLength === Infinity
    ) ||
    options.maximumLength < options.minimumLength ||
    ints.some((x) => !Number.isSafeInteger(x) || x < 1) ||
    ints[3] < 2 ||
    [
      options.attachmentStep ?? 0.1,
      options.gridStep ?? 0.1,
      options.maximumPortalOffset ?? 1,
    ].some((x) => !Number.isFinite(x) || x <= 0) ||
    !(
      options.deadlineMs === undefined ||
      Number.isFinite(options.deadlineMs) ||
      options.deadlineMs === Infinity
    )
  )
    return
  if (performance.now() >= (options.deadlineMs ?? Infinity)) return
  const target = joinedRoutes.find(
      (t) => t.connection_name === options.connectionName,
    ),
    connection = input.connections.find(
      (c) => c.name === options.connectionName,
    ),
    fixedEscapes = options.fixedEscapes ?? []
  if (
    !target ||
    !connection ||
    joinedRoutes.filter((t) => t.connection_name === options.connectionName)
      .length !== 1 ||
    input.differentialPairs?.some((p) =>
      p.connectionNames.includes(options.connectionName),
    )
  )
    return
  const ownerBuses = (input.buses ?? []).filter((bus) =>
    bus.connectionNames.includes(options.connectionName),
  )
  const minimumLength = Math.max(
    options.minimumLength,
    ...ownerBuses.flatMap((bus) =>
      bus.minLength === undefined ? [] : [bus.minLength],
    ),
  )
  const maximumLength = Math.min(
    options.maximumLength,
    ...ownerBuses.flatMap((bus) =>
      bus.maxLength === undefined ? [] : [bus.maxLength],
    ),
  )
  if (
    !Number.isFinite(minimumLength) ||
    minimumLength < 0 ||
    !(Number.isFinite(maximumLength) || maximumLength === Infinity) ||
    maximumLength < minimumLength
  )
    return
  options = { ...options, minimumLength, maximumLength }
  const snapshot = JSON.stringify({ input, joinedRoutes, fixedEscapes }),
    baseline = physicalRoutingAcceptance(input, joinedRoutes, {
      escapes: fixedEscapes,
    })
  if (!baseline.physicalRoutingAccepted) return
  const oldLength =
      length(target.route) + fixedRouteLength(input, options.connectionName),
    previousDistance = bandDistance(
      oldLength,
      options.minimumLength,
      options.maximumLength,
    )
  if (previousDistance <= epsilon) return
  const stack = getCopperLayerNames(input.layerCount),
    diameter = input.minViaPadDiameter ?? 0.3,
    hole = input.minViaHoleDiameter ?? 0.15,
    hardOthers = joinedRoutes.filter((t) => t !== target),
    sceneInput = { ...input, traces: [...(input.traces ?? []), ...hardOthers] },
    hard = fixedCopper(sceneInput),
    seen = new Set<string>(),
    runs = freeRuns(target, fixedEscapes),
    nativeOwn = (input.traces ?? []).filter(
      (t) =>
        t.connection_name === connection.name ||
        t.source_trace_id === (connection.source_trace_id ?? connection.name),
    )
  let guardSerial = 0
  const guardToken = () => {
    let token: string
    do {
      token = `post_route_excursion_guard_${guardSerial++}`
    } while (snapshot.includes(JSON.stringify(token)))
    return token
  }
  let yielded = 0,
    attempted = 0,
    attachments = 0
  const consider = (
    trace: Trace,
  ): OrdinaryLengthExcursionProposal | undefined => {
    const fullOwnedLength =
        length(trace.route) + fixedRouteLength(input, options.connectionName),
      distanceToTargetBand = bandDistance(
        fullOwnedLength,
        options.minimumLength,
        options.maximumLength,
      ),
      withinTargetBand = distanceToTargetBand <= epsilon,
      key = JSON.stringify(trace.route)
    if (
      seen.has(key) ||
      (!withinTargetBand &&
        (!options.allowPartialProgress ||
          distanceToTargetBand >= previousDistance - epsilon))
    )
      return
    seen.add(key)
    if (
      trace.route.filter((p) => p.route_type === "via").length !==
      target.route.filter((p) => p.route_type === "via").length + 2
    )
      return
    const replaced = joinedRoutes.map((t) => (t === target ? trace : t))
    if (
      !physicalRoutingAcceptance(input, replaced, { escapes: fixedEscapes })
        .physicalRoutingAccepted
    )
      return
    if (performance.now() >= (options.deadlineMs ?? Infinity)) return
    if (JSON.stringify({ input, joinedRoutes, fixedEscapes }) !== snapshot)
      throw Error("Length excursion mutated caller geometry")
    return {
      trace,
      fullOwnedLength,
      withinTargetBand,
      distanceToTargetBand,
      previousDistanceToTargetBand: previousDistance,
      addedVias: 2,
    }
  }
  const jobs: Array<{
    run: Run
    opposite: string
    a: Portal
    b: Portal
    rank: number
    runIndex: number
  }> = []
  for (const [runIndex, run] of runs.entries()) {
    if (performance.now() >= (options.deadlineMs ?? Infinity)) return
    const opposite =
      run.layer === stack[0]
        ? stack.at(-1)!
        : run.layer === stack.at(-1)
          ? stack[0]
          : undefined
    if (
      !opposite ||
      !(input.allowedLayers ?? stack).includes(opposite) ||
      (input.buses ?? []).some(
        (bus) =>
          bus.connectionNames.includes(options.connectionName) &&
          bus.allowedLayers &&
          !bus.allowedLayers.includes(opposite),
      )
    )
      continue
    const sites = portals(
        sceneInput,
        connection,
        target,
        hard,
        run,
        opposite,
        options,
      ),
      pairs = sites
        .flatMap((a, i) =>
          sites.slice(i + 1).flatMap((b) => {
            const minimumPitch =
              hole + (input.minViaHoleEdgeToViaHoleEdgeClearance ?? 0)
            return a.along < b.along - epsilon &&
              a.edge <= b.edge &&
              distance(a.point, b.point) >= minimumPitch - epsilon
              ? [{ a, b, span: b.along - a.along }]
              : []
          }),
        )
        .sort((a, b) => b.span - a.span)
    for (const [rank, { a, b }] of pairs.slice(0, ints[2]).entries())
      jobs.push({ run, opposite, a, b, rank, runIndex })
    yield
  }
  // Fairly visit each editable run before spending extra attachment pairs.
  jobs.sort((a, b) => a.rank - b.rank || a.runIndex - b.runIndex)
  for (const { run, opposite, a, b } of jobs) {
    if (
      attachments++ >= ints[2] ||
      performance.now() >= (options.deadlineMs ?? Infinity)
    )
      return
    // Only the selected middle is removed. Nonchosen own copper is a hard
    // guard for opposite-plane lead searches; final own-net self checks use
    // the untouched native identity and full rebuilt trace.
    const kept: Trace[] = [
      ...nativeOwn,
      { ...target, route: target.route.slice(0, a.edge + 1) },
      { ...target, route: target.route.slice(b.edge + 1) },
    ]
    const ownGuard: Copper[] = fixedCopper({
      ...input,
      obstacles: [],
      traces: kept,
    }).map((c) => ({ ...c, owners: [guardToken()] }))
    const copper: Copper[] = [...hard, ...ownGuard]
    const local: Connection = {
      ...connection,
      pointsToConnect: [
        { ...a.point, layer: opposite },
        { ...b.point, layer: opposite },
      ],
    }
    const scene: VectorScene = new VectorScene(
      sceneInput,
      local,
      run.width,
      copper,
    )
    const pitch: number = run.width + scene.margin
    const allBays: Array<{ box: Bay; e: Point; f: Point; lower: number }> =
      proposedBays(a.point, b.point, pitch, options.tuningBays)
        .filter((box) => clearBay(scene, box))
        .map((box) => {
          const [e, f] = bayEnds(box, a.point, b.point, 2 * pitch)
          return {
            box,
            e,
            f,
            lower: distance(a.point, e) + distance(e, f) + distance(f, b.point),
          }
        })
        .sort((x, y) => x.lower - y.lower)
    const bays: typeof allBays = [],
      sizes = new Set<number>()
    for (const candidate of allBays) {
      const size =
        (candidate.box.maxX - candidate.box.minX) *
        (candidate.box.maxY - candidate.box.minY)
      if (!sizes.has(size)) {
        sizes.add(size)
        bays.push(candidate)
      }
    }
    for (const candidate of allBays)
      if (!bays.includes(candidate)) bays.push(candidate)
    for (const { box, e, f } of bays.slice(0, ints[4])) {
      if (
        attempted >= ints[1] ||
        performance.now() >= (options.deadlineMs ?? Infinity)
      )
        return
      const budget = options.allowPartialProgress
          ? options.maximumLength + previousDistance
          : options.maximumLength,
        first = yield* routeLead(scene, a.point, e, box, budget, options)
      if (!first) continue
      const firstCopper = fixedCopper({
          ...input,
          obstacles: [],
          traces: [
            {
              type: "pcb_trace",
              pcb_trace_id: "lead-guard",
              route: first.map((p) => wire(p, opposite, run.width)),
            },
          ],
        }).map((c) => ({ ...c, owners: [guardToken()] })),
        secondScene = new VectorScene(sceneInput, local, run.width, [
          ...copper,
          ...firstCopper,
        ]),
        second = yield* routeLead(secondScene, b.point, f, box, budget, options)
      if (!second) continue
      const base: Trace = {
          type: "pcb_trace",
          pcb_trace_id: target.pcb_trace_id + "__excursion_carrier",
          connection_name: target.connection_name,
          source_trace_id: target.source_trace_id,
          route: [...first, f, ...second.toReversed().slice(1)].map((p) =>
            wire(p, opposite, run.width),
          ),
        },
        carrierInput = {
          ...sceneInput,
          connections: input.connections.map((c) =>
            c.name === connection.name ? local : c,
          ),
        },
        carrier = chamferOrdinaryCorners(carrierInput, [base], copper)[0],
        raw = splice(target, a, b, carrier, opposite, stack, diameter, hole),
        rawLength =
          length(raw.route) + fixedRouteLength(input, options.connectionName),
        deficit = Math.max(0, options.minimumLength - rawLength)
      const candidates: Trace[] = [carrier]
      if (deficit > epsilon)
        for (let i = 0; i + 1 < carrier.route.length; i++) {
          const p = carrier.route[i],
            q = carrier.route[i + 1]
          if (
            p.route_type !== "wire" ||
            q.route_type !== "wire" ||
            !inside(box, p) ||
            !inside(box, q) ||
            carrier.curvedSegments?.includes(i + 1) ||
            distance(p, q) < 4 * pitch
          )
            continue
          for (const fraction of options.allowPartialProgress
            ? [1, 0.75, 0.5, 0.25]
            : [1])
            for (const teeth of [1, 2, 3, 4, 6, 8])
              for (const side of [-1, 1])
                for (const build of [roundedTuningLobes, smoothTuningLobes]) {
                  if (candidates.length >= ints[1] - attempted) break
                  const points = build(
                    p,
                    q,
                    deficit * fraction,
                    teeth,
                    side,
                    Math.max(run.width * 1.2, scene.margin),
                  )
                  if (!points || !points.every((p) => inside(box, p))) continue
                  const route = [
                      ...carrier.route.slice(0, i),
                      ...points.map((p) => wire(p, opposite, run.width)),
                      ...carrier.route.slice(i + 2),
                    ],
                    delta = route.length - carrier.route.length,
                    curvedSegments = [
                      ...(carrier.curvedSegments ?? []).filter((k) => k <= i),
                      ...points.slice(1).map((_, j) => i + j + 1),
                      ...(carrier.curvedSegments ?? [])
                        .filter((k) => k > i + 1)
                        .map((k) => k + delta),
                    ].sort((x, y) => x - y)
                  candidates.push({ ...carrier, route, curvedSegments })
                }
        }
      for (const candidate of candidates) {
        if (
          attempted++ >= ints[1] ||
          performance.now() >= (options.deadlineMs ?? Infinity)
        )
          return
        if (!routeAnglesAreConventional([candidate])) continue
        const proposal = consider(
          splice(target, a, b, candidate, opposite, stack, diameter, hole),
        )
        if (proposal) {
          yield proposal
          if (++yielded >= ints[0]) return
        } else yield
      }
    }
    yield
  }
}

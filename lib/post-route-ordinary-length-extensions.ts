import { findFixedPathRanges } from "./fixed-route-paths"
import { distance, length } from "./geometry"
import { physicalRoutingAcceptance } from "./physical-routing-acceptance"
import { fixedRouteLength } from "./route-lengths"
import { roundedTuningLobes, smoothTuningLobes } from "./smooth-tuning"
import type { SimpleRouteJson, Trace, Wire } from "./types"
import { fixedCopper, VectorScene } from "./vector-scene"

export interface OrdinaryLengthExtensionOptions {
  connectionName: string
  /** Complete joined XY copper plus native supplied copper, counted once. */
  minimumLength: number
  maximumLength: number
  fixedEscapes?: readonly Trace[]
  /** Propose physical candidates strictly closer to an unmet target band. */
  allowPartialProgress?: boolean
  maximumCandidates?: number
  maximumAttempts?: number
  deadlineMs?: number
}

export interface OrdinaryLengthExtensionProposal {
  trace: Trace
  fullOwnedLength: number
  withinTargetBand: boolean
  distanceToTargetBand: number
  previousDistanceToTargetBand: number
  addedVias: 0
}

interface FreeSpan {
  /** Start vertex of one editable straight chord. */
  edge: number
  a: Wire
  b: Wire
}

const epsilon = 1e-7
const bandDistance = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum - value, value - maximum, 0)

function freeSpans(trace: Trace, fixedEscapes: readonly Trace[]): FreeSpan[] {
  const ranges = findFixedPathRanges(trace, fixedEscapes)
  if (!ranges || trace.coupledSection !== undefined) return []
  const protectedEdges = new Set<number>()
  for (const { start, end } of ranges)
    for (let i = start + 1; i <= end; i++) protectedEdges.add(i)
  const curved = new Set(trace.curvedSegments ?? [])
  const result: FreeSpan[] = []
  for (let edge = 0; edge + 1 < trace.route.length; edge++) {
    const a = trace.route[edge],
      b = trace.route[edge + 1]
    if (
      a.route_type === "wire" &&
      b.route_type === "wire" &&
      a.layer === b.layer &&
      a.width === b.width &&
      !protectedEdges.has(edge + 1) &&
      !curved.has(edge + 1) &&
      distance(a, b) > epsilon
    )
      result.push({ edge, a, b })
  }
  return result
}

/** Add copper in place without changing any via or fixed path. Every free
 * straight span gets a placement before the portfolio deepens its shapes.
 * Progress yields permit the controller to enforce a cooperative work budget;
 * proposals always pass the complete physical oracle with all other owners. */
export function* extendOrdinaryRouteLength(
  originalInput: SimpleRouteJson,
  originalJoinedRoutes: readonly Trace[],
  originalOptions: OrdinaryLengthExtensionOptions,
): Generator<OrdinaryLengthExtensionProposal | void, void> {
  const options = { ...originalOptions },
    maximumCandidates = options.maximumCandidates ?? 8,
    maximumAttempts = options.maximumAttempts ?? 256,
    deadline = options.deadlineMs ?? Infinity,
    expired = () => performance.now() >= deadline
  if (
    !Number.isFinite(options.minimumLength) ||
    options.minimumLength < 0 ||
    !(
      Number.isFinite(options.maximumLength) ||
      options.maximumLength === Infinity
    ) ||
    options.maximumLength < options.minimumLength ||
    [maximumCandidates, maximumAttempts].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    !(Number.isFinite(deadline) || deadline === Infinity) ||
    expired()
  )
    return
  const input = structuredClone(originalInput),
    joinedRoutes = structuredClone(originalJoinedRoutes),
    fixedEscapes = structuredClone(options.fixedEscapes ?? []),
    target = joinedRoutes.find(
      (trace) => trace.connection_name === options.connectionName,
    ),
    connection = input.connections.find(
      (item) => item.name === options.connectionName,
    )
  if (
    !target ||
    !connection ||
    joinedRoutes.filter(
      (trace) => trace.connection_name === options.connectionName,
    ).length !== 1 ||
    target.coupledSection !== undefined ||
    input.differentialPairs?.some((pair) =>
      pair.connectionNames.includes(options.connectionName),
    )
  )
    return
  let minimumLength = options.minimumLength,
    maximumLength = options.maximumLength
  for (const bus of input.buses ?? []) {
    if (!bus.connectionNames.includes(options.connectionName)) continue
    minimumLength = Math.max(minimumLength, bus.minLength ?? 0)
    maximumLength = Math.min(maximumLength, bus.maxLength ?? Infinity)
  }
  if (
    !Number.isFinite(minimumLength) ||
    !(Number.isFinite(maximumLength) || maximumLength === Infinity) ||
    maximumLength < minimumLength
  )
    return
  const nativeLength = fixedRouteLength(input, options.connectionName),
    previousLength = length(target.route) + nativeLength,
    previousDistance = bandDistance(
      previousLength,
      minimumLength,
      maximumLength,
    ),
    spans = freeSpans(target, fixedEscapes)
  // Adding copper cannot improve a route already inside or above its band.
  if (previousLength >= minimumLength - epsilon || !spans.length || expired())
    return
  if (
    !physicalRoutingAcceptance(input, joinedRoutes, { escapes: fixedEscapes })
      .physicalRoutingAccepted ||
    expired()
  )
    return
  const others = joinedRoutes.filter((trace) => trace !== target),
    foreignCopper = fixedCopper({
      ...input,
      obstacles: [],
      traces: others,
    }).map((copper) => ({ ...copper, owners: [] })),
    hard = [...fixedCopper(input), ...foreignCopper],
    scenes = new Map<string, VectorScene>(),
    seen = new Set<string>(),
    desiredLength =
      minimumLength +
      (Number.isFinite(maximumLength)
        ? Math.min((maximumLength - minimumLength) / 2, 1e-4)
        : 0),
    deficit = desiredLength - previousLength,
    // Probe logarithmically smaller additions early, then fill the missing
    // dyadic levels. A dense but finite bay may fit far less than a quarter
    // of the requested deficit; these remain truthful partial proposals.
    fractions = options.allowPartialProgress
      ? [
          1,
          1 / 8,
          1 / 64,
          1 / 512,
          1 / 4096,
          1 / 2,
          1 / 4,
          1 / 16,
          1 / 32,
          1 / 128,
          1 / 256,
          1 / 1024,
          1 / 2048,
        ]
      : [1]
  let attempts = 0,
    yielded = 0
  // Shapes are the outer loop: a blocked first edge cannot consume the
  // entire budget while a later free body remains untried.
  for (const lobes of [1, 2, 4, 8])
    for (const fraction of fractions)
      for (const side of [1, -1])
        for (const create of [roundedTuningLobes, smoothTuningLobes])
          for (const { edge, a, b } of spans) {
            if (
              expired() ||
              attempts >= maximumAttempts ||
              yielded >= maximumCandidates
            )
              return
            attempts++
            yield
            if (expired()) return
            const points = create(
              a,
              b,
              deficit * fraction,
              lobes,
              side,
              Math.max(
                a.width * 1.2,
                input.minTraceToPadEdgeClearance ??
                  input.defaultObstacleMargin ??
                  0.075,
              ),
            )
            if (!points || points.length < 2 || expired()) continue
            const path: Wire[] = points.map((point) => ({
              ...point,
              route_type: "wire",
              layer: a.layer,
              width: a.width,
            }))
            // Keep every endpoint field and its exact coordinates unchanged.
            path[0] = a
            path[path.length - 1] = b
            const sceneKey = JSON.stringify([a.layer, a.width])
            let scene = scenes.get(sceneKey)
            if (!scene) {
              scene = new VectorScene(
                input,
                {
                  ...connection,
                  pointsToConnect: connection.pointsToConnect.map((point) => ({
                    ...point,
                    layer: a.layer,
                  })),
                },
                a.width,
                hard,
              )
              scenes.set(sceneKey, scene)
            }
            if (!scene.pathVisible(path) || expired()) continue
            const shift = path.length - 2,
              curves = [
                ...(target.curvedSegments ?? []).map((index) =>
                  index > edge + 1 ? index + shift : index,
                ),
                ...path.slice(1).map((_, index) => edge + index + 1),
              ].sort((x, y) => x - y),
              trace: Trace = {
                ...target,
                route: [
                  ...target.route.slice(0, edge),
                  ...path,
                  ...target.route.slice(edge + 2),
                ],
                curvedSegments: curves,
              },
              key = JSON.stringify(trace.route),
              fullOwnedLength = length(trace.route) + nativeLength,
              distanceToTargetBand = bandDistance(
                fullOwnedLength,
                minimumLength,
                maximumLength,
              ),
              withinTargetBand = distanceToTargetBand <= epsilon
            if (
              seen.has(key) ||
              distanceToTargetBand >= previousDistance - epsilon ||
              (!withinTargetBand && !options.allowPartialProgress) ||
              !findFixedPathRanges(trace, fixedEscapes)
            )
              continue
            seen.add(key)
            const replacement = joinedRoutes.map((route) =>
              route === target ? trace : route,
            )
            if (
              !physicalRoutingAcceptance(input, replacement, {
                escapes: fixedEscapes,
              }).physicalRoutingAccepted ||
              expired()
            )
              continue
            yielded++
            yield {
              trace: structuredClone(trace),
              fullOwnedLength,
              withinTargetBand,
              distanceToTargetBand,
              previousDistanceToTargetBand: previousDistance,
              addedVias: 0,
            }
          }
}

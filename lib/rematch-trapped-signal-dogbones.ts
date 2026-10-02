import {
  getCopperLayerNames,
  routeLocalSignalDogbones,
} from "@tscircuit/fanout-solver"
import { distance } from "./geometry"
import { GridVisibilitySearch } from "./grid-visibility"
import { isUnroutedComponentPad } from "./is-unrouted-component-pad"
import type {
  Connection,
  Point,
  SimpleRouteJson,
  Terminal,
  Trace,
  Via,
} from "./types"
import { fixedCopper, VectorScene, type Copper } from "./vector-scene"

export interface RematchedSignalDogbones {
  connections: Connection[]
  escapes: Trace[]
}

function* reachable(
  input: SimpleRouteJson,
  connection: Connection,
  fixed: Copper[],
  width: number,
  layer: string,
  end = connection.pointsToConnect[1],
  bounds?: SimpleRouteJson["bounds"],
): Generator<void, boolean> {
  const local = {
    ...connection,
    pointsToConnect: connection.pointsToConnect.map((point, index) => ({
      ...(index ? end : point),
      layer,
    })),
  }
  const search = new GridVisibilitySearch(
    new VectorScene(input, local, width, fixed),
    local.pointsToConnect[0],
    local.pointsToConnect[1],
    [],
    0,
    undefined,
    bounds ? { bounds } : undefined,
  )
  try {
    while (!search.solved && !search.failed) {
      search.step()
      yield
    }
    return search.solved
  } finally {
    if (!search.solved && !search.failed) search.cancel()
  }
}

function componentField(
  input: SimpleRouteJson,
  source: Connection,
  endpoint: number,
) {
  const point = source.pointsToConnect[endpoint]
  const owners = new Set(
    [
      source.name,
      source.source_trace_id,
      point.pcb_port_id,
      point.pointId,
    ].filter(Boolean),
  )
  const pad = input.obstacles
    .filter(
      (obstacle) =>
        obstacle.componentId &&
        obstacle.connectedTo.some((owner) => owners.has(owner)),
    )
    .sort((a, b) => distance(a.center, point) - distance(b.center, point))[0]
  if (!pad) return
  const pads = input.obstacles.filter(
    (obstacle) => obstacle.componentId === pad.componentId,
  )
  const rectangles = pads.map((obstacle) => {
    const angle = ((obstacle.ccwRotationDegrees ?? 0) * Math.PI) / 180
    return {
      center: obstacle.center,
      width:
        Math.abs(Math.cos(angle)) * obstacle.width +
        Math.abs(Math.sin(angle)) * obstacle.height,
      height:
        Math.abs(Math.sin(angle)) * obstacle.width +
        Math.abs(Math.cos(angle)) * obstacle.height,
    }
  })
  return {
    minX: Math.min(
      ...rectangles.map((obstacle) => obstacle.center.x - obstacle.width / 2),
    ),
    maxX: Math.max(
      ...rectangles.map((obstacle) => obstacle.center.x + obstacle.width / 2),
    ),
    minY: Math.min(
      ...rectangles.map((obstacle) => obstacle.center.y - obstacle.height / 2),
    ),
    maxY: Math.max(
      ...rectangles.map((obstacle) => obstacle.center.y + obstacle.height / 2),
    ),
  }
}

/** Locate a genuinely closed package exit before excluding a site. A working
 * single-site endpoint must remain fixed when its opposite endpoint is trapped. */
function* trappedEndpoints(
  input: SimpleRouteJson,
  source: Connection,
  connection: Connection,
  fixed: Copper[],
  width: number,
  layers: string[],
): Generator<void, number[]> {
  const result: number[] = []
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const margin = 3 * (width + clearance)
  for (const endpoint of [0, 1]) {
    const field = componentField(input, source, endpoint)
    if (!field) continue
    const point = connection.pointsToConnect[endpoint]
    const edge = width / 2 + (input.minBoardEdgeClearance ?? 0)
    const bounds = {
      minX: Math.max(input.bounds.minX + edge, field.minX - 2 * margin),
      maxX: Math.min(input.bounds.maxX - edge, field.maxX + 2 * margin),
      minY: Math.max(input.bounds.minY + edge, field.minY - 2 * margin),
      maxY: Math.min(input.bounds.maxY - edge, field.maxY + 2 * margin),
    }
    const goals: Terminal[] = [
      { ...point, x: Math.max(bounds.minX, field.minX - margin) },
      { ...point, x: Math.min(bounds.maxX, field.maxX + margin) },
      { ...point, y: Math.max(bounds.minY, field.minY - margin) },
      { ...point, y: Math.min(bounds.maxY, field.maxY + margin) },
    ]
      .filter(
        (goal) =>
          goal.x < field.minX ||
          goal.x > field.maxX ||
          goal.y < field.minY ||
          goal.y > field.maxY,
      )
      .sort((a, b) => distance(point, a) - distance(point, b))
    let escaped = false
    for (const layer of layers) {
      const local = { ...connection, pointsToConnect: [point, point] }
      for (const goal of goals) {
        if (yield* reachable(input, local, fixed, width, layer, goal, bounds)) {
          escaped = true
          break
        }
      }
      if (escaped) break
    }
    if (goals.length && !escaped) result.push(endpoint)
  }
  return result
}

/** Reconsider only this invocation's fresh pad dogbones when completed buses
 * close every existing signal-layer continuation. Native supplied fanouts and
 * all other copper remain fixed. Temporary site exclusions never leave this
 * helper; every search yields and releases its grid lease on interruption. */
export function* rematchTrappedSignalDogbones(
  native: SimpleRouteJson,
  pending: SimpleRouteJson,
  completed: Trace[],
  escapes: Trace[],
  terminalLayers: ReadonlyMap<string, string[]>,
): Generator<void, RematchedSignalDogbones> {
  const result = {
    connections: structuredClone(pending.connections),
    escapes: [...escapes],
  }
  const physicalLayers = getCopperLayerNames(native.layerCount)
  for (const [index, connection] of result.connections.entries()) {
    const source = native.connections.find(
      (original) => original.name === connection.name,
    )
    const owned = result.escapes.filter(
      (trace) => trace.connection_name === connection.name,
    )
    const vias = owned.map((trace) =>
      trace.route.find((point): point is Via => point.route_type === "via"),
    )
    if (
      !source ||
      owned.length !== 2 ||
      vias.some((via) => !via) ||
      source.pointsToConnect.some(
        (point) => !isUnroutedComponentPad(native, source, point),
      )
    )
      continue
    const layers = (
      terminalLayers.get(connection.name) ?? [
        connection.pointsToConnect[0].layer,
      ]
    ).filter((layer) => layer !== "top" && physicalLayers.includes(layer))
    if (!layers.length) continue
    const width =
      connection.nominalTraceWidth ?? connection.width ?? native.minTraceWidth
    const sceneInput = {
      ...pending,
      connections: result.connections,
      traces: [...(native.traces ?? []), ...result.escapes, ...completed],
    }
    const fixed = fixedCopper(sceneInput)
    const blockedLayers: string[] = []
    let reachableLayers = 0
    for (const layer of layers) {
      if (yield* reachable(sceneInput, connection, fixed, width, layer))
        reachableLayers++
      else blockedLayers.push(layer)
    }
    if (reachableLayers >= Math.min(2, layers.length)) continue
    let shared = false
    const trapped = yield* trappedEndpoints(
      sceneInput,
      source,
      connection,
      fixed,
      width,
      blockedLayers,
    )
    if (!trapped.length && reachableLayers === 0) trapped.push(0, 1)
    if (!trapped.length) continue
    const base = {
      ...native,
      connections: [source],
      traces: [
        ...(native.traces ?? []),
        ...result.escapes.filter(
          (trace) => trace.connection_name !== connection.name,
        ),
        ...completed,
      ],
    }
    const queue = trapped.map((endpoint) => [vias[endpoint]! as Point])
    const seen = new Set<string>([
      JSON.stringify(connection.pointsToConnect.map(({ x, y }) => [x, y])),
    ])
    // BGA interstices have a small local domain. Never exhaust a global budget
    // repeatedly generating the same two-terminal assignment.
    for (let trial = 0; trial < 16 && queue.length; trial++) {
      const excluded = queue.shift()!
      const searchInput = {
        ...base,
        obstacles: [
          ...base.obstacles,
          ...excluded.map((point) => ({
            shape: "circle" as const,
            center: { x: point.x, y: point.y },
            width: 1e-6,
            height: 1e-6,
            layers: physicalLayers,
            connectedTo: [],
          })),
        ],
      }
      let candidate: ReturnType<typeof routeLocalSignalDogbones>
      try {
        candidate = routeLocalSignalDogbones(
          searchInput as Parameters<typeof routeLocalSignalDogbones>[0],
          {
            targetLayers: new Map([
              [connection.name, connection.pointsToConnect[0].layer],
            ]),
            viaDiameter: Math.max(
              ...vias.map(
                (via) => via!.via_diameter ?? native.minViaPadDiameter ?? 0.6,
              ),
            ),
            viaHoleDiameter: Math.max(
              ...vias.map(
                (via) =>
                  via!.via_hole_diameter ?? native.minViaHoleDiameter ?? 0.3,
              ),
            ),
            traceWidth: Math.max(
              ...owned.flatMap((trace) =>
                trace.route.flatMap((point) =>
                  point.route_type === "wire" ? [point.width] : [],
                ),
              ),
            ),
            clearance:
              native.minTraceToPadEdgeClearance ??
              native.defaultObstacleMargin ??
              0.075,
            holeToHoleClearance: native.minViaHoleEdgeToViaHoleEdgeClearance,
            boardEdgeClearance: native.minBoardEdgeClearance,
            allowBlindAndBuriedVias: native.allowBlindAndBuriedVias ?? false,
          },
        )
      } catch {
        yield
        continue
      }
      yield
      const replacement: Connection = {
        ...connection,
        pointsToConnect: candidate.connections[0].pointsToConnect as Terminal[],
      }
      const key = JSON.stringify(
        replacement.pointsToConnect.map(({ x, y }) => [x, y]),
      )
      if (seen.has(key)) continue
      seen.add(key)
      const traces = candidate.traces.map((trace) => ({
        ...trace,
        source_trace_id: source.source_trace_id ?? connection.name,
      })) as Trace[]
      // Search the actual native scene, without the temporary exclusions.
      const candidateInput = {
        ...sceneInput,
        traces: [...base.traces, ...traces],
      }
      const candidateFixed = fixedCopper(candidateInput)
      let candidateReachableLayers = 0
      for (const layer of layers) {
        if (
          yield* reachable(
            candidateInput,
            replacement,
            candidateFixed,
            width,
            layer,
          )
        )
          candidateReachableLayers++
      }
      shared = candidateReachableLayers > reachableLayers
      if (shared) {
        result.connections[index] = replacement
        result.escapes = [
          ...result.escapes.filter(
            (trace) => trace.connection_name !== connection.name,
          ),
          ...traces,
        ]
        break
      }
      for (const endpoint of yield* trappedEndpoints(
        candidateInput,
        source,
        replacement,
        candidateFixed,
        width,
        blockedLayers,
      )) {
        const point = replacement.pointsToConnect[endpoint]
        if (!excluded.some((old) => distance(old, point) < 1e-8))
          queue.push([...excluded, point])
      }
    }
  }
  return result
}

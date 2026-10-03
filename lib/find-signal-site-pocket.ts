import { routeAlternateSignalDogbones } from "./alternate-signal-dogbones"
import {
  signalDogboneOptions,
  ownedSignalEscapes,
  signalWidth,
} from "./repair-bus-dogbones"
import {
  fixedCopper,
  routeCopper,
  VectorScene,
  clearanceToCopper,
  type Copper,
} from "./vector-scene"
import { GridVisibilitySearch } from "./grid-visibility"
import { RouteConflictIndex } from "./route-conflict-index"
import { length } from "./geometry"
import {
  signalLayers,
  signalTrace,
  type FlexibleSignalState,
} from "./flexible-signal-state"
import type { Connection, Terminal, Trace, Wire } from "./types"

/** Release the smallest carrier closure, then include nearby alternate-plane
 * crossings. Keeping both planes in the pocket lets negotiation change their
 * crossing order without disturbing an entire completed bus. */
export function* expandSignalSitePocket(
  state: FlexibleSignalState,
): Generator<void, Set<string>> {
  const { native, pending, retained, traces } = state
  const fixed = fixedCopper(pending),
    conflicts = new RouteConflictIndex(),
    remove = new Set<string>()
  const clearance =
    native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  const probe = function* (
    connection: Connection,
    hard: Copper[],
    local = pending,
    lanes = traces,
  ): Generator<void, { blockers: Trace[]; layer: string }[]> {
    const results: { blockers: Trace[]; layer: string }[] = []
    const source = native.connections.find((c) => c.name === connection.name)!
    const width = signalWidth(native, source)
    for (const layer of signalLayers(native, source)) {
      const c = {
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((p) => ({
          ...p,
          layer,
        })),
      }
      const search = new GridVisibilitySearch(
        new VectorScene(local, c, width, hard),
        c.pointsToConnect[0],
        c.pointsToConnect[1],
        lanes.flatMap(routeCopper),
        100,
      )
      try {
        let steps = 0
        while (!search.solved && !search.failed && steps++ < 3000) {
          search.step()
          yield
        }
        if (search.solved)
          results.push({
            layer,
            blockers: lanes.filter(
              (t) =>
                (t.route[0] as Wire).layer === layer &&
                conflicts.firstConflict(
                  search.result,
                  t.route,
                  (width + (t.route[0] as Wire).width) / 2 + clearance - 1e-8,
                ),
            ),
          })
      } finally {
        search.cancel()
      }
    }
    return results
  }
  for (const connection of pending.connections.filter(
    (c) => !traces.some((t) => t.connection_name === c.name),
  )) {
    const best = (yield* probe(connection, fixed)).sort(
      (a, b) => a.blockers.length - b.blockers.length,
    )[0]
    remove.add(connection.name)
    for (const trace of best?.blockers ?? []) remove.add(trace.connection_name!)
  }
  const additions = new Set<string>(),
    remaining = traces.filter((t) => !remove.has(t.connection_name!))
  for (const connection of pending.connections.filter((c) =>
    remove.has(c.name),
  )) {
    const reduced = {
      ...pending,
      traces: [
        ...(native.traces ?? []),
        ...state.escapes.filter((t) => !remove.has(t.connection_name!)),
        ...retained,
      ],
    }
    const choices = yield* probe(
      connection,
      fixedCopper(reduced),
      reduced,
      remaining,
    )
    for (const choice of choices)
      if (choice.blockers.length <= 3)
        for (const trace of choice.blockers)
          additions.add(trace.connection_name!)
    const best = choices.sort(
      (a, b) => a.blockers.length - b.blockers.length,
    )[0]
    for (const trace of best?.blockers ?? [])
      additions.add(trace.connection_name!)
  }
  for (const name of additions) remove.add(name)
  return remove
}

/** A new dogbone is an obstacle on every layer its via spans. Include those
 * blockers together with carrier crossings; carrier-only closure misses them. */
export function* findViaAwareSignalPocket(
  state: FlexibleSignalState,
): Generator<void, Set<string>> {
  const { native } = state,
    carriers = [...state.retained, ...state.traces]
  const pairs = new Set(
      native.differentialPairs?.flatMap((p) => p.connectionNames),
    ),
    remove = new Set<string>()
  const clearance =
    native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  const existing = [...state.escapes, ...carriers].map((trace) => ({
    name: trace.connection_name!,
    copper: fixedCopper({ ...native, obstacles: [], traces: [trace] }),
  }))
  const hits = (copper: Copper[]) =>
    new Set(
      existing
        .filter((other) =>
          copper.some((a) =>
            other.copper.some(
              (b) =>
                a.layer === b.layer &&
                clearanceToCopper(a.a, a.b, b) < a.radius + clearance - 1e-8,
            ),
          ),
        )
        .map((other) => other.name),
    )
  for (const connection of native.connections.filter(
    (c) => !carriers.some((t) => t.connection_name === c.name),
  )) {
    const layers = signalLayers(native, connection)
    if (!layers.length) return new Set()
    const single = { ...native, connections: [connection] }
    const ends: Array<Array<{ point: Terminal; escape: Trace }>> = [[], []]
    for (let variant = 0; variant < 4; variant++) {
      try {
        const generated = routeAlternateSignalDogbones(
          single,
          signalDogboneOptions(single, new Map([[connection.name, layers[0]]])),
          variant,
        )
        for (let end = 0; end < 2; end++) {
          const point = generated.connections[0].pointsToConnect[
            end
          ] as Terminal
          if (
            ends[end].some(
              (site) =>
                Math.hypot(site.point.x - point.x, site.point.y - point.y) <
                1e-6,
            )
          )
            continue
          const escape = ownedSignalEscapes(native, generated.traces).find(
            (t) =>
              Math.hypot(
                t.route[0].x - connection.pointsToConnect[end].x,
                t.route[0].y - connection.pointsToConnect[end].y,
              ) < 1e-6,
          )
          if (escape) ends[end].push({ point, escape })
        }
      } catch {
        /* Another local quadrant may remain legal. */
      }
      yield
    }
    let best: { cost: number; names: Set<string> } | undefined
    for (const a of ends[0])
      for (const b of ends[1]) {
        const escapeCopper = fixedCopper({
            ...native,
            obstacles: [],
            traces: [a.escape, b.escape],
          }),
          viaHits = hits(escapeCopper)
        if ([...viaHits].some((name) => pairs.has(name))) continue
        const input = {
          ...native,
          connections: [connection],
          traces: [
            ...(native.traces ?? []),
            ...state.escapes.filter((t) => !viaHits.has(t.connection_name!)),
            ...carriers.filter((t) => pairs.has(t.connection_name!)),
          ],
        }
        const hard = fixedCopper(input)
        for (const layer of layers) {
          const local = {
            ...connection,
            pointsToConnect: [a.point, b.point].map((point) => ({
              ...point,
              layer,
            })),
          }
          const search = new GridVisibilitySearch(
            new VectorScene(
              input,
              local,
              signalWidth(native, connection),
              hard,
            ),
            local.pointsToConnect[0],
            local.pointsToConnect[1],
            carriers
              .filter((t) => !pairs.has(t.connection_name!))
              .flatMap(routeCopper),
            100,
          )
          try {
            let steps = 0
            while (!search.solved && !search.failed && steps++ < 4000) {
              search.step()
              yield
            }
            if (search.solved) {
              const trace = signalTrace(
                  native,
                  connection,
                  search.result,
                  layer,
                ),
                names = hits([...escapeCopper, ...routeCopper(trace)]),
                cost = names.size * 1000 + length(trace.route)
              if (
                ![...names].some((name) => pairs.has(name)) &&
                (!best || cost < best.cost)
              )
                best = { cost, names }
            }
          } finally {
            search.cancel()
          }
        }
      }
    remove.add(connection.name)
    for (const name of best?.names ?? []) remove.add(name)
  }
  return remove
}

import { CopperConflictIndex } from "./copper-conflict-index"
import { length } from "./geometry"
import { routeAlternateSignalDogbones } from "./alternate-signal-dogbones"
import {
  signalDogboneOptions,
  ownedSignalEscapes,
  signalWidth,
} from "./repair-bus-dogbones"
import { GridVisibilitySearch, GridHistoryProjector } from "./grid-visibility"
import {
  fixedCopper,
  routeCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"
import { RouteConflictIndex } from "./route-conflict-index"
import {
  signalLayers,
  signalTrace,
  type FlexibleSignalState,
} from "./flexible-signal-state"
import type { Connection, Terminal, Trace, Wire } from "./types"

interface SiteOption {
  connection: Connection
  escapes: Trace[]
  escapeCopper: Copper[]
  scene: VectorScene
  layer: string
  length: number
}
interface Candidate extends SiteOption {
  id: number
  trace: Trace
  copper: Copper[]
  hits: Candidate[]
  score: number
}

/** Negotiate dogbone sites and signal layers as one atomic route choice. Via
 * barrels participate on every spanned layer, even when carriers use different
 * planes. Only this bounded pocket is movable; all other copper stays fixed. */
export function* negotiateSignalSites(
  state: FlexibleSignalState,
  remove: ReadonlySet<string>,
  stopWithOneRemaining = false,
): Generator<void, FlexibleSignalState | null> {
  if (!remove.size) return null
  const { native } = state
  const all = [...state.retained, ...state.traces]
  const stable = all.filter((trace) => !remove.has(trace.connection_name!))
  const fixedEscapes = state.escapes.filter(
    (trace) => !remove.has(trace.connection_name!),
  )
  const targets = new Map<string, string>([
    ...state.pending.connections.map((c): [string, string] => [
      c.name,
      c.pointsToConnect[0].layer,
    ]),
    ...all.map((t): [string, string] => [
      t.connection_name!,
      (t.route[0] as Wire).layer,
    ]),
  ])
  const base = {
    ...native,
    connections: native.connections.filter((c) => remove.has(c.name)),
    traces: [...(native.traces ?? []), ...fixedEscapes, ...stable],
  }
  if (!base.connections.length) return null
  const hard = fixedCopper(base),
    variants = new Map<string, SiteOption[]>()
  const histories = new Map<string, Float32Array>(),
    projectors = new Map<string, GridHistoryProjector>()
  const clearance =
    native.minTraceToPadEdgeClearance ?? native.defaultObstacleMargin ?? 0.075
  for (const connection of base.connections) {
    const single = { ...base, connections: [connection] },
      ends: Array<Array<{ point: Terminal; escape: Trace }>> = [[], []]
    for (let variant = 0; variant < 4; variant++) {
      try {
        const generated = routeAlternateSignalDogbones(
          single,
          signalDogboneOptions(single, targets),
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
        /* The other quadrants remain independent candidates. */
      }
      yield
    }
    const choices: SiteOption[] = []
    for (const a of ends[0])
      for (const b of ends[1])
        for (const layer of signalLayers(native, connection)) {
          const local = {
            ...connection,
            pointsToConnect: [a.point, b.point].map((point) => ({
              ...point,
              layer,
            })),
          }
          const escapes = [a.escape, b.escape]
          if (
            escapes.some(
              (t) =>
                !t.route.some(
                  (p) => p.route_type === "via" && p.layers?.includes(layer),
                ),
            )
          )
            continue
          const escapeCopper = fixedCopper({
            ...base,
            obstacles: [],
            traces: escapes,
          })
          const scene = new VectorScene(
            base,
            local,
            signalWidth(native, connection),
            hard,
          )
          const search = new GridVisibilitySearch(
            scene,
            local.pointsToConnect[0],
            local.pointsToConnect[1],
          )
          try {
            let steps = 0
            while (!search.solved && !search.failed && steps++ < 3000) {
              search.step()
              yield
            }
            if (search.solved)
              choices.push({
                connection: local,
                escapes,
                escapeCopper,
                scene,
                layer,
                length: length(search.result),
              })
          } finally {
            search.cancel()
          }
        }
    choices.sort((a, b) => a.length - b.length)
    if (!choices.length) return null
    variants.set(connection.name, choices)
  }
  const copperConflicts = new CopperConflictIndex()
  const overlap = (a: Copper[], b: Copper[]) =>
    copperConflicts.firstConflict(a, b, clearance - 1e-8)
  const conflicts = new RouteConflictIndex(),
    pools = new Map<string, Candidate[]>(),
    signatures = new Map<string, Set<string>>(),
    compatibility = new Map<string, boolean>()
  let candidateId = 0
  const compatible = (a: Candidate, b: Candidate) => {
    const key = a.id < b.id ? `${a.id},${b.id}` : `${b.id},${a.id}`
    const cached = compatibility.get(key)
    if (cached !== undefined) return cached
    const required =
      ((a.trace.route[0] as Wire).width + (b.trace.route[0] as Wire).width) /
        2 +
      clearance
    const clash =
      (a.layer === b.layer &&
        conflicts.firstConflict(
          a.trace.route,
          b.trace.route,
          required - 1e-8,
        )) ||
      overlap(a.escapeCopper, b.copper) ||
      overlap(b.escapeCopper, a.copper)
    compatibility.set(key, !clash)
    return !clash
  }
  const addCandidate = (candidate: Candidate) => {
    const name = candidate.connection.name,
      key = JSON.stringify([
        candidate.escapes.map((t) => t.route),
        candidate.trace.route,
      ])
    let seen = signatures.get(name)
    if (!seen) signatures.set(name, (seen = new Set()))
    if (seen.has(key)) return
    seen.add(key)
    let pool = pools.get(name)
    if (!pool) pools.set(name, (pool = []))
    pool.push(candidate)
    if (pool.length > 48) pool.splice(8, 1)
  }
  const select = (): Candidate[] | undefined => {
    if (base.connections.some((c) => !pools.get(c.name)?.length)) return
    let nodes = 0,
      answer: Candidate[] | undefined
    const visit = (selected: Candidate[], domains: Candidate[][]) => {
      if (++nodes > 4000) return
      if (!domains.length) {
        answer = selected
        return
      }
      domains.sort((a, b) => a.length - b.length)
      for (const option of domains[0]) {
        const remaining = domains
          .slice(1)
          .map((domain) => domain.filter((other) => compatible(option, other)))
        if (remaining.some((domain) => !domain.length)) continue
        visit([...selected, option], remaining)
        if (answer) return
      }
    }
    visit(
      [],
      base.connections.map((c) => [...pools.get(c.name)!].reverse()),
    )
    return answer
  }
  const routed = new Map<string, Candidate>(),
    queue = [...base.connections].sort(
      (a, b) => variants.get(a.name)!.length - variants.get(b.name)!.length,
    ),
    visits = new Map<string, number>()
  const finish = (): FlexibleSignalState => {
    const chosen = [...routed.values()],
      escapes = [...fixedEscapes, ...chosen.flatMap((option) => option.escapes)]
    const connections = base.connections.map(
      (c) =>
        routed.get(c.name)?.connection ?? variants.get(c.name)![0].connection,
    )
    return {
      native,
      pending: {
        ...base,
        connections,
        traces: [...(native.traces ?? []), ...escapes, ...stable],
      },
      escapes,
      retained: stable,
      traces: chosen.map((option) => option.trace),
    }
  }
  for (let iteration = 0; queue.length && iteration < 1200; iteration++) {
    const connection = queue.shift()!,
      choices = variants.get(connection.name)!,
      visit = visits.get(connection.name) ?? 0
    visits.set(connection.name, visit + 1)
    routed.delete(connection.name)
    const others = [...routed.values()],
      soft = others.flatMap((option) => option.copper)
    let best: Candidate | undefined
    for (let k = 0; k < Math.min(choices.length, 4); k++) {
      const option = choices[(visit * 4 + k) % choices.length],
        { scene, connection: local, layer } = option
      if (!projectors.has(layer)) {
        const projector = new GridHistoryProjector(scene)
        projectors.set(layer, projector)
        histories.set(layer, new Float32Array(projector.cellCount))
      }
      const search = new GridVisibilitySearch(
        scene,
        local.pointsToConnect[0],
        local.pointsToConnect[1],
        soft,
        10 + iteration,
        histories.get(layer),
      )
      try {
        let steps = 0
        while (!search.solved && !search.failed && steps++ < 3000) {
          search.step()
          yield
        }
        if (search.solved) {
          const trace = signalTrace(native, connection, search.result, layer),
            copper = [...option.escapeCopper, ...routeCopper(trace)]
          const hits = others.filter((other) => overlap(copper, other.copper)),
            score = length(trace.route) + hits.length * 100
          const candidate = {
            ...option,
            id: candidateId++,
            trace,
            copper,
            hits,
            score,
          }
          if (!stopWithOneRemaining) addCandidate(candidate)
          if (!best || score < best.score) best = candidate
        }
      } finally {
        search.cancel()
      }
    }
    if (!best) {
      queue.push(connection)
      continue
    }
    for (const other of best.hits) {
      const hit = overlap(best.copper, other.copper)
      if (hit) {
        const [a, b] = hit
        projectors
          .get(a.layer)
          ?.penalizeIntersection(
            histories.get(a.layer)!,
            a.a,
            a.b,
            b.a,
            b.b,
            a.radius + b.radius + clearance,
            true,
          )
      }
      routed.delete(other.connection.name)
      if (!queue.some((c) => c.name === other.connection.name))
        queue.push(
          base.connections.find((c) => c.name === other.connection.name)!,
        )
    }
    routed.set(connection.name, best)
    if (stopWithOneRemaining && routed.size >= base.connections.length - 1)
      return finish()
    if (
      !stopWithOneRemaining &&
      iteration % 8 === 0 &&
      routed.size >= base.connections.length - 3
    ) {
      const selected = select()
      if (selected) {
        for (const option of selected)
          routed.set(option.connection.name, option)
        queue.length = 0
      }
    }
    yield
  }
  return routed.size === base.connections.length ? finish() : null
}

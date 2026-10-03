import { alignCoupledSectionBoundaries } from "./align-coupled-section-boundaries"
import { routeCoupledPair, offsetPath } from "./coupled-pair-routing"
import { independentBusGroups } from "./route-independent-buses"
import {
  fixedCopper,
  routeCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"
import { GridVisibilitySearch } from "./grid-visibility"
import { distance } from "./geometry"
import type { Connection, Point, SimpleRouteJson, Trace, Wire } from "./types"

export interface PairedNetworkTransform {
  rails: Trace[]
  sections: Wire[][]
  center: Point[]
  width: number
  envelope: number
  offsets: number[]
  connection: Connection
  approaches: Connection[]
  pair: NonNullable<SimpleRouteJson["differentialPairs"]>[number]
}
export interface PairedNetwork {
  input: SimpleRouteJson
  local: SimpleRouteJson
  copper: Copper[]
  widths: Map<string, number>
  layers: ReadonlyMap<string, string[]>
  transforms: PairedNetworkTransform[]
}

/** Negotiate a pair as one wide corridor plus four movable package approaches.
 * The fixed guards preserve the handoff spacing while the corridor is moved. */
export function* preparePairedNetwork(
  input: SimpleRouteJson,
  layers: ReadonlyMap<string, string[]>,
  variantOffset: number | readonly number[] = 0,
): Generator<void, PairedNetwork | null> {
  const constrained = new Set([
    ...(input.buses ?? []).flatMap((b) => b.connectionNames),
    ...(input.differentialPairs ?? []).flatMap((p) => p.connectionNames),
  ])
  const independent = independentBusGroups({
    ...input,
    connections: input.connections.filter((c) => constrained.has(c.name)),
  })
  if (!independent && (input.differentialPairs?.length ?? 0) < 2) return null
  const groups =
    independent ??
    (input.differentialPairs ?? []).map((pair) => {
      const buses = (input.buses ?? []).filter((bus) =>
        pair.connectionNames.some((name) => bus.connectionNames.includes(name)),
      )
      const names = new Set([
        ...pair.connectionNames,
        ...buses.flatMap((bus) => bus.connectionNames),
      ])
      return {
        ...input,
        connections: input.connections.filter((c) => names.has(c.name)),
        buses,
        differentialPairs: [pair],
      }
    })
  if (!groups.length || groups.some((g) => g.differentialPairs?.length !== 1))
    return null
  const fixed = fixedCopper(input),
    transforms: PairedNetworkTransform[] = [],
    guards: Trace[] = []
  for (const group of groups) {
    const pair = group.differentialPairs![0]
    let accepted = false
    for (let variant = 0; variant < 6 && !accepted; variant++) {
      const generator = routeCoupledPair(group, pair, fixed, {
        copper: [],
        penalty: 0,
        variant:
          (variant +
            (typeof variantOffset === "number"
              ? variantOffset
              : (variantOffset[transforms.length] ?? 0))) %
          6,
      })
      let state = generator.next(),
        steps = 0
      try {
        while (!state.done && steps++ < 8000) {
          yield
          state = generator.next()
        }
      } finally {
        if (!state.done) generator.return(null)
      }
      if (!state.done || !state.value) continue
      const rails = alignCoupledSectionBoundaries(group, state.value)
      const sections = rails.map(
        (t) =>
          t.route.slice(
            t.coupledSection![0],
            t.coupledSection![1] + 1,
          ) as Wire[],
      )
      if (sections[0].length !== sections[1].length) continue
      const center = sections[0].map((p, i) => ({
        x: (p.x + sections[1][i].x) / 2,
        y: (p.y + sections[1][i].y) / 2,
      }))
      const width = sections[0][0].width,
        gap =
          pair.traceGap ??
          input.minTraceToPadEdgeClearance ??
          input.defaultObstacleMargin ??
          0.075
      const separation = width + gap,
        envelope = width + separation,
        layer = sections[0][0].layer
      const inset = (a: Point, b: Point) => {
        const span = distance(a, b),
          d = Math.min(span * 0.95, width * 5)
        return {
          x: a.x + ((b.x - a.x) * d) / span,
          y: a.y + ((b.y - a.y) * d) / span,
        }
      }
      const first = inset(center[0], center[1]),
        last = inset(center.at(-1)!, center.at(-2)!)
      const name = `pair_${pair.connectionNames[0]}`
      const offsets = [-separation / 2, separation / 2].sort(
        (a, b) =>
          distance(offsetPath(center, a)[0], sections[0][0]) -
          distance(offsetPath(center, b)[0], sections[0][0]),
      )
      const connection: Connection = {
        name,
        nominalTraceWidth: envelope,
        pointsToConnect: [first, last].map((p) => ({ ...p, layer })),
      }
      const approaches: Connection[] = [],
        candidateGuards: Trace[] = [],
        fixedApproaches: Trace[] = []
      for (let side = 0; side < 2; side++)
        for (let end = 0; end < 2; end++) {
          const rail = rails[side],
            section = sections[side],
            point = end ? section.at(-1)! : section[0]
          const terminal = input.connections.find(
            (c) => c.name === rail.connection_name,
          )!.pointsToConnect[end]
          const approachName = `approach_${rail.connection_name}_${end}`
          approaches.push({
            name: approachName,
            source_trace_id: rail.connection_name,
            nominalTraceWidth: width,
            pointsToConnect: [terminal, point],
          })
          const path = offsetPath(
            end ? [last, center.at(-1)!] : [center[0], first],
            offsets[side],
          ).map((p) => ({ ...p, route_type: "wire" as const, layer, width }))
          const guard: Trace = {
            type: "pcb_trace",
            pcb_trace_id: approachName,
            connection_name: name,
            source_trace_id: rail.connection_name,
            route: path,
          }
          candidateGuards.push(guard)
          const [s, e] = rail.coupledSection!
          fixedApproaches.push({
            ...guard,
            route: end
              ? [...path, ...rail.route.slice(e + 1)]
              : [...rail.route.slice(0, s), ...path],
          })
        }
      const search = new GridVisibilitySearch(
        new VectorScene(input, connection, envelope, [
          ...fixed,
          ...fixedApproaches.flatMap(routeCopper),
        ]),
        connection.pointsToConnect[0],
        connection.pointsToConnect[1],
      )
      try {
        let steps = 0
        while (!search.solved && !search.failed && steps++ < 4000) {
          search.step()
          yield
        }
        if (!search.solved) continue
      } finally {
        search.cancel()
      }
      const standalonePair = !input.buses?.some((b) =>
        pair.connectionNames.some((n) => b.connectionNames.includes(n)),
      )
      transforms.push({
        rails,
        sections,
        center,
        width,
        envelope,
        offsets,
        connection,
        approaches: standalonePair ? [] : approaches,
        pair,
      })
      guards.push(...(standalonePair ? fixedApproaches : candidateGuards))
      accepted = true
    }
    if (!accepted) return null
  }
  const names = new Map(
    transforms.flatMap((t) =>
      t.pair.connectionNames.map((n) => [n, t.connection.name] as const),
    ),
  )
  const local: SimpleRouteJson = {
    ...input,
    // A wide corridor must retain enough room to reach both handoffs. The two
    // narrow rail guards alone leave gaps around their end caps that another
    // lane can enter while making the wide terminal unreachable.
    obstacles: [
      ...input.obstacles,
      ...transforms.flatMap((t) =>
        t.connection.pointsToConnect.map((p) => ({
          shape: "circle" as const,
          center: { x: p.x, y: p.y },
          width: t.envelope,
          height: t.envelope,
          layers: [p.layer],
          connectedTo: [t.connection.name, ...t.pair.connectionNames],
        })),
      ),
    ],
    connections: [
      ...input.connections.filter((c) => !names.has(c.name)),
      ...transforms.map((t) => t.connection),
      ...transforms.flatMap((t) => t.approaches),
    ],
    differentialPairs: [],
    traces: [...(input.traces ?? []), ...guards],
    buses: input.buses?.map((b) => {
      const members = [
        ...new Set(b.connectionNames.map((n) => names.get(n) ?? n)),
      ]
      return {
        ...b,
        connectionNames: [
          ...members,
          ...transforms
            .filter((t) => members.includes(t.connection.name))
            .flatMap((t) => t.approaches.map((c) => c.name)),
        ],
      }
    }),
  }
  return {
    input,
    local,
    transforms,
    layers,
    copper: fixedCopper(local),
    widths: new Map(
      local.connections.map((c) => [
        c.name,
        input.buses?.find((b) => b.connectionNames.includes(c.name))
          ?.traceWidth ??
          c.nominalTraceWidth ??
          c.width ??
          input.minTraceWidth,
      ]),
    ),
  }
}

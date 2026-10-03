import {
  getCopperLayerNames,
  routeLocalSignalDogbones,
  type LocalSignalDogboneOptions,
} from "@tscircuit/fanout-solver"
import { distance, length } from "./geometry"
import { GridVisibilitySearch } from "./grid-visibility"
import { ownedSignalEscapes } from "./repair-bus-dogbones"
import {
  clearanceToCopper,
  fixedCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"
import type {
  Connection,
  Obstacle,
  Point,
  SimpleRouteJson,
  Terminal,
  Trace,
  Via,
} from "./types"

interface Site {
  point: Terminal
  escape: Trace
  copper: Copper[]
}
interface Endpoint {
  connectionIndex: number
  pointIndex: number
  component: string
  sites: Site[]
}
const near = (a: Point, b: Point) => distance(a, b) < 1e-8

/** Enumerate a pad's adjacent legal sites through the public fanout API. Reject
 * one returned site at a time in a temporary scene. Keeping the original frame
 * avoids rotation roundoff changing equal-cost grid attachments. Rejection
 * obstacles are search constraints only; they never enter the returned board. */
export function localSignalSiteCandidates(
  input: SimpleRouteJson,
  connection: Connection,
  options: LocalSignalDogboneOptions,
): [Site[], Site[]] {
  const sites: [Site[], Site[]] = [[], []]
  const single = { ...input, connections: [connection] }
  for (let end = 0; end < 2; end++) {
    const rejected: Obstacle[] = []
    // A local rectangular pad grid has at most eight adjacent interstitial
    // sites (four axial and four diagonal).
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const generated = routeLocalSignalDogbones(
          {
            ...single,
            obstacles: [...single.obstacles, ...rejected],
          } as Parameters<typeof routeLocalSignalDogbones>[0],
          options,
        )
        const point = generated.connections[0].pointsToConnect[end] as Terminal
        if (sites[end].some((site) => near(site.point, point))) break
        const escape = ownedSignalEscapes(input, generated.traces).find(
          (trace) => near(trace.route[0], connection.pointsToConnect[end]),
        )
        if (!escape) break
        sites[end].push({
          point,
          escape,
          copper: fixedCopper({ ...input, obstacles: [], traces: [escape] }),
        })
        rejected.push({
          type: "rect",
          center: { x: point.x, y: point.y },
          width: 1e-6,
          height: 1e-6,
          layers: getCopperLayerNames(input.layerCount),
          connectedTo: [],
        })
      } catch {
        break
      }
    }
    sites[end].sort((a, b) => a.point.x - b.point.x || a.point.y - b.point.y)
  }
  return sites
}

/** Choose reachable local handoffs jointly. All sites and corridors are
 * computed from this request; supplied copper remains a hard obstacle. */
export function* reachableSignalDogbones(
  input: SimpleRouteJson,
  options: LocalSignalDogboneOptions,
  allowedLayers: ReadonlyMap<string, string[]>,
  nearestTerminalAttachments = false,
): Generator<void, { connections: Connection[]; traces: Trace[] } | null> {
  const endpoints: Endpoint[] = []
  const fixed = fixedCopper(input)
  for (const [connectionIndex, connection] of input.connections.entries()) {
    const sites = localSignalSiteCandidates(input, connection, options)
    if (sites.some((end) => !end.length)) return null
    let best: { cost: number; start: Point; end: Point } | undefined
    for (const layer of allowedLayers.get(connection.name) ?? []) {
      const supportsLayer = (site: Site) =>
        site.escape.route.some(
          (point) =>
            point.route_type === "via" && point.layers?.includes(layer),
        )
      const starts = sites[0]
        .filter(supportsLayer)
        .map((site) => ({ ...site.point, layer }))
      const ends = sites[1]
        .filter(supportsLayer)
        .map((site) => ({ ...site.point, layer }))
      if (!starts.length || !ends.length) continue
      const local = { ...connection, pointsToConnect: [starts[0], ends[0]] }
      const search = new GridVisibilitySearch(
        new VectorScene(input, local, options.traceWidth, fixed),
        starts[0],
        ends[0],
        [],
        0,
        undefined,
        { starts, ends, nearestTerminalAttachments },
      )
      try {
        let steps = 0
        while (!search.solved && !search.failed && steps++ < 4000) {
          search.step()
          yield
        }
        if (search.solved) {
          const cost = length(search.result)
          if (!best || cost < best.cost)
            best = { cost, start: search.result[0], end: search.result.at(-1)! }
        }
      } finally {
        search.cancel()
      }
    }
    if (!best) return null
    for (let pointIndex = 0; pointIndex < 2; pointIndex++) {
      const source = connection.pointsToConnect[pointIndex]
      const target = connection.pointsToConnect[1 - pointIndex]
      const preferred = pointIndex ? best.end : best.start
      const dx = target.x - source.x,
        dy = target.y - source.y
      const outwardRank = (point: Point) => {
        const displacement =
          Math.abs(dx) >= Math.abs(dy)
            ? Math.sign(dx) * (point.x - source.x)
            : Math.sign(dy) * (point.y - source.y)
        return displacement > 1e-9 ? 0 : Math.abs(displacement) <= 1e-9 ? 1 : 2
      }
      sites[pointIndex].sort((a, b) => {
        const difference = distance(source, a.point) - distance(source, b.point)
        return (
          Number(!near(a.point, preferred)) -
            Number(!near(b.point, preferred)) ||
          outwardRank(a.point) - outwardRank(b.point) ||
          (Math.abs(difference) < 1e-8 ? 0 : difference) ||
          a.point.x - b.point.x ||
          a.point.y - b.point.y
        )
      })
      const owners = [connection.name, source.pcb_port_id, source.pointId]
      const pad = input.obstacles
        .filter(
          (o) =>
            o.componentId &&
            o.connectedTo.some((owner) => owners.includes(owner)),
        )
        .sort(
          (a, b) => distance(a.center, source) - distance(b.center, source),
        )[0]
      if (!pad?.componentId) return null
      endpoints.push({
        connectionIndex,
        pointIndex,
        component: pad.componentId,
        sites: sites[pointIndex],
      })
    }
  }
  const assigned = new Map<Endpoint, Site>()
  const compatible = (a: Site, b: Site) => {
    if (
      a.copper.some((c) =>
        b.copper.some(
          (d) =>
            c.layer === d.layer &&
            clearanceToCopper(c.a, c.b, d) <
              c.radius + options.clearance - 1e-8,
        ),
      )
    )
      return false
    const first = a.escape.route.find((p): p is Via => p.route_type === "via")!
    const second = b.escape.route.find((p): p is Via => p.route_type === "via")!
    return (
      distance(first, second) >=
      options.viaHoleDiameter +
        (options.holeToHoleClearance ?? options.clearance) -
        1e-8
    )
  }
  let states = 0
  for (const component of new Set(endpoints.map((end) => end.component))) {
    const search = (remaining: Endpoint[]): boolean => {
      if (++states > 100000) return false
      if (!remaining.length) return true
      const domains = remaining
        .map((endpoint) => ({
          endpoint,
          sites: endpoint.sites.filter((site) =>
            [...assigned.values()].every((other) => compatible(site, other)),
          ),
        }))
        .sort(
          (a, b) =>
            a.sites.length - b.sites.length ||
            a.endpoint.connectionIndex - b.endpoint.connectionIndex ||
            a.endpoint.pointIndex - b.endpoint.pointIndex,
        )
      const { endpoint, sites } = domains[0]
      for (const site of sites) {
        assigned.set(endpoint, site)
        if (search(remaining.filter((end) => end !== endpoint))) return true
        assigned.delete(endpoint)
      }
      return false
    }
    if (!search(endpoints.filter((end) => end.component === component)))
      return null
    yield
  }
  const connections = structuredClone(input.connections)
  const traces: Trace[] = []
  for (const endpoint of endpoints) {
    const site = assigned.get(endpoint)!
    const connection = connections[endpoint.connectionIndex]
    connection.pointsToConnect[endpoint.pointIndex] = {
      ...site.point,
      layer: options.targetLayers.get(connection.name)!,
    }
    traces.push(site.escape)
  }
  return { connections, traces }
}

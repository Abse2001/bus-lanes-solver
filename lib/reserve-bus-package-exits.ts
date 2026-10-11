import { distance } from "./geometry"
import { packageApproachRegions } from "./package-approach-regions"
import type { Connection, SimpleRouteJson, Terminal } from "./types"
import type { Copper } from "./vector-scene"

/** Reserve one lane pitch per bus member outside exposed package terminals.
 * These provisional straight channels guide paired corridors only. They are
 * not output copper and do not prescribe an inter-package boundary route. */
export function reserveBusPackageExits(
  input: SimpleRouteJson,
  pair: NonNullable<SimpleRouteJson["differentialPairs"]>[number],
): Copper[] {
  const pairLayer = input.connections.find(
    (c) => c.name === pair.connectionNames[0],
  )!.pointsToConnect[0].layer
  const ownBus = input.buses?.find((bus) =>
    pair.connectionNames.some((name) => bus.connectionNames.includes(name)),
  )
  const related = ownBus
    ? [ownBus]
    : (input.buses ?? []).filter((bus) =>
        input.connections.some(
          (c) =>
            bus.connectionNames.includes(c.name) &&
            c.pointsToConnect[0].layer === pairLayer,
        ),
      )
  if (!related.length) return []
  const bus = related[0],
    names = new Set(related.flatMap((bus) => bus.connectionNames)),
    members = input.connections.filter((c) => names.has(c.name))
  const regions = packageApproachRegions(input, 0),
    width = bus.traceWidth ?? input.minTraceWidth
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const reserve = Math.max(0, members.length - 2) * (width + clearance)
  // A BGA edge can be much farther from its package center than from a nearby
  // bypass capacitor. Retain physical terminal ownership before considering
  // geometry; whole-net aliases alone may name pads on both packages.
  const pads = input.obstacles.filter((pad) => pad.componentId)
  const componentIds = [...new Set(pads.map((pad) => pad.componentId!))]
  const physicalPorts = new Map<string, string>()
  for (const pad of pads) {
    const port = (
      pad as typeof pad & {
        circuitJsonMetadata?: { pcb_port_id?: string }
      }
    ).circuitJsonMetadata?.pcb_port_id
    if (port) physicalPorts.set(port, pad.componentId!)
  }
  const ownedComponent = (connection: Connection, point: Terminal) => {
    const portOwner = point.pcb_port_id
      ? physicalPorts.get(point.pcb_port_id)
      : undefined
    if (portOwner) return portOwner
    const owners = new Set(
      [
        connection.name,
        connection.source_trace_id,
        point.pcb_port_id,
        point.pointId,
      ].filter((owner): owner is string => !!owner),
    )
    const connectedPads = pads.filter((pad) =>
      pad.connectedTo.some((owner) => owners.has(owner)),
    )
    // Generated carrier handoffs lose their native pcb_port_id. Recover the
    // package from the pad end of their owned, one-via local approach, even
    // when the handoff has become closer to the remote package.
    for (const trace of input.traces ?? []) {
      if (
        ![trace.connection_name, trace.source_trace_id].some(
          (owner) => owner && owners.has(owner),
        ) ||
        trace.route.filter((p) => p.route_type === "via").length !== 1 ||
        !trace.route.length ||
        distance(trace.route.at(-1)!, point) > 1e-8
      )
        continue
      const start = trace.route[0]
      if (start.route_type !== "wire") continue
      const startPort = (start as typeof start & { pcb_port_id?: string })
        .pcb_port_id
      const startOwner = startPort ? physicalPorts.get(startPort) : undefined
      if (startOwner) return startOwner
      const pad = connectedPads.find(
        (pad) =>
          pad.layers.includes(start.layer) &&
          distance(pad.center, start) < 1e-4,
      )
      if (pad) return pad.componentId
    }
    return connectedPads.sort(
      (a, b) => distance(point, a.center) - distance(point, b.center),
    )[0]?.componentId
  }
  type Face = {
    point: Terminal
    name: string
    edge: { side: string; d: number; x: number; y: number }
  }
  const faces = new Map<string, Face[]>()
  for (const connection of members)
    for (const point of connection.pointsToConnect) {
      const owner = ownedComponent(connection, point)
      const ownerIndex = owner ? componentIds.indexOf(owner) : -1
      const candidates = regions.map((region, index) => ({
        box: region.pads,
        index,
        distance: Math.hypot(
          point.x - (region.pads.minX + region.pads.maxX) / 2,
          point.y - (region.pads.minY + region.pads.maxY) / 2,
        ),
      }))
      const region =
        candidates.find((candidate) => candidate.index === ownerIndex) ??
        candidates.sort((a, b) => a.distance - b.distance)[0]
      if (!region) continue
      const { box } = region
      const edge = [
        { side: "left", d: point.x - box.minX, x: -1, y: 0 },
        { side: "right", d: box.maxX - point.x, x: 1, y: 0 },
        { side: "bottom", d: point.y - box.minY, x: 0, y: -1 },
        { side: "top", d: box.maxY - point.y, x: 0, y: 1 },
      ].sort((a, b) => a.d - b.d)[0]
      const key = `${region.index}:${edge.side}:${point.layer}`
      let face = faces.get(key)
      if (!face) {
        face = []
        faces.set(key, face)
      }
      face.push({ point, edge, name: connection.name })
    }
  const reservations: Copper[] = []
  for (const face of faces.values()) {
    const nearest = Math.min(...face.map((member) => member.edge.d))
    for (const { point, edge, name } of face) {
      if (pair.connectionNames.includes(name) || edge.d > nearest + width / 2)
        continue
      reservations.push({
        a: point,
        b: { x: point.x + edge.x * reserve, y: point.y + edge.y * reserve },
        radius: width / 2,
        layer: point.layer,
        owners: [name],
      })
    }
  }
  return reservations
}

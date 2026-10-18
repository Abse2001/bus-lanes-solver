import { packageApproachRegions } from "./package-approach-regions"
import type { Copper } from "./vector-scene"
import type { Point, SimpleRouteJson } from "./types"
import { distance } from "./geometry"

/** Reserve one lane pitch per same-layer exit on each exposed package face.
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
    members = input.connections.filter(
      (c) => names.has(c.name) && c.pointsToConnect[0].layer === pairLayer,
    )
  if (!members.length) return []
  const regions = packageApproachRegions(input, 0),
    width = bus.traceWidth ?? input.minTraceWidth
  // packageApproachRegions retains component insertion order. Native pad
  // ownership identifies the BGA even when a nearby support part has a closer
  // center than the package. Generated handoffs retain the connection owner.
  const componentIndexes = new Map(
    [
      ...new Set(
        input.obstacles.flatMap((pad) =>
          pad.componentId ? [pad.componentId] : [],
        ),
      ),
    ].map((id, index) => [id, index]),
  )
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  type Face = {
    point: Point
    name: string
    edge: { side: string; d: number; x: number; y: number }
  }
  const faces = new Map<string, Face[]>()
  for (const connection of members)
    for (const point of connection.pointsToConnect) {
      const owners = [
        connection.name,
        connection.source_trace_id,
        point.pcb_port_id,
        point.pointId,
      ]
      const pad = input.obstacles
        .filter(
          (pad) =>
            pad.componentId &&
            pad.connectedTo.some((owner) => owners.includes(owner)),
        )
        .sort(
          (a, b) => distance(a.center, point) - distance(b.center, point),
        )[0]
      const ownerIndex = pad?.componentId
        ? componentIndexes.get(pad.componentId)
        : undefined
      const candidates = regions
        .map((region, index) => ({
          box: region.pads,
          index,
          distance: Math.hypot(
            point.x - (region.pads.minX + region.pads.maxX) / 2,
            point.y - (region.pads.minY + region.pads.maxY) / 2,
          ),
        }))
        .sort((a, b) => a.distance - b.distance)
      const region =
        candidates.find((region) => region.index === ownerIndex) ??
        candidates[0]
      if (!region) continue
      const { box } = region
      const edge = [
        { side: "left", d: point.x - box.minX, x: -1, y: 0 },
        { side: "right", d: box.maxX - point.x, x: 1, y: 0 },
        { side: "bottom", d: point.y - box.minY, x: 0, y: -1 },
        { side: "top", d: box.maxY - point.y, x: 0, y: 1 },
      ].sort((a, b) => a.d - b.d)[0]
      const key = `${region.index}:${edge.side}`
      let face = faces.get(key)
      if (!face) faces.set(key, (face = []))
      face.push({ point, edge, name: connection.name })
    }
  const reservations: Copper[] = []
  for (const face of faces.values()) {
    // Other package faces and other signal planes do not compete for this
    // face's perpendicular escape space. Standalone pairs may not belong to
    // the bus, so count the actual ordinary exits rather than subtracting two.
    const reserve =
      face.filter((member) => !pair.connectionNames.includes(member.name))
        .length *
      (width + clearance)
    const nearest = Math.min(...face.map((member) => member.edge.d))
    for (const { point, edge, name } of face) {
      if (pair.connectionNames.includes(name) || edge.d > nearest + width / 2)
        continue
      reservations.push({
        a: point,
        b: { x: point.x + edge.x * reserve, y: point.y + edge.y * reserve },
        radius: width / 2,
        layer: pairLayer,
        owners: [name],
      })
    }
  }
  return reservations
}

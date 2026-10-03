import { packageApproachRegions } from "./package-approach-regions"
import type { Copper } from "./vector-scene"
import type { Point, SimpleRouteJson } from "./types"

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
    layer = members[0].pointsToConnect[0].layer,
    width = bus.traceWidth ?? input.minTraceWidth
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const reserve = Math.max(0, members.length - 2) * (width + clearance)
  type Face = {
    point: Point
    name: string
    edge: { side: string; d: number; x: number; y: number }
  }
  const faces = new Map<string, Face[]>()
  for (const connection of members)
    for (const point of connection.pointsToConnect) {
      const region = regions
        .map((region, index) => ({
          box: region.pads,
          index,
          distance: Math.hypot(
            point.x - (region.pads.minX + region.pads.maxX) / 2,
            point.y - (region.pads.minY + region.pads.maxY) / 2,
          ),
        }))
        .sort((a, b) => a.distance - b.distance)[0]
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
    const nearest = Math.min(...face.map((member) => member.edge.d))
    for (const { point, edge, name } of face) {
      if (pair.connectionNames.includes(name) || edge.d > nearest + width / 2)
        continue
      reservations.push({
        a: point,
        b: { x: point.x + edge.x * reserve, y: point.y + edge.y * reserve },
        radius: width / 2,
        layer,
        owners: [name],
      })
    }
  }
  return reservations
}

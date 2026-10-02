import { distance } from "./geometry"
import type { Point, SimpleRouteJson } from "./types"

type Box = SimpleRouteJson["bounds"]
export const pointInBox = (p: Point, box: Box) =>
  p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY

/** Native package pad fields and the local via copper surrounding them. A
 * routed trunk must not enlarge a package's permitted uncoupled region. */
export function packageApproachRegions(input: SimpleRouteJson, margin: number) {
  const pads = input.obstacles.filter((o) => o.componentId)
  const regions = new Map<string, { pads: Box; copper: Box }>()
  const include = (box: Box, p: Point, x: number, y = x) => {
    box.minX = Math.min(box.minX, p.x - x)
    box.maxX = Math.max(box.maxX, p.x + x)
    box.minY = Math.min(box.minY, p.y - y)
    box.maxY = Math.max(box.maxY, p.y + y)
  }
  for (const pad of pads) {
    let region = regions.get(pad.componentId!)
    if (!region) {
      const box = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
      }
      region = { pads: box, copper: { ...box } }
      regions.set(pad.componentId!, region)
    }
    const angle = ((pad.ccwRotationDegrees ?? 0) * Math.PI) / 180
    include(
      region.pads,
      pad.center,
      (Math.abs(Math.cos(angle)) * pad.width +
        Math.abs(Math.sin(angle)) * pad.height) /
        2,
      (Math.abs(Math.sin(angle)) * pad.width +
        Math.abs(Math.cos(angle)) * pad.height) /
        2,
    )
  }
  for (const region of regions.values()) region.copper = { ...region.pads }
  for (const trace of input.traces ?? []) {
    // Local dogbones have one via and start at a native package pad. Existing
    // interconnects, and handoffs without native pad ownership, add no region.
    const vias = trace.route.filter((p) => p.route_type === "via")
    if (vias.length !== 1 || !trace.route.length) continue
    const first = trace.route[0]
    const owner = pads.find((p) => distance(p.center, first) < 1e-4)
    if (!owner) continue
    const region = regions.get(owner.componentId!)!
    const via = vias[0]
    const radius = (via.via_diameter ?? input.minViaPadDiameter ?? 0.6) / 2
    const angle = ((owner.ccwRotationDegrees ?? 0) * Math.PI) / 180
    const clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
    const reachX =
      (Math.abs(Math.cos(angle)) * owner.width +
        Math.abs(Math.sin(angle)) * owner.height) /
        2 +
      radius +
      clearance
    const reachY =
      (Math.abs(Math.sin(angle)) * owner.width +
        Math.abs(Math.cos(angle)) * owner.height) /
        2 +
      radius +
      clearance
    if (
      Math.abs(via.x - first.x) > reachX + 1e-4 ||
      Math.abs(via.y - first.y) > reachY + 1e-4
    )
      continue
    include(
      region.copper,
      via,
      (via.via_diameter ?? input.minViaPadDiameter ?? 0.6) / 2,
    )
  }
  for (const region of regions.values()) {
    region.copper.minX -= margin
    region.copper.maxX += margin
    region.copper.minY -= margin
    region.copper.maxY += margin
  }
  return [...regions.values()]
}

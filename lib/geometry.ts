import type { Point } from "./types"
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export function pointSegmentDistance(p: Point, edge: [Point, Point]) {
  const [a, b] = edge,
    dx = b.x - a.x,
    dy = b.y - a.y,
    t = Math.max(
      0,
      Math.min(
        1,
        ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
      ),
    )
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
export function segmentDistance(ab: [Point, Point], cd: [Point, Point]) {
  const [a, b] = ab,
    [c, d] = cd
  if (
    Math.max(a.x, b.x) >= Math.min(c.x, d.x) &&
    Math.max(c.x, d.x) >= Math.min(a.x, b.x) &&
    Math.max(a.y, b.y) >= Math.min(c.y, d.y) &&
    Math.max(c.y, d.y) >= Math.min(a.y, b.y) &&
    cross(a, b, c) * cross(a, b, d) <= 0 &&
    cross(c, d, a) * cross(c, d, b) <= 0
  )
    return 0
  return Math.min(
    pointSegmentDistance(a, cd),
    pointSegmentDistance(b, cd),
    pointSegmentDistance(c, ab),
    pointSegmentDistance(d, ab),
  )
}
export const length = (path: Point[]) =>
  path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0)
export function simplify(path: Point[]) {
  const result: Point[] = []
  for (const [index, point] of path.entries()) {
    if (result.length && distance(result.at(-1)!, point) < 1e-12) {
      if (index === path.length - 1) result[result.length - 1] = point
      continue
    }
    while (result.length > 1) {
      const a = result[result.length - 2],
        b = result.at(-1)!
      const ux = b.x - a.x,
        uy = b.y - a.y
      const vx = point.x - b.x,
        vy = point.y - b.y
      const scale = Math.hypot(ux, uy) * Math.hypot(vx, vy)
      // Absolute triangle area erases real corners on tiny pad/grid
      // connectors. Compare directions and retain returning segments.
      if (
        ux * vx + uy * vy <= 0 ||
        Math.abs(ux * vy - uy * vx) > scale * 1e-8 ||
        pointSegmentDistance(b, [a, point]) > 1e-10
      )
        break
      result.pop()
    }
    result.push(point)
  }
  return result
}

import type { Point } from "./types"
import type { Copper } from "./vector-scene"

type Box = { minX: number; maxX: number; minY: number; maxY: number }
type Entry = Box & { copper: Copper }
type Node = Box & { entries?: Entry[]; left?: Node; right?: Node }

/** Conservative BVH over immutable scene copper. Queries only remove distant
 * candidates; the caller still applies its exact clearance predicate. */
export class CopperIndex {
  private root: Node | undefined
  constructor(copper: Copper[]) {
    const build = (entries: Entry[]): Node => {
      const box = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
      }
      for (const e of entries) {
        box.minX = Math.min(box.minX, e.minX)
        box.maxX = Math.max(box.maxX, e.maxX)
        box.minY = Math.min(box.minY, e.minY)
        box.maxY = Math.max(box.maxY, e.maxY)
      }
      if (entries.length <= 8) return { ...box, entries }
      const x = box.maxX - box.minX >= box.maxY - box.minY
      entries.sort((a, b) =>
        x
          ? a.minX + a.maxX - (b.minX + b.maxX)
          : a.minY + a.maxY - (b.minY + b.maxY),
      )
      const mid = entries.length >> 1
      return {
        ...box,
        left: build(entries.slice(0, mid)),
        right: build(entries.slice(mid)),
      }
    }
    if (copper.length)
      this.root = build(
        copper.map((c) => ({
          copper: c,
          ...(c.rect ?? {
            minX: Math.min(c.a.x, c.b.x) - c.radius,
            maxX: Math.max(c.a.x, c.b.x) + c.radius,
            minY: Math.min(c.a.y, c.b.y) - c.radius,
            maxY: Math.max(c.a.y, c.b.y) + c.radius,
          }),
        })),
      )
  }
  /** Exact nearest-copper distance using bounding boxes only to prune. A
   * point inside a box has no useful signed-distance lower bound. queryRadius
   * expands the queried point when the predicate subtracts its radius too. */
  distanceToPoint(
    point: Point,
    distanceOf: (copper: Copper) => number,
    queryRadius = 0,
  ): number {
    let nearest = Infinity
    const lowerBound = (box: Box) => {
      const dx = Math.max(box.minX - point.x, 0, point.x - box.maxX)
      const dy = Math.max(box.minY - point.y, 0, point.y - box.maxY)
      return dx || dy ? Math.hypot(dx, dy) - queryRadius : -Infinity
    }
    const visit = (node: Node, bound: number) => {
      if (bound >= nearest) return
      if (node.entries) {
        for (const entry of node.entries)
          if (lowerBound(entry) < nearest)
            nearest = Math.min(nearest, distanceOf(entry.copper))
        return
      }
      const left = lowerBound(node.left!),
        right = lowerBound(node.right!)
      if (left <= right) {
        visit(node.left!, left)
        visit(node.right!, right)
      } else {
        visit(node.right!, right)
        visit(node.left!, left)
      }
    }
    if (this.root) visit(this.root, lowerBound(this.root))
    return nearest
  }
  some(box: Box, predicate: (c: Copper) => boolean): boolean {
    const visit = (node: Node): boolean => {
      if (
        node.minX > box.maxX ||
        node.maxX < box.minX ||
        node.minY > box.maxY ||
        node.maxY < box.minY
      )
        return false
      if (node.entries) {
        for (const e of node.entries) {
          if (
            e.minX > box.maxX ||
            e.maxX < box.minX ||
            e.minY > box.maxY ||
            e.maxY < box.minY
          )
            continue
          if (predicate(e.copper)) return true
        }
        return false
      }
      return visit(node.left!) || visit(node.right!)
    }
    return this.root ? visit(this.root) : false
  }
}

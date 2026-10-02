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
    const entries: Entry[] = copper.map((c) => ({
      copper: c,
      ...(c.rect ?? {
        minX: Math.min(c.a.x, c.b.x) - c.radius,
        maxX: Math.max(c.a.x, c.b.x) + c.radius,
        minY: Math.min(c.a.y, c.b.y) - c.radius,
        maxY: Math.max(c.a.y, c.b.y) + c.radius,
      }),
    }))
    const swap = (a: number, b: number) => {
      const value = entries[a]
      entries[a] = entries[b]
      entries[b] = value
    }
    // Only a median partition is needed. Sorting every subtree costs
    // O(n log² n) and copies the dense sampled meanders repeatedly.
    const partition = (
      start: number,
      end: number,
      middle: number,
      x: boolean,
    ) => {
      const key = (entry: Entry) =>
        x ? entry.minX + entry.maxX : entry.minY + entry.maxY
      while (end - start > 1) {
        const a = key(entries[start]),
          b = key(entries[(start + end) >> 1]),
          c = key(entries[end - 1])
        const pivot =
          a < b ? (b < c ? b : Math.max(a, c)) : a < c ? a : Math.max(b, c)
        let lower = start,
          upper = end,
          i = start
        // Three-way partition avoids repeated work for coincident BGA columns.
        while (i < upper) {
          const value = key(entries[i])
          if (value < pivot) swap(lower++, i++)
          else if (value > pivot) swap(i, --upper)
          else i++
        }
        if (middle < lower) end = lower
        else if (middle >= upper) start = upper
        else return
      }
    }
    const build = (start: number, end: number): Node => {
      const box = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
      }
      for (let i = start; i < end; i++) {
        const e = entries[i]
        box.minX = Math.min(box.minX, e.minX)
        box.maxX = Math.max(box.maxX, e.maxX)
        box.minY = Math.min(box.minY, e.minY)
        box.maxY = Math.max(box.maxY, e.maxY)
      }
      if (end - start <= 8)
        return { ...box, entries: entries.slice(start, end) }
      const x = box.maxX - box.minX >= box.maxY - box.minY
      const middle = (start + end) >> 1
      partition(start, end, middle, x)
      return { ...box, left: build(start, middle), right: build(middle, end) }
    }
    if (entries.length) this.root = build(0, entries.length)
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

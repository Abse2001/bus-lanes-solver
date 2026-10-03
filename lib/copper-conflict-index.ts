import { clearanceToCopper, type Copper } from "./vector-scene"

interface Geometry {
  copper: Copper[]
  bounds: Float64Array
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** Request-local broad phase for immutable site/carrier candidates. Preserve
 * nested-loop order: the first conflicting chord determines routing history. */
export class CopperConflictIndex {
  private geometry = new WeakMap<Copper[], Geometry>()
  private prepare(copper: Copper[]): Geometry {
    const cached = this.geometry.get(copper)
    if (cached) return cached
    const bounds = new Float64Array(copper.length * 4)
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity
    for (let i = 0; i < copper.length; i++) {
      const c = copper[i],
        k = i * 4
      bounds[k] = Math.min(c.a.x, c.b.x) - c.radius
      bounds[k + 1] = Math.max(c.a.x, c.b.x) + c.radius
      bounds[k + 2] = Math.min(c.a.y, c.b.y) - c.radius
      bounds[k + 3] = Math.max(c.a.y, c.b.y) + c.radius
      // Rectangles participate as targets in clearanceToCopper. Include their
      // full bounds even when their stored centerline is a point.
      if (c.rect) {
        bounds[k] = Math.min(bounds[k], c.rect.minX)
        bounds[k + 1] = Math.max(bounds[k + 1], c.rect.maxX)
        bounds[k + 2] = Math.min(bounds[k + 2], c.rect.minY)
        bounds[k + 3] = Math.max(bounds[k + 3], c.rect.maxY)
      }
      minX = Math.min(minX, bounds[k])
      maxX = Math.max(maxX, bounds[k + 1])
      minY = Math.min(minY, bounds[k + 2])
      maxY = Math.max(maxY, bounds[k + 3])
    }
    const geometry = { copper, bounds, minX, maxX, minY, maxY }
    this.geometry.set(copper, geometry)
    return geometry
  }
  firstConflict(
    first: Copper[],
    second: Copper[],
    clearance: number,
  ): [Copper, Copper] | undefined {
    const a = this.prepare(first),
      b = this.prepare(second)
    if (
      a.maxX + clearance < b.minX ||
      b.maxX + clearance < a.minX ||
      a.maxY + clearance < b.minY ||
      b.maxY + clearance < a.minY
    )
      return
    for (let i = 0; i < first.length; i++) {
      const c = first[i],
        ai = i * 4
      for (let j = 0; j < second.length; j++) {
        const d = second[j],
          bj = j * 4
        if (
          c.layer !== d.layer ||
          a.bounds[ai + 1] + clearance < b.bounds[bj] ||
          b.bounds[bj + 1] + clearance < a.bounds[ai] ||
          a.bounds[ai + 3] + clearance < b.bounds[bj + 2] ||
          b.bounds[bj + 3] + clearance < a.bounds[ai + 2]
        )
          continue
        if (clearanceToCopper(c.a, c.b, d) < c.radius + clearance) return [c, d]
      }
    }
  }
}

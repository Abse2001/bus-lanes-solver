import type { CompactionVertex } from "./compaction-motion-groups"
import type { Point } from "./types"

export interface CompactionCut {
  a: CompactionVertex
  b: CompactionVertex
  n: Point
  min: number
}
type Corner = Point & { cut?: CompactionCut }

/** All collision inequalities for two translation groups constrain the same
 * two-dimensional relative displacement. Only the boundary of their feasible
 * polygon needs rows in the dense simplex tableau. Keep every cut if clipping
 * degenerates, so numerical ambiguity cannot silently discard constraints. */
export class CompactionCutSet {
  private pairs = new Map<
    string,
    { polygon: Corner[]; cuts: CompactionCut[] }
  >()
  constructor(private motion: number) {}

  add(cut: CompactionCut) {
    const { a, b, n, min } = cut
    if (a.group === b.group) return
    let aa = a.group ?? -1,
      bb = b.group ?? -1,
      normal = n
    if (aa > bb) {
      ;[aa, bb] = [bb, aa]
      normal = { x: -n.x, y: -n.y }
    }
    const key = `${aa}:${bb}`,
      limit = aa === -1 ? this.motion : this.motion * 2
    const pair = this.pairs.get(key) ?? {
      polygon: [
        { x: -limit, y: -limit },
        { x: limit, y: -limit },
        { x: limit, y: limit },
        { x: -limit, y: limit },
      ],
      cuts: [],
    }
    const next: Corner[] = [],
      polygon = pair.polygon
    for (let i = 0; i < polygon.length; i++) {
      const prev = polygon[(i + polygon.length - 1) % polygon.length],
        cur = polygon[i],
        p = prev.x * normal.x + prev.y * normal.y - min,
        c = cur.x * normal.x + cur.y * normal.y - min
      if (p < 0 !== c < 0) {
        const t = p / (p - c)
        next.push({
          x: prev.x + (cur.x - prev.x) * t,
          y: prev.y + (cur.y - prev.y) * t,
          cut: p >= 0 ? cur.cut : cut,
        })
      }
      if (c >= 0) next.push(cur)
    }
    // A cut through an existing corner emits that corner twice. In a narrow
    // or degenerate intersection, zero-length edges needlessly enlarge later
    // clips. Keep the incoming edge of the first copy.
    const compact: Corner[] = []
    const same = (a: Point, b: Point) =>
      Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12
    for (const corner of next)
      if (!compact.length || !same(compact.at(-1)!, corner))
        compact.push(corner)
    if (compact.length > 1 && same(compact[0], compact.at(-1)!)) {
      compact[0] = { ...compact[0], cut: compact.at(-1)!.cut }
      compact.pop()
    }
    pair.polygon = compact
    pair.cuts.push(cut)
    this.pairs.set(key, pair)
  }

  *active(): Generator<CompactionCut> {
    for (const { polygon, cuts } of this.pairs.values()) {
      const twiceArea = polygon.reduce((sum, p, i) => {
        const q = polygon[(i + 1) % polygon.length]
        return sum + p.x * q.y - p.y * q.x
      }, 0)
      if (Math.abs(twiceArea) < 1e-12) {
        yield* cuts
      } else {
        yield* new Set(
          polygon.map((p) => p.cut).filter((c): c is CompactionCut => !!c),
        )
      }
    }
  }
}

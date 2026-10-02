import { distance } from "./geometry"
import type { Point } from "./types"

/** A rounded raster serpentine inside one pocket. A reserved entry column
 * keeps the horizontal folds clear of their own approach. All rails are
 * normal offsets of the same tangent-continuous centerline. */
export function foldedPairedLobes(
  a: Point,
  b: Point,
  spacing: number,
  deficit: number,
  folds: number,
  side: number,
  minRadius: number,
): [Point[], Point[]] | null {
  const span = distance(a, b),
    radius = minRadius + spacing / 2
  if (
    !Number.isFinite(span + spacing + deficit + minRadius) ||
    spacing < 0 ||
    (side !== 1 && side !== -1) ||
    minRadius <= 0 ||
    deficit <= 0 ||
    !Number.isInteger(folds) ||
    folds < 1 ||
    folds > 64 ||
    span < 6 * radius
  )
    return null
  const height = (4 * folds + 2) * radius
  const ux = (b.x - a.x) / span,
    uy = (b.y - a.y) / span
  const generate = (reach: number): [Point[], Point[]] => {
    const vertices = [
      { x: 0, y: 0 },
      { x: radius, y: 0 },
      { x: radius, y: height },
      { x: reach, y: height },
    ]
    for (let i = 1; i <= 2 * folds; i++) {
      const x = i % 2 ? 3 * radius : reach
      const y = height - 2 * radius * i
      vertices.push({ x: vertices.at(-1)!.x, y }, { x, y })
    }
    vertices.push({ x: reach, y: 0 }, { x: span, y: 0 })
    const rails: [Point[], Point[]] = [[], []]
    const emit = (x: number, y: number, tx: number, ty: number) => {
      for (let k = 0; k < (spacing ? 2 : 1); k++) {
        const offset = ((k === 0 ? 1 : -1) * spacing) / 2
        const px = x - side * ty * offset,
          py = side * y + tx * offset
        const p = { x: a.x + ux * px - uy * py, y: a.y + uy * px + ux * py }
        if (!rails[k].length || distance(rails[k].at(-1)!, p) > 1e-10)
          rails[k].push(p)
      }
    }
    emit(0, 0, 1, 0)
    for (let i = 1; i < vertices.length - 1; i++) {
      const p = vertices[i - 1],
        q = vertices[i],
        s = vertices[i + 1]
      const d1 = distance(p, q),
        d2 = distance(q, s)
      const u = { x: (q.x - p.x) / d1, y: (q.y - p.y) / d1 },
        v = { x: (s.x - q.x) / d2, y: (s.y - q.y) / d2 }
      const start = { x: q.x - u.x * radius, y: q.y - u.y * radius }
      const center = { x: start.x + v.x * radius, y: start.y + v.y * radius }
      const turn = u.x * v.y - u.y * v.x
      const angle = Math.atan2(start.y - center.y, start.x - center.x)
      for (let j = 0; j <= 18; j++) {
        const theta = angle + (((turn * Math.PI) / 2) * j) / 18
        emit(
          center.x + radius * Math.cos(theta),
          center.y + radius * Math.sin(theta),
          -turn * Math.sin(theta),
          turn * Math.cos(theta),
        )
      }
    }
    emit(span, 0, 1, 0)
    if (!spacing) rails[1] = rails[0]
    return rails
  }
  const minimumReach = 5 * radius,
    maximumReach = span - radius
  // Each of 4(folds + 1) quarter-arcs replaces two radius-long legs.
  // Use the emitted 18-chord length, not ideal pi*r/2. The remaining
  // correction is affine in reach (2*folds), so reject/solve in O(1)
  // before allocating curve points. Signed turns sum to zero, giving both
  // offset rails the same added length.
  const arcCorrection =
    4 * (folds + 1) * radius * (36 * Math.sin(Math.PI / 72) - 2)
  const addition = 2 * height + 4 * folds * radius + arcCorrection
  if (addition > deficit + 1e-8) return null
  const reach = minimumReach + (deficit - addition) / (2 * folds)
  if (reach > maximumReach + 1e-8) return null
  return generate(Math.min(reach, maximumReach))
}
export function foldedTuningLobes(
  a: Point,
  b: Point,
  deficit: number,
  folds: number,
  side: number,
  minRadius: number,
): Point[] | null {
  return (
    foldedPairedLobes(a, b, 0, deficit, folds, side, minRadius)?.[0] ?? null
  )
}

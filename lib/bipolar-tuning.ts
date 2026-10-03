import { distance, length } from "./geometry"
import type { Point } from "./types"
/** Balanced rounded serpentine. Both rails are offsets of one centerline. */
export function bipolarPairedLobes(
  a: Point,
  b: Point,
  spacing: number,
  deficit: number,
  lobes: number,
  side: number,
  minRadius: number,
): [Point[], Point[]] | null {
  const span = distance(a, b),
    radius = minRadius + spacing / 2,
    posts = 2 * lobes + 1
  if (
    !Number.isFinite(span + spacing + deficit + minRadius) ||
    spacing < 0 ||
    deficit <= 0 ||
    minRadius <= 0 ||
    !Number.isInteger(lobes) ||
    lobes < 1 ||
    lobes > 64 ||
    (side !== 1 && side !== -1) ||
    span < (4 * lobes + 2) * radius - 1e-9
  )
    return null
  const ux = (b.x - a.x) / span,
    uy = (b.y - a.y) / span
  const generate = (height: number): [Point[], Point[]] => {
    const vertices = [{ x: 0, y: 0 }]
    let y = 0
    for (let j = 0; j < posts; j++) {
      const x = radius + ((span - 2 * radius) * j) / (posts - 1)
      vertices.push({ x, y })
      y = j === posts - 1 ? 0 : j % 2 ? -height : height
      vertices.push({ x, y })
    }
    vertices.push({ x: span, y: 0 })
    const rails: [Point[], Point[]] = [[], []]
    const emit = (x: number, y: number, tx: number, ty: number) => {
      for (let k = 0; k < 2; k++) {
        const offset = ((k === 0 ? 1 : -1) * spacing) / 2,
          px = x - side * ty * offset,
          py = side * y + tx * offset,
          p = { x: a.x + ux * px - uy * py, y: a.y + uy * px + ux * py }
        if (!rails[k].length || distance(rails[k].at(-1)!, p) > 1e-10)
          rails[k].push(p)
      }
    }
    emit(0, 0, 1, 0)
    for (let i = 1; i < vertices.length - 1; i++) {
      const p = vertices[i - 1],
        q = vertices[i],
        s = vertices[i + 1],
        d1 = distance(p, q),
        d2 = distance(q, s),
        u = { x: (q.x - p.x) / d1, y: (q.y - p.y) / d1 },
        v = { x: (s.x - q.x) / d2, y: (s.y - q.y) / d2 },
        start = { x: q.x - u.x * radius, y: q.y - u.y * radius },
        center = { x: start.x + v.x * radius, y: start.y + v.y * radius },
        turn = u.x * v.y - u.y * v.x,
        angle = Math.atan2(start.y - center.y, start.x - center.x)
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
    return rails
  }
  const correction =
      (4 * lobes + 2) * radius * (36 * Math.sin(Math.PI / 72) - 2),
    minHeight = 2 * radius,
    minAddition = 4 * lobes * minHeight + correction
  if (minAddition > deficit + 1e-8) return null
  let height = Math.max(minHeight, (deficit - correction) / (4 * lobes))
  let rails = generate(height)
  height = Math.max(
    minHeight,
    height +
      (deficit - Math.min(...rails.map((r) => length(r) - span))) / (4 * lobes),
  )
  return generate(height)
}

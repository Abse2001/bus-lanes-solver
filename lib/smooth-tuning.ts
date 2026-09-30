import { distance, length } from "./geometry"
import type { Point } from "./types"

/** Tangent-continuous raised-cosine lobes, sampled in board-world mm (+X right,
 * +Y up). Amplitude is solved against emitted chord length, not ideal arc length. */
export function smoothTuningLobes(
  a: Point,
  b: Point,
  deficit: number,
  lobes: number,
  side: number,
  minRadius: number,
): Point[] | null {
  const span = distance(a, b),
    period = span / lobes
  if (span <= 0 || deficit <= 0 || lobes < 1) return null
  const ux = (b.x - a.x) / span,
    uy = (b.y - a.y) / span
  const maxHeight = (period * period) / (2 * Math.PI * Math.PI * minRadius)
  const generate = (height: number) => {
    const samples = Math.max(
      48,
      Math.ceil(period / Math.max(0.005, minRadius / 6)),
    )
    const points: Point[] = []
    for (let l = 0; l < lobes; l++)
      for (let j = 0; j < samples; j++) {
        const x = period * (l + j / samples),
          y = (side * height * (1 - Math.cos((2 * Math.PI * j) / samples))) / 2
        points.push({ x: a.x + ux * x - uy * y, y: a.y + uy * x + ux * y })
      }
    points.push(b)
    return points
  }
  let lo = 0,
    hi = Math.min(maxHeight, deficit + span)
  if (length(generate(hi)) - span < deficit) return null
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (length(generate(mid)) - span < deficit) lo = mid
    else hi = mid
  }
  return generate((lo + hi) / 2)
}

/** Two normal-offset rails of one smooth centerline. Radius is bounded for the
 * inside rail as well as the centerline; terminal tangents remain unchanged. */
export function smoothPairedLobes(
  a: Point,
  b: Point,
  spacing: number,
  deficit: number,
  lobes: number,
  side: number,
  minRadius: number,
): [Point[], Point[]] | null {
  const span = distance(a, b),
    period = span / lobes
  if (span <= 0 || deficit <= 0) return null
  const ux = (b.x - a.x) / span,
    uy = (b.y - a.y) / span
  const maxHeight =
    (period * period) / (2 * Math.PI * Math.PI * (minRadius + spacing / 2))
  const generate = (height: number): [Point[], Point[]] => {
    const samples = Math.max(
      64,
      Math.ceil(period / Math.max(0.005, minRadius / 6)),
    )
    const rails: [Point[], Point[]] = [[], []]
    for (let k = 0; k <= samples * lobes; k++) {
      const x = (k * span) / (samples * lobes),
        phase = (2 * Math.PI * k) / samples
      const y = (side * height * (1 - Math.cos(phase))) / 2,
        slope = ((side * height * Math.PI) / period) * Math.sin(phase)
      const norm = Math.hypot(1, slope)
      for (let i = 0; i < 2; i++) {
        const offset = ((i === 0 ? 1 : -1) * spacing) / 2
        const lx = x - (offset * slope) / norm,
          ly = y + offset / norm
        rails[i].push({
          x: a.x + ux * lx - uy * ly,
          y: a.y + uy * lx + ux * ly,
        })
      }
    }
    return rails
  }
  const addition = (height: number) =>
    Math.min(...generate(height).map((r) => length(r) - span))
  let lo = 0,
    hi = Math.min(maxHeight, deficit + span)
  if (addition(hi) < deficit) return null
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (addition(mid) < deficit) lo = mid
    else hi = mid
  }
  return generate((lo + hi) / 2)
}

/** Rounded serpentine cells from the reference's compact-bays/tune-bays.py.
 * Four tangent quarter-arcs leave straight sides whose height can grow without
 * shrinking the bend radius. This fits more length in a narrow tuning bank
 * than increasing the amplitude of a raised cosine. */
export function roundedPairedLobes(
  a: Point,
  b: Point,
  spacing: number,
  deficit: number,
  lobes: number,
  side: number,
  minRadius: number,
): [Point[], Point[]] | null {
  const span = distance(a, b),
    period = span / lobes,
    radius = minRadius + spacing / 2
  if (deficit <= 0 || lobes < 1 || period < 4 * radius) return null
  const ux = (b.x - a.x) / span,
    uy = (b.y - a.y) / span
  const generate = (height: number): [Point[], Point[]] => {
    const rails: [Point[], Point[]] = [[], []]
    const samples = Math.max(
      18,
      Math.ceil((Math.PI * radius) / (2 * Math.max(0.005, minRadius / 6))),
    )
    for (let l = 0; l < lobes; l++)
      for (const [cx, cy, start, end] of [
        [0, radius, -Math.PI / 2, 0],
        [2 * radius, height - radius, Math.PI, Math.PI / 2],
        [period - 2 * radius, height - radius, Math.PI / 2, 0],
        [period, radius, Math.PI, Math.PI * 1.5],
      ])
        for (let i = 0; i <= samples; i++) {
          const angle = start + ((end - start) * i) / samples,
            direction = Math.sign(end - start)
          const x = l * period + cx + radius * Math.cos(angle),
            y = side * (cy + radius * Math.sin(angle))
          const tx = -Math.sin(angle) * direction,
            ty = side * Math.cos(angle) * direction
          for (let k = 0; k < 2; k++) {
            const offset = ((k === 0 ? 1 : -1) * spacing) / 2
            const px = x - ty * offset,
              py = y + tx * offset
            const point = {
              x: a.x + ux * px - uy * py,
              y: a.y + uy * px + ux * py,
            }
            if (!rails[k].length || distance(rails[k].at(-1)!, point) > 1e-10)
              rails[k].push(point)
          }
        }
    return rails
  }
  const added = (h: number) =>
    Math.min(...generate(h).map((rail) => length(rail) - span))
  let lo = 2 * radius,
    hi = lo + deficit / 2 + radius
  if (added(lo) > deficit + 1e-8) return null
  for (let iteration = 0; iteration < 36; iteration++) {
    const mid = (lo + hi) / 2
    if (added(mid) < deficit) lo = mid
    else hi = mid
  }
  return generate((lo + hi) / 2)
}

export function roundedTuningLobes(
  a: Point,
  b: Point,
  deficit: number,
  lobes: number,
  side: number,
  minRadius: number,
): Point[] | null {
  return (
    roundedPairedLobes(a, b, 0, deficit, lobes, side, minRadius)?.[0] ?? null
  )
}

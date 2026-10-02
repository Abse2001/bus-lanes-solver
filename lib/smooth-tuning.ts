import { distance } from "./geometry"
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
  // Sample positions and trigonometry stay fixed while height changes.
  const samples = Math.max(
    48,
    Math.ceil(period / Math.max(0.005, minRadius / 6)),
  )
  const positions: number[] = [],
    raised: number[] = []
  for (let l = 0; l < lobes; l++)
    for (let j = 0; j < samples; j++) {
      positions.push(period * (l + j / samples))
      raised.push(1 - Math.cos((2 * Math.PI * j) / samples))
    }
  const generate = (height: number) => {
    const points: Point[] = []
    for (let i = 0; i < positions.length; i++) {
      const x = positions[i],
        y = (side * height * raised[i]) / 2
      points.push({ x: a.x + ux * x - uy * y, y: a.y + uy * x + ux * y })
    }
    points.push(b)
    return points
  }
  // Match length(generate(height)) in board coordinates and summation order,
  // without allocating trial routes during amplitude bisection.
  const emittedLength = (height: number) => {
    let total = 0,
      lastX = 0,
      lastY = 0
    for (let i = 0; i < positions.length; i++) {
      const localX = positions[i],
        localY = (side * height * raised[i]) / 2
      const x = a.x + ux * localX - uy * localY,
        y = a.y + uy * localX + ux * localY
      if (i > 0) {
        const dx = lastX - x,
          dy = lastY - y
        total += Math.sqrt(dx * dx + dy * dy)
      }
      lastX = x
      lastY = y
    }
    if (positions.length) {
      const dx = lastX - b.x,
        dy = lastY - b.y
      total += Math.sqrt(dx * dx + dy * dy)
    }
    return total
  }
  let lo = 0,
    hi = Math.min(maxHeight, deficit + span)
  if (emittedLength(hi) - span < deficit) return null
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (emittedLength(mid) - span < deficit) lo = mid
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
  // Retain the original full phase at every sample, including later lobes.
  const samples = Math.max(
    64,
    Math.ceil(period / Math.max(0.005, minRadius / 6)),
  )
  const positions: number[] = [],
    raised: number[] = [],
    slopes: number[] = []
  for (let k = 0; k <= samples * lobes; k++) {
    const phase = (2 * Math.PI * k) / samples
    positions.push((k * span) / (samples * lobes))
    raised.push(1 - Math.cos(phase))
    slopes.push(Math.sin(phase))
  }
  const generate = (height: number): [Point[], Point[]] => {
    const rails: [Point[], Point[]] = [[], []]
    for (let k = 0; k < positions.length; k++) {
      const x = positions[k],
        y = (side * height * raised[k]) / 2,
        slope = ((side * height * Math.PI) / period) * slopes[k]
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
  const addition = (height: number) => {
    const total = [0, 0],
      lastX = [0, 0],
      lastY = [0, 0]
    for (let k = 0; k < positions.length; k++) {
      const centerX = positions[k],
        centerY = (side * height * raised[k]) / 2,
        slope = ((side * height * Math.PI) / period) * slopes[k]
      const norm = Math.hypot(1, slope)
      for (let i = 0; i < 2; i++) {
        const offset = ((i === 0 ? 1 : -1) * spacing) / 2
        const lx = centerX - (offset * slope) / norm,
          ly = centerY + offset / norm
        const x = a.x + ux * lx - uy * ly,
          y = a.y + uy * lx + ux * ly
        if (k > 0) {
          const dx = lastX[i] - x,
            dy = lastY[i] - y
          total[i] += Math.sqrt(dx * dx + dy * dy)
        }
        lastX[i] = x
        lastY[i] = y
      }
    }
    return Math.min(total[0] - span, total[1] - span)
  }
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
  const samples = Math.max(
    18,
    Math.ceil((Math.PI * radius) / (2 * Math.max(0.005, minRadius / 6))),
  )
  const railCount = spacing === 0 ? 1 : 2
  // Arc angles and offsets are invariant during the height bisection. Retain
  // the original arithmetic order so the final sampled points are identical.
  const templates: Array<{
    px: number
    sin: number
    offsetY: number
    raised: boolean
    rail: number
  }> = []
  for (let l = 0; l < lobes; l++)
    for (const [cx, raised, start, end] of [
      [0, 0, -Math.PI / 2, 0],
      [2 * radius, 1, Math.PI, Math.PI / 2],
      [period - 2 * radius, 1, Math.PI / 2, 0],
      [period, 0, Math.PI, Math.PI * 1.5],
    ])
      for (let i = 0; i <= samples; i++) {
        const angle = start + ((end - start) * i) / samples,
          direction = Math.sign(end - start)
        const x = l * period + cx + radius * Math.cos(angle)
        const tx = -Math.sin(angle) * direction,
          ty = side * Math.cos(angle) * direction
        for (let k = 0; k < railCount; k++) {
          const offset = ((k === 0 ? 1 : -1) * spacing) / 2
          templates.push({
            px: x - ty * offset,
            sin: radius * Math.sin(angle),
            offsetY: tx * offset,
            raised: !!raised,
            rail: k,
          })
        }
      }
  const generate = (height: number): [Point[], Point[]] => {
    const rails: [Point[], Point[]] = [[], []]
    for (const t of templates) {
      const cy = t.raised ? height - radius : radius
      const py = side * (cy + t.sin) + t.offsetY
      const point = {
        x: a.x + ux * t.px - uy * py,
        y: a.y + uy * t.px + ux * py,
      }
      const rail = rails[t.rail]
      if (!rail.length || distance(rail.at(-1)!, point) > 1e-10)
        rail.push(point)
    }
    if (railCount === 1) rails[1] = rails[0]
    return rails
  }
  const railTemplates = [
    templates.filter((t) => t.rail === 0),
    templates.filter((t) => t.rail === 1),
  ]
  const added = (height: number) => {
    let shortest = Infinity
    for (let k = 0; k < railCount; k++) {
      let lastX = 0,
        lastY = 0,
        total = 0,
        first = true
      for (const t of railTemplates[k]) {
        const cy = t.raised ? height - radius : radius
        const py = side * (cy + t.sin) + t.offsetY
        const x = a.x + ux * t.px - uy * py
        const y = a.y + uy * t.px + ux * py
        const dx = lastX - x,
          dy = lastY - y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (first || d > 1e-10) {
          if (!first) total += d
          lastX = x
          lastY = y
          first = false
        }
      }
      shortest = Math.min(shortest, total - span)
    }
    return shortest
  }
  // Increasing height extends exactly two straight legs per lobe. The
  // circular chords and horizontal runs retain their lengths, so emitted
  // copper length is affine in height; no amplitude bisection is necessary.
  const minimumHeight = 2 * radius
  const minimumAddition = added(minimumHeight)
  if (minimumAddition > deficit + 1e-8) return null
  let height =
    minimumHeight + Math.max(0, deficit - minimumAddition) / (2 * lobes)
  // Correct the tiny board-coordinate summation error against the actual
  // emitted chords, preserving the length tolerance for rotated geometry.
  height = Math.max(
    minimumHeight,
    height + (deficit - added(height)) / (2 * lobes),
  )
  return generate(height)
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

import { expect, test } from "bun:test"
import { distance, length } from "../lib/geometry"
import { smoothTuningLobes, smoothPairedLobes } from "../lib/smooth-tuning"
import type { Point } from "../lib/types"

// Retain the original allocating amplitude search as an independent numerical
// reference. Compare on the running platform because native hypot may vary by
// an ulp; every emitted coordinate must still match before and after caching.
function reference(
  a: Point,
  b: Point,
  deficit: number,
  lobes: number,
  side: number,
  minRadius: number,
  spacing?: number,
): Point[][] | null {
  const span = distance(a, b),
    period = span / lobes
  if (span <= 0 || deficit <= 0 || lobes < 1) return null
  const ux = (b.x - a.x) / span,
    uy = (b.y - a.y) / span
  const generate = (height: number) => {
    const samples = Math.max(
      spacing === undefined ? 48 : 64,
      Math.ceil(period / Math.max(0.005, minRadius / 6)),
    )
    if (spacing === undefined) {
      const points: Point[] = []
      for (let l = 0; l < lobes; l++)
        for (let j = 0; j < samples; j++) {
          const x = period * (l + j / samples),
            y =
              (side * height * (1 - Math.cos((2 * Math.PI * j) / samples))) / 2
          points.push({ x: a.x + ux * x - uy * y, y: a.y + uy * x + ux * y })
        }
      points.push(b)
      return [points]
    }
    const rails: Point[][] = [[], []]
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
    Math.min(...generate(height).map((rail) => length(rail) - span))
  const maxHeight =
    (period * period) /
    (2 * Math.PI * Math.PI * (minRadius + (spacing ?? 0) / 2))
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

test("scalar amplitude search preserves every original single and paired curve coordinate", () => {
  const cases: [Point, Point, number, number, number, number][] = [
    [{ x: 0, y: 0 }, { x: 12, y: 0 }, 2, 2, 1, 0.3],
    [{ x: 8, y: -3 }, { x: 8, y: 9 }, 1.3, 3, -1, 0.15],
    [{ x: -6.13, y: 4.27 }, { x: 2.91, y: 13.31 }, 2.41, 4, 1, 0.12],
    [{ x: 0.031, y: -0.097 }, { x: 8.19, y: 5.39 }, 0.034, 2, -1, 0.25],
    [{ x: 1, y: 1 }, { x: 2, y: 1 }, 20, 8, 1, 0.3],
  ]
  for (const args of cases) {
    expect(smoothTuningLobes(...args)).toEqual(reference(...args)?.[0] ?? null)
    for (const spacing of [0.22, 0]) {
      const [a, b, deficit, lobes, side, minRadius] = args
      expect(
        smoothPairedLobes(a, b, spacing, deficit, lobes, side, minRadius),
      ).toEqual(reference(...args, spacing) as [Point[], Point[]] | null)
    }
  }
})

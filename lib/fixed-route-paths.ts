import type { Trace } from "./types"

export interface FixedPathRange {
  /** Inclusive vertex indices; protected ending-edge indices are start+1..end. */
  start: number
  end: number
}

function stableValueKey(value: unknown): string {
  if (typeof value === "number")
    return Object.is(value, -0) ? "-0" : String(value)
  if (Array.isArray(value)) return `[${value.map(stableValueKey).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${stableValueKey(field)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}

/** Compare every point field exactly, independent of object property order. */
export function fixedPathPointKey(point: Trace["route"][number]): string {
  return stableValueKey(point)
}

/** Locate every exact occurrence of each same-owner immutable path. Protecting
 * all occurrences also keeps coincident singleton endpoints immovable. Empty
 * or malformed fixed paths cannot establish preservation and return null. */
export function findFixedPathRanges(
  joined: Trace,
  fixedEscapes: readonly Trace[],
): FixedPathRange[] | null {
  const actual = joined.route.map(fixedPathPointKey)
  const actualCurves = new Set(joined.curvedSegments ?? [])
  const ranges = new Map<string, FixedPathRange>()
  for (const fixed of fixedEscapes) {
    if (fixed.connection_name !== joined.connection_name) continue
    const count = fixed.route.length
    const fixedCurves = new Set(fixed.curvedSegments ?? [])
    if (
      count === 0 ||
      fixedCurves.size !== (fixed.curvedSegments?.length ?? 0) ||
      [...fixedCurves].some((index) => {
        const a = fixed.route[index - 1],
          b = fixed.route[index]
        return (
          !Number.isInteger(index) ||
          index <= 0 ||
          index >= count ||
          a?.route_type !== "wire" ||
          b?.route_type !== "wire" ||
          a.layer !== b.layer
        )
      })
    )
      return null
    let found = false
    for (const reverse of [false, true]) {
      const points = reverse
        ? fixed.route.toReversed().map((point) =>
            point.route_type === "via"
              ? {
                  ...point,
                  from_layer: point.to_layer,
                  to_layer: point.from_layer,
                }
              : point,
          )
        : fixed.route
      const expected = points.map(fixedPathPointKey)
      for (let start = 0; start + count <= actual.length; start++) {
        if (!expected.every((point, index) => point === actual[start + index]))
          continue
        let curvesMatch = true
        for (let index = 1; index < count; index++) {
          if (
            actualCurves.has(start + index) !==
            fixedCurves.has(reverse ? count - index : index)
          ) {
            curvesMatch = false
            break
          }
        }
        if (!curvesMatch) continue
        found = true
        const end = start + count - 1
        ranges.set(`${start}:${end}`, { start, end })
      }
    }
    if (!found) return null
  }
  return [...ranges.values()].sort((a, b) => a.start - b.start || a.end - b.end)
}

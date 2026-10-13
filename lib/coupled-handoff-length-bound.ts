import { distance } from "./geometry"
import { maximumCarrierLength } from "./route-lengths"
import type { Connection, Point, SimpleRouteJson } from "./types"

/** Keep the established bevel order; its largest trim also bounds pruning. */
export const coupledPairApproachTrims = [1.5, 0.75, 0.375, 0.1875] as const

/** A completed, beveled approach must still visit within the maximum trim of
 * each rail handoff. The triangle inequality gives a necessary planar length
 * bound even when the raw handoff corner is removed. Fixed terminal copper is
 * already subtracted by maximumCarrierLength; no via depth is inferred. */
export function coupledHandoffExceedsLengthLimit(
  input: SimpleRouteJson,
  connection: Connection,
  rail: Point[],
  width: number,
): boolean {
  const maximum = maximumCarrierLength(input, connection.name)
  if (!Number.isFinite(maximum) || !rail.length) return false
  const start = connection.pointsToConnect[0]
  const end = connection.pointsToConnect[1]
  const handoffs = [rail[0], rail.at(-1)!]
  if (
    !start ||
    !end ||
    !Number.isFinite(width) ||
    width < 0 ||
    ![start, end, ...handoffs].every((point) =>
      [point.x, point.y].every(Number.isFinite),
    )
  )
    return false
  const shorteningAllowance = 2 * coupledPairApproachTrims[0] * width
  return handoffs.some(
    (point) =>
      distance(start, point) + distance(point, end) - shorteningAllowance >
      maximum + 1e-7,
  )
}

import type { Connection, Point, SimpleRouteJson } from "./types"

/** Match the original routed-copper validator's endpoint coincidence rule.
 * This bans only the terminal centre, not legal same-net pad-land overlap. */
export const nativeTerminalTolerance = 1e-6

export function nativeTerminalPoints(
  input: SimpleRouteJson,
  connection: Connection,
): Point[] {
  // The active connection may be outside a caller's pending connection subset.
  return [
    ...input.connections.flatMap((item) => item.pointsToConnect),
    ...connection.pointsToConnect,
  ]
}

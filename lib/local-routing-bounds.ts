import type { Point, SimpleRouteJson } from "./types"

/** A first search window around the negotiated terminals, independent of
 * unrelated fixed board copper. Callers must retain a board-wide fallback:
 * an obstacle or concave outline can require a detour outside this window. */
export function localRoutingBounds(
  input: SimpleRouteJson,
  terminals: readonly Point[] = input.connections.flatMap(
    (connection) => connection.pointsToConnect,
  ),
): SimpleRouteJson["bounds"] {
  const board = input.bounds
  if (!terminals.length) return { ...board }
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  for (const point of terminals) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const step = Math.max(
    0.01,
    input.minTraceWidth / (input.obstacles.some((o) => o.componentId) ? 2 : 1),
  )
  const pitch =
      input.minTraceWidth +
      (input.minTraceToPadEdgeClearance ??
        input.defaultObstacleMargin ??
        0.075),
    margin = Math.max(
      2,
      input.connections.length * pitch,
      Math.min(maxX - minX, maxY - minY) / 2,
    )
  const lo = (n: number, origin: number) =>
      origin + Math.floor((n - origin) / step) * step,
    hi = (n: number, origin: number) =>
      origin + Math.ceil((n - origin) / step) * step
  return {
    minX: Math.max(board.minX, lo(minX - margin, board.minX)),
    maxX: Math.min(board.maxX, hi(maxX + margin, board.minX)),
    minY: Math.max(board.minY, lo(minY - margin, board.minY)),
    maxY: Math.min(board.maxY, hi(maxY + margin, board.minY)),
  }
}

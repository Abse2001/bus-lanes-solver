import { distance, pointSegmentDistanceToPoints } from "./geometry"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

/** Board-world XY mm (+X right, +Y up). Preserve the existing terminal approach,
 * but reject added tuning copper that cuts through its own via land. */
export function createTerminalViaClearanceChecker(
  input: SimpleRouteJson,
  trace: Trace,
) {
  const width = (trace.route[0] as Wire).width
  const vias = (input.traces ?? [])
    .filter((fixed) => fixed.connection_name === trace.connection_name)
    .flatMap((fixed) =>
      fixed.route.filter((point) => point.route_type === "via"),
    )
    .map((via) => ({
      via,
      reach: ((via.via_diameter ?? input.minViaPadDiameter ?? 0.6) + width) / 2,
    }))
  if (!vias.length) return (_path: Point[]) => true
  const original = trace.route.filter((point) => point.route_type === "wire")
  const same = (a: Point, b: Point) =>
    Math.abs(a.x - b.x) < 1e-8 && Math.abs(a.y - b.y) < 1e-8
  return (path: Point[]) => {
    let prefix = 0,
      suffix = 0
    while (
      prefix < Math.min(path.length, original.length) &&
      same(path[prefix], original[prefix])
    )
      prefix++
    while (
      suffix < Math.min(path.length, original.length) &&
      same(
        path[path.length - 1 - suffix],
        original[original.length - 1 - suffix],
      )
    )
      suffix++
    for (const { via, reach } of vias) {
      const atStart = same(via, path[0])
      if (!atStart && !same(via, path.at(-1)!)) continue
      let along = 0
      for (let step = 1; step < path.length; step++) {
        const i = atStart ? step : path.length - step
        const a = path[atStart ? i - 1 : i]
        const b = path[atStart ? i : i - 1]
        const unchanged = atStart ? i < prefix : i >= path.length - suffix + 1
        if (
          !unchanged &&
          along > reach + 1e-9 &&
          Math.min(a.x, b.x) <= via.x + reach &&
          Math.max(a.x, b.x) >= via.x - reach &&
          Math.min(a.y, b.y) <= via.y + reach &&
          Math.max(a.y, b.y) >= via.y - reach &&
          pointSegmentDistanceToPoints(via, a, b) <= reach + 1e-9
        )
          return false
        // Only the initial land approach needs accumulated distance. Most
        // candidate copper is far away and needs just the bounding-box test.
        if (along <= reach + 1e-9) along += distance(a, b)
      }
    }
    return true
  }
}

export function terminalViaCopperIsClear(
  input: SimpleRouteJson,
  trace: Trace,
  path: Point[],
) {
  return createTerminalViaClearanceChecker(input, trace)(path)
}

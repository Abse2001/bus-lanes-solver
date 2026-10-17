import { distance, pointSegmentDistanceToPoints } from "./geometry"
import type { Connection, Point, SimpleRouteJson } from "./types"
import { fixedCopper } from "./vector-scene"

interface Rail {
  axis: "x" | "y"
  tangent: "x" | "y"
  coordinate: number
  low: number
  high: number
  radius: number
  layer: string
  proximity: number
}

/** Bounded search-only phases for via channels narrower than the raster pitch.
 * Parallel hard wires define a continuous legal center interval; its midpoint
 * supplies an origin. Every proposed phase still passes ordinary wire, land,
 * drill and outline checks when routing. The default phase remains separate. */
export function criticalSurfaceGridOrigins(
  input: SimpleRouteJson,
  connection: Connection,
  gridStep: number,
  maxCandidates = 4,
): Point[] {
  if (
    !Number.isFinite(gridStep) ||
    gridStep <= 0 ||
    !Number.isInteger(maxCandidates) ||
    maxCandidates <= 0
  )
    return []
  const diameter = input.minViaPadDiameter ?? 0.3,
    clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075,
    reach = Math.max(1, 4 * diameter),
    own = new Set(
      [connection.name, connection.source_trace_id].filter(Boolean),
    ),
    pads = connection.pointsToConnect,
    origin = { x: input.bounds.minX, y: input.bounds.minY }
  const rails = fixedCopper(input)
    .flatMap<Rail>((copper) => {
      if (
        copper.rect ||
        copper.owners.some((owner) => own.has(owner)) ||
        distance(copper.a, copper.b) < 1e-8
      )
        return []
      const axis =
        Math.abs(copper.a.x - copper.b.x) < 1e-8
          ? "x"
          : Math.abs(copper.a.y - copper.b.y) < 1e-8
            ? "y"
            : undefined
      if (
        !axis ||
        !pads.some(
          (pad) =>
            pointSegmentDistanceToPoints(pad, copper.a, copper.b) <= reach,
        )
      )
        return []
      const tangent = axis === "x" ? "y" : "x"
      return [
        {
          axis,
          tangent,
          coordinate: (copper.a[axis] + copper.b[axis]) / 2,
          low: Math.min(copper.a[tangent], copper.b[tangent]),
          high: Math.max(copper.a[tangent], copper.b[tangent]),
          radius: copper.radius,
          layer: copper.layer,
          proximity: Math.min(
            ...pads.map((pad) =>
              pointSegmentDistanceToPoints(pad, copper.a, copper.b),
            ),
          ),
        },
      ]
    })
    .sort((a, b) => a.proximity - b.proximity)
    .slice(0, 256)
  const choices: Array<{ origin: Point; distance: number; slack: number }> = []
  for (let i = 0; i < rails.length; i++)
    for (let j = i + 1; j < rails.length; j++) {
      const first = rails[i],
        second = rails[j]
      if (first.axis !== second.axis || first.layer !== second.layer) continue
      const [left, right] =
        first.coordinate < second.coordinate ? [first, second] : [second, first]
      const low = left.coordinate + left.radius + diameter / 2 + clearance,
        high = right.coordinate - right.radius - diameter / 2 - clearance,
        slack = high - low,
        tangentLow = Math.max(left.low, right.low),
        tangentHigh = Math.min(left.high, right.high)
      if (slack < -1e-8 || slack > gridStep + 1e-8 || tangentLow > tangentHigh)
        continue
      const coordinate = (low + high) / 2
      for (const pad of pads) {
        const at = {
          ...pad,
          [left.axis]: coordinate,
          [left.tangent]: Math.max(
            tangentLow,
            Math.min(tangentHigh, pad[left.tangent]),
          ),
        }
        const proximity = distance(pad, at)
        if (proximity > reach) continue
        choices.push({
          origin: { ...origin, [left.axis]: coordinate },
          distance: proximity,
          slack,
        })
      }
    }
  choices.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.slack - b.slack ||
      a.origin.x - b.origin.x ||
      a.origin.y - b.origin.y,
  )
  const phases: Point[] = []
  const phase = (value: number) => ((value % gridStep) + gridStep) % gridStep
  const samePhase = (a: Point, b: Point) =>
    (["x", "y"] as const).every((axis) => {
      const delta = Math.abs(
        phase(a[axis] - origin[axis]) - phase(b[axis] - origin[axis]),
      )
      return Math.min(delta, gridStep - delta) < 1e-8
    })
  for (const choice of choices) {
    if (
      samePhase(choice.origin, origin) ||
      phases.some((other) => samePhase(choice.origin, other))
    )
      continue
    phases.push(choice.origin)
    if (phases.length >= maxCandidates) break
  }
  return phases
}

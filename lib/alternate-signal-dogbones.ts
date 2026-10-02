import { backwardFacingPackageTerminals } from "./backward-facing-package-terminals"
import { routeLocalSignalDogbones } from "@tscircuit/fanout-solver"
import type { SimpleRouteJson, Point } from "./types"

/** The site matcher's preferred quadrant is expressed in a routing frame.
 * Rotate the entire scene (including fixed copper), then invert only newly
 * generated dogbones. This explores site choices without moving fixed copper. */
export function routeAlternateSignalDogbones(
  input: SimpleRouteJson,
  options: Parameters<typeof routeLocalSignalDogbones>[1],
  attempt: number,
): ReturnType<typeof routeLocalSignalDogbones> {
  const delta = input.connections.reduce(
    (s, c) => ({
      x: s.x + c.pointsToConnect[1].x - c.pointsToConnect[0].x,
      y: s.y + c.pointsToConnect[1].y - c.pointsToConnect[0].y,
    }),
    { x: 0, y: 0 },
  )
  const base =
    Math.abs(delta.x) > Math.abs(delta.y)
      ? delta.x > 0
        ? 3
        : 1
      : delta.y > 0
        ? 2
        : 0
  const busNames = new Set(
    (input.buses ?? []).flatMap((b) => b.connectionNames),
  )
  const backward = backwardFacingPackageTerminals({
    ...input,
    connections: input.connections.filter((c) => busNames.has(c.name)),
  })
  const turns = backward
    ? (base + attempt) % 4
    : attempt === 0
      ? 0
      : (base + attempt - 1) % 4
  const rotate = <T extends Point>(p: T, k: number): T => {
    let { x, y } = p
    for (let i = 0; i < k; i++) [x, y] = [-y, x]
    return { ...p, x, y }
  }
  const corners = [
    { x: input.bounds.minX, y: input.bounds.minY },
    { x: input.bounds.maxX, y: input.bounds.maxY },
  ].map((p) => rotate(p, turns))
  const rotated = {
    ...input,
    bounds: {
      minX: Math.min(...corners.map((p) => p.x)),
      maxX: Math.max(...corners.map((p) => p.x)),
      minY: Math.min(...corners.map((p) => p.y)),
      maxY: Math.max(...corners.map((p) => p.y)),
    },
    connections: input.connections.map((c) => ({
      ...c,
      pointsToConnect: c.pointsToConnect.map((p) => rotate(p, turns)),
    })),
    obstacles: input.obstacles.map((o) => ({
      ...o,
      center: rotate(o.center, turns),
      ccwRotationDegrees: (o.ccwRotationDegrees ?? 0) + 90 * turns,
    })),
    traces: input.traces?.map((t) => ({
      ...t,
      route: t.route.map((p) => rotate(p, turns)),
    })),
  }
  const result = routeLocalSignalDogbones(
    rotated as Parameters<typeof routeLocalSignalDogbones>[0],
    options,
  )
  return {
    connections: result.connections.map((c) => ({
      ...c,
      pointsToConnect: c.pointsToConnect.map((p) => rotate(p, (4 - turns) % 4)),
    })),
    traces: result.traces.map((t) => ({
      ...t,
      route: t.route.map((p) => {
        if (!("x" in p)) throw Error("Unexpected dogbone primitive")
        return rotate(p, (4 - turns) % 4)
      }),
    })),
  }
}

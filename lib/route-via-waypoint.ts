import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { tuningPathIsSelfClear } from "./length-tuning"
import { GridVisibilitySearch } from "./grid-visibility"
import { distance, length, simplify } from "./geometry"
import { VectorScene, type Copper } from "./vector-scene"
import type { Point } from "./types"

/** Generate a different corridor topology from an input-derived waypoint.
 * Reserve the first leg while searching the second; no geometry is persisted
 * across solver instances. */
export function* routeViaWaypoint(
  scene: VectorScene,
  waypoint: Point,
  soft: Copper[],
  penalty: number,
  history: Float32Array | undefined,
  maxLength: number,
): Generator<void, Point[] | null> {
  const [start, end] = scene.connection.pointsToConnect
  const first = new GridVisibilitySearch(
    scene,
    start,
    waypoint,
    soft,
    penalty,
    history,
    { maxLength: maxLength - distance(waypoint, end) },
  )
  try {
    while (!first.solved && !first.failed) {
      first.step()
      yield
    }
  } finally {
    first.cancel()
  }
  if (!first.solved) return null
  const firstPath = reduceOrdinaryTurns(first.result, scene)
  const prefix: Copper[] = []
  let remaining = length(firstPath) - scene.width - scene.margin - 1e-7
  for (let i = 1; i < firstPath.length && remaining > 0; i++) {
    const a = firstPath[i - 1],
      b = firstPath[i],
      span = distance(a, b),
      fraction = Math.min(1, remaining / span)
    prefix.push({
      a,
      b: { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction },
      radius: scene.width / 2,
      layer: start.layer,
      owners: ["waypoint_prefix"],
    })
    remaining -= span
  }
  const secondScene = new VectorScene(
    scene.input,
    scene.connection,
    scene.width,
    [...scene.copper, ...prefix],
  )
  const second = new GridVisibilitySearch(
    secondScene,
    waypoint,
    end,
    soft,
    penalty,
    history,
    { maxLength: maxLength - length(firstPath) },
  )
  try {
    while (!second.solved && !second.failed) {
      second.step()
      yield
    }
  } finally {
    second.cancel()
  }
  if (!second.solved) return null
  const secondPath = reduceOrdinaryTurns(second.result, secondScene)
  const path = simplify([...firstPath, ...secondPath.slice(1)])
  if (
    length(path) > maxLength + 1e-8 ||
    !tuningPathIsSelfClear(path, scene.width / 2 + scene.margin)
  )
    return null
  return path
}

import { tuningPathIsSelfClear } from "./length-tuning"
import { GridVisibilitySearch } from "./grid-visibility"
import { distance, length } from "./geometry"
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
  while (!first.solved && !first.failed) {
    first.step()
    yield
  }
  if (!first.solved) return null
  const prefix: Copper[] = []
  let remaining = length(first.result) - scene.width * 4
  for (let i = 1; i < first.result.length && remaining > 0; i++) {
    const a = first.result[i - 1],
      b = first.result[i],
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
    { maxLength: maxLength - length(first.result) },
  )
  while (!second.solved && !second.failed) {
    second.step()
    yield
  }
  if (!second.solved) return null
  const path = [...first.result, ...second.result.slice(1)]
  if (
    length(path) > maxLength + 1e-8 ||
    !tuningPathIsSelfClear(path, scene.width / 2 + scene.margin)
  )
    return null
  return path
}

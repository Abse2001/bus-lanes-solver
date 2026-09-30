import { expect, test } from "bun:test"
import { routeViaWaypoint } from "../lib/route-via-waypoint"
import { VectorScene } from "../lib/vector-scene"
import { length } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"

test("computed waypoint routes preserve terminals, avoid fixed copper, and respect the combined length budget", () => {
  const connection = {
    name: "D",
    pointsToConnect: [
      { x: 0, y: 0, layer: "top" },
      { x: 4, y: 0, layer: "top" },
    ],
  }
  const input = {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -1, maxX: 5, minY: -2, maxY: 3 },
    obstacles: [],
    connections: [connection],
  }
  const scene = new VectorScene(input, connection, 0.1, [
    {
      a: { x: 2, y: -1 },
      b: { x: 2, y: 1 },
      radius: 0.05,
      layer: "top",
      owners: ["fixed"],
    },
  ])
  for (const budget of [4, 7]) {
    const run = routeViaWaypoint(
      scene,
      { x: 2, y: 2 },
      [],
      0,
      undefined,
      budget,
    )
    let step = run.next()
    while (!step.done) step = run.next()
    if (budget === 4) {
      expect(step.value).toBeNull()
      continue
    }
    expect(step.value).not.toBeNull()
    const path = step.value!
    expect(path[0]).toEqual(connection.pointsToConnect[0])
    expect(path.at(-1)).toEqual(connection.pointsToConnect[1])
    expect(length(path)).toBeLessThanOrEqual(budget)
    expect(scene.pathVisible(path)).toBe(true)
    expect(tuningPathIsSelfClear(path, 0.2)).toBe(true)
  }
})

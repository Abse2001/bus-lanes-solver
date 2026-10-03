import { expect, test } from "bun:test"
import { length } from "../lib/geometry"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { fixedCopper, VectorScene } from "../lib/vector-scene"
import type { Point, SimpleRouteJson } from "../lib/types"
function fixture() {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 5, minY: -4, maxY: 4 },
    // A wall separates the board. Only the second source can reach the goals.
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.4,
        height: 8,
        layers: ["bottom"],
        connectedTo: ["wall"],
      },
    ],
    connections: [
      {
        name: "signal",
        pointsToConnect: [
          { x: -3, y: 0, layer: "bottom" },
          { x: 4, y: 2, layer: "bottom" },
        ],
      },
    ],
  }
  return new VectorScene(input, input.connections[0], 0.1, fixedCopper(input))
}
function solve(search: GridVisibilitySearch) {
  let steps = 0
  while (!search.solved && !search.failed && steps++ < 10000) search.step()
  search.cancel()
  return search
}
for (const reverse of [false, true])
  test(`multiple ${reverse ? "goals" : "sources"} select the shortest reachable terminal combination`, () => {
    const scene = fixture()
    let starts: Point[] = [
      { x: -3, y: 0 },
      { x: 2, y: 0 },
    ]
    let ends: Point[] = [
      { x: 4, y: 2 },
      { x: 4, y: 0 },
    ]
    if (reverse) [starts, ends] = [ends, starts]
    const search = solve(
      new GridVisibilitySearch(scene, starts[0], ends[0], [], 0, undefined, {
        step: 0.1,
        starts,
        ends,
      }),
    )
    expect(search.solved).toBe(true)
    expect(scene.pathVisible(search.result)).toBe(true)
    expect(search.result[0]).toEqual(reverse ? { x: 4, y: 0 } : { x: 2, y: 0 })
    expect(search.result.at(-1)).toEqual(
      reverse ? { x: 2, y: 0 } : { x: 4, y: 0 },
    )
    expect(length(search.result)).toBeCloseTo(2, 8)
    const exhaustive = starts.flatMap((start) =>
      ends.map((end) => {
        const single = solve(
          new GridVisibilitySearch(scene, start, end, [], 0, undefined, {
            step: 0.1,
            allTerminalAttachments: true,
          }),
        )
        return single.solved ? length(single.result) : Infinity
      }),
    )
    expect(length(search.result)).toBeCloseTo(Math.min(...exhaustive), 8)
  })
test("alternative endpoint connectors count toward the length budget", () => {
  const scene = fixture(),
    starts = [{ x: 2.03, y: 0.01 }],
    ends = [
      { x: 4.02, y: 0.01 },
      { x: 4.03, y: 1.01 },
    ]
  const run = (maxLength: number) =>
    solve(
      new GridVisibilitySearch(scene, starts[0], ends[0], [], 0, undefined, {
        step: 0.1,
        starts,
        ends,
        maxLength,
      }),
    )
  const reference = run(Infinity)
  expect(reference.solved).toBe(true)
  expect(run(length(reference.result) - 0.01).solved).toBe(false)
  expect(run(length(reference.result) + 1e-7).solved).toBe(true)
})
test("empty terminal domains fail without borrowing an active search's scratch", () => {
  const scene = fixture(),
    a = { x: 2, y: 0 },
    b = { x: 4, y: 0 }
  const pending = new GridVisibilitySearch(scene, a, b)
  for (const alternatives of [{ starts: [] }, { ends: [] }]) {
    const empty = solve(
      new GridVisibilitySearch(scene, a, b, [], 0, undefined, alternatives),
    )
    expect(empty.failed).toBe(true)
    expect(empty.result).toEqual([])
  }
  expect(solve(pending).solved).toBe(true)
})

test("disconnected terminal domains fail before A* without disturbing a live search", () => {
  const scene = fixture()
  const live = new GridVisibilitySearch(scene, { x: 2, y: 0 }, { x: 4, y: 0 })
  const disconnected = new GridVisibilitySearch(
    scene,
    { x: -3, y: 0 },
    { x: 4, y: 0 },
    [],
    0,
    undefined,
    { checkReachability: true },
  )
  expect(disconnected.failed).toBe(true)
  expect(disconnected.expanded).toBe(0)
  disconnected.cancel()
  expect(solve(live).solved).toBe(true)
})

test("a warmed reachability index does not advance ordinary attachment retries", () => {
  const scene = fixture(),
    start = { x: -3, y: 0 },
    end = { x: 4, y: 0 }
  const optedIn = new GridVisibilitySearch(
    scene,
    start,
    end,
    [],
    0,
    undefined,
    { checkReachability: true },
  )
  expect(optedIn.failed).toBe(true)
  optedIn.cancel()
  const ordinary = new GridVisibilitySearch(scene, start, end)
  expect(ordinary.failed).toBe(false)
  expect(solve(ordinary).failed).toBe(true)
})

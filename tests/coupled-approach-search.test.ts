import { expect, test } from "bun:test"
import { CoupledApproachSearch } from "../lib/coupled-approach-search"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, type Copper } from "../lib/vector-scene"
import type { SimpleRouteJson } from "../lib/types"

const input: SimpleRouteJson = {
  bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
  layerCount: 1,
  minTraceWidth: 0.1,
  obstacles: [],
  connections: [
    {
      name: "D",
      pointsToConnect: [
        { x: -1.5, y: 0, layer: "top" },
        { x: 1.5, y: 0, layer: "top" },
      ],
    },
  ],
}
const copper: Copper[] = [
  {
    a: { x: 0, y: -1 },
    b: { x: 0, y: 1 },
    radius: 0.1,
    layer: "top",
    owners: [],
  },
]

function drain<T>(generator: Generator<void, T>) {
  let yields = 0,
    step = generator.next()
  while (!step.done) {
    yields++
    step = generator.next()
  }
  return { path: step.value, yields }
}

test("pair approach reuse avoids expansions but preserves routes, yields and budget failures", () => {
  const memo = new CoupledApproachSearch()
  const c = input.connections[0]
  const scene = new VectorScene(input, c, 0.1, structuredClone(copper))
  let expansions = 0
  const original = GridVisibilitySearch.prototype.step
  GridVisibilitySearch.prototype.step = function () {
    expansions++
    original.call(this)
  }
  const run = (budget = 100000) =>
    drain(
      memo.route(scene, c.pointsToConnect[0], c.pointsToConnect[1], budget, {
        step: 0.025,
        bounds: input.bounds,
      }),
    )
  try {
    const first = run()
    expect(first.path).not.toBeNull()
    expect(expansions).toBeGreaterThan(0)
    expansions = 0
    expect(run()).toEqual(first)
    expect(expansions).toBe(0)
    first.path![0].x = 100
    expect(run().path![0].x).not.toBe(100)
    const bounded = run(1)
    expect(bounded.path).toBeNull()
    expect(expansions).toBeGreaterThan(0)
    expansions = 0
    expect(run(1)).toEqual(bounded)
    expect(expansions).toBe(0)
    scene.copper[0].b.y = 0.5
    const changed = run()
    expect(expansions).toBeGreaterThan(0)
    expect(changed).toEqual(
      drain(
        new CoupledApproachSearch().route(
          scene,
          c.pointsToConnect[0],
          c.pointsToConnect[1],
          100000,
          { step: 0.025, bounds: input.bounds },
        ),
      ),
    )
  } finally {
    GridVisibilitySearch.prototype.step = original
  }
})

test("abandoned pair approaches release search buffers without caching partial answers", () => {
  const memo = new CoupledApproachSearch()
  const c = input.connections[0]
  const scene = new VectorScene(input, c, 0.1, copper)
  let active: GridVisibilitySearch | undefined
  const original = GridVisibilitySearch.prototype.step
  GridVisibilitySearch.prototype.step = function () {
    active = this
  }
  const generator = memo.route(
    scene,
    c.pointsToConnect[0],
    c.pointsToConnect[1],
    10000,
  )
  try {
    expect(generator.next().done).toBe(false)
    generator.return(null)
    expect(active!.failed).toBe(true)
    expect((memo as any).answers.size).toBe(0)
  } finally {
    GridVisibilitySearch.prototype.step = original
  }
  expect(
    drain(memo.route(scene, c.pointsToConnect[0], c.pointsToConnect[1], 10000))
      .path,
  ).not.toBeNull()
})

test("approach reuse ignores distant copper but invalidates local copper, grid and clearance changes", () => {
  const source = structuredClone(input)
  const c = source.connections[0]
  const obstacles = [
    ...structuredClone(copper),
    {
      a: { x: 8, y: 8 },
      b: { x: 9, y: 9 },
      radius: 0.1,
      owners: [],
      layer: "top",
    },
  ]
  const memo = new CoupledApproachSearch()
  let expansions = 0
  const original = GridVisibilitySearch.prototype.step
  GridVisibilitySearch.prototype.step = function () {
    expansions++
    original.call(this)
  }
  const grid = { step: 0.025, bounds: source.bounds }
  const run = (cache = memo, soft: Copper[] = [], history?: Float32Array) =>
    drain(
      cache.route(
        new VectorScene(source, c, 0.1, obstacles),
        c.pointsToConnect[0],
        c.pointsToConnect[1],
        100000,
        grid,
        soft,
        4,
        history,
      ),
    )
  try {
    const first = run()
    expansions = 0
    obstacles[1].a.x = 7
    expect(run()).toEqual(first)
    expect(expansions).toBe(0)
    for (const mutate of [
      () => {
        obstacles[1].a = { x: 0.7, y: -0.7 }
        obstacles[1].b = { x: 0.7, y: 0.7 }
      },
      () => {
        source.minTraceToPadEdgeClearance = 0.12
      },
      () => {
        grid.step = 0.04
      },
      () => {
        source.minBoardEdgeClearance = 0.1
      },
    ]) {
      mutate()
      expansions = 0
      const result = run()
      expect(expansions).toBeGreaterThan(0)
      expect(result).toEqual(run(new CoupledApproachSearch()))
    }
    for (const [soft, history] of [
      [copper, undefined],
      [[], new Float32Array(11000)],
    ] as const) {
      run(memo, [...soft], history)
      expansions = 0
      run(memo, [...soft], history)
      expect(expansions).toBeGreaterThan(0)
    }
  } finally {
    GridVisibilitySearch.prototype.step = original
  }
})

test("approach answer storage evicts old entries within its byte cap", () => {
  const memo = new CoupledApproachSearch()
  const cache = memo as any
  cache.maxBytes = 2000
  const c = input.connections[0]
  const scene = new VectorScene(input, c, 0.1, copper)
  for (let i = 0; i < 20; i++) {
    const end = { ...c.pointsToConnect[1], y: i * 0.025 }
    expect(
      drain(
        memo.route(scene, c.pointsToConnect[0], end, 100000, {
          step: 0.025,
          bounds: input.bounds,
        }),
      ).path,
    ).not.toBeNull()
    expect(cache.bytes).toBeLessThanOrEqual(cache.maxBytes)
    expect(cache.bytes).toBe(
      [...cache.answers.values()].reduce(
        (sum: number, value: any) => sum + value.bytes,
        0,
      ),
    )
  }
  expect(cache.answers.size).toBeGreaterThan(0)
  expect(cache.answers.size).toBeLessThan(20)
})

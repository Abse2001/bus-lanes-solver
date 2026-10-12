import { expect, test } from "bun:test"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, type Copper } from "../lib/vector-scene"
import type { Point, SimpleRouteJson } from "../lib/types"
import { GridVisibilitySearch as OldGrid } from "../lib/grid-visibility"
import { VectorScene as OldScene } from "../lib/vector-scene"

const inputFor = (start: Point, end: Point): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.02,
  minTraceToPadEdgeClearance: 0,
  bounds: { minX: -8, maxX: 8, minY: -8, maxY: 8 },
  obstacles: [],
  connections: [
    {
      name: "n",
      pointsToConnect: [start, end].map((p) => ({ ...p, layer: "top" })),
    },
  ],
})
type Options = NonNullable<
  ConstructorParameters<typeof GridVisibilitySearch>[6]
>
const makePair = (
  input: SimpleRouteJson,
  start: Point,
  end: Point,
  options: Options,
  copper: Copper[] = [],
  history?: Float32Array,
  soft: Copper[] = [],
  penalty = 0,
) => {
  const connection = input.connections[0]
  return {
    old: new OldGrid(
      new OldScene(input, connection, 0.02, copper),
      start,
      end,
      soft,
      penalty,
      history,
      options,
    ),
    fresh: new GridVisibilitySearch(
      new VectorScene(input, connection, 0.02, copper),
      start,
      end,
      soft,
      penalty,
      history,
      { ...options, limitLengthBounds: true },
    ),
  }
}
function finish(search: GridVisibilitySearch | OldGrid, cap = 3000) {
  let calls = 0
  while (!search.solved && !search.failed && calls < cap) {
    search.step()
    calls++
  }
  const result = {
    solved: search.solved,
    failed: search.failed,
    route: search.result,
    expanded: search.expanded,
    calls,
    capped: !search.solved && !search.failed,
  }
  search.cancel()
  return result
}
const projection = (search: GridVisibilitySearch | OldGrid) => {
  const access = search.getRoutingAccess()
  return {
    starts: access.starts.map((a) => ({
      point: access.point(a.id),
      path: a.path,
    })),
    ends: access.ends.map((a) => ({ point: access.point(a.id), path: a.path })),
  }
}
const frontier = (search: GridVisibilitySearch) => {
  const heap = (search as any).heap,
    access = search.getRoutingAccess()
  return Array.from({ length: heap.length }, (_, i) => ({
    point: access.point(heap.ids[i]),
    g: heap.costs[i],
    f: heap.priorities[i],
    sequence: heap.sequences[i],
  }))
}
function checkLattice(
  full: OldGrid,
  cropped: GridVisibilitySearch,
  endpoints: Point[],
  step: number,
) {
  const a = full.getRoutingAccess(),
    b = cropped.getRoutingAccess(),
    origin = a.point(0)
  const parentId = (p: Point) =>
    Math.round((p.x - origin.x) / step) +
    Math.round((p.y - origin.y) / step) * a.nx
  for (let id = 0; id < b.cellCount; id++) {
    const p = b.point(id),
      parent = parentId(p)
    expect(parent).toBeGreaterThanOrEqual(0)
    expect(parent).toBeLessThan(a.cellCount)
    expect(a.point(parent)).toEqual(p)
    expect(a.isBlocked(parent)).toBe(b.isBlocked(id))
  }
  const clippedOrigin = b.point(0)
  for (const endpoint of endpoints) {
    const x = Math.round((endpoint.x - origin.x) / step),
      y = Math.round((endpoint.y - origin.y) / step)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const p = a.point(x + dx + (y + dy) * a.nx)
        const cx = Math.round((p.x - clippedOrigin.x) / step),
          cy = Math.round((p.y - clippedOrigin.y) / step)
        expect(cx).toBeGreaterThanOrEqual(0)
        expect(cx).toBeLessThan(b.nx)
        expect(cy).toBeGreaterThanOrEqual(0)
        expect(cy).toBeLessThan(b.ny)
        expect(b.point(cx + cy * b.nx)).toEqual(p)
      }
  }
  expect(projection(cropped)).toEqual(projection(full))
}

test("nearest finite crop preserves every point, both81-cell halos, attachment ties and exact source work", () => {
  for (const obstructed of [false, true]) {
    const start = { x: -0.3125, y: -0.0625 },
      end = { x: 0.8125, y: 0.6875 }
    const input = inputFor(start, end)
    const copper: Copper[] = obstructed
      ? [
          {
            a: { x: 0.1875, y: 0.3125 },
            b: { x: 0.1875, y: 0.3125 },
            radius: 0.125,
            layer: "top",
            owners: ["other"],
          },
        ]
      : []
    const pair = makePair(
      input,
      start,
      end,
      { step: 0.125, maxLength: 2, checkReachability: true },
      copper,
    )
    expect(pair.fresh.cellCount).toBeLessThan(pair.old.cellCount)
    expect((pair.fresh as any).alternateAttachments).toBe(false)
    expect((pair.old as any).alternateAttachments).toBe(false)
    checkLattice(pair.old, pair.fresh, [start, end], 0.125)
    const oldResult = finish(pair.old),
      newResult = finish(pair.fresh)
    expect(newResult).toEqual(oldResult)
    expect(newResult.solved).toBe(true)
  }
})

test("cropped nearest disconnection falls back before early alternatives even when other cropped attachments connect", () => {
  const start = { x: 0.0625, y: 0.0625 },
    end = { x: 0.8125, y: 0.0625 },
    step = 0.125,
    maxLength = 1
  const input = inputFor(start, end)
  const copper: Copper[] = [
    {
      a: { x: 0.0625, y: -3 },
      b: { x: 0.0625, y: -3 },
      radius: 0,
      layer: "top",
      owners: ["wall"],
      rect: { minX: -0.015, maxX: 0.14, minY: -6, maxY: 0.023 },
    },
    {
      a: { x: 0.0625, y: 3 },
      b: { x: 0.0625, y: 3 },
      radius: 0,
      layer: "top",
      owners: ["wall"],
      rect: { minX: -0.015, maxX: 0.14, minY: 0.102, maxY: 6 },
    },
  ]
  const pair = makePair(
    input,
    start,
    end,
    { step, maxLength, checkReachability: true },
    copper,
  )
  const origin = pair.old.getRoutingAccess().point(0)
  const range = (a: number, z: number, o: number, n: number) => [
    Math.max(0, Math.floor((Math.min(a, z) - maxLength - o) / step) - 5),
    Math.min(n - 1, Math.ceil((Math.max(a, z) + maxLength - o) / step) + 5),
  ]
  const full = pair.old.getRoutingAccess(),
    rx = range(start.x, end.x, origin.x, full.nx),
    ry = range(start.y, end.y, origin.y, full.ny)
  const lo = full.point(rx[0] + ry[0] * full.nx),
    hi = full.point(rx[1] + ry[1] * full.nx)
  const naive = new OldGrid(
    new OldScene(input, input.connections[0], 0.02, copper),
    start,
    end,
    [],
    0,
    undefined,
    {
      step,
      maxLength,
      checkReachability: true,
      bounds: { minX: lo.x, minY: lo.y, maxX: hi.x, maxY: hi.y },
    },
  )
  expect((naive as any).alternateAttachments).toBe(true)
  expect((pair.old as any).alternateAttachments).toBe(false)
  expect(pair.fresh.cellCount).toBe(pair.old.cellCount)
  expect((pair.fresh as any).alternateAttachments).toBe(false)
  expect(projection(pair.fresh)).toEqual(projection(pair.old))
  naive.cancel()
  const oldResult = finish(pair.old),
    newResult = finish(pair.fresh)
  expect(newResult).toEqual(oldResult)
  expect(newResult.solved).toBe(true)
  expect((pair.fresh as any).alternateAttachments).toBe(true)
})

test("missing nearest attachment falls back to the original full failure without A*", () => {
  const start = { x: 0, y: 0 },
    end = { x: 1, y: 0 },
    input = inputFor(start, end)
  const copper: Copper[] = [
    { a: start, b: start, radius: 1, layer: "top", owners: ["blocked"] },
  ]
  const pair = makePair(
    input,
    start,
    end,
    { step: 0.125, maxLength: 2, checkReachability: true },
    copper,
  )
  expect(pair.fresh.cellCount).toBe(pair.old.cellCount)
  expect(projection(pair.fresh)).toEqual(projection(pair.old))
  expect(finish(pair.fresh)).toEqual(finish(pair.old))
})

test("epsilon, diagonal and translated nonbinary phases preserve exact nearest routes and step charging", () => {
  for (const phase of [0, -0.37])
    for (const budget of [0, 0.01, 2 - 1e-8, 2, 2 + 1e-8]) {
      const start = { x: phase + 0.05, y: phase + 0.05 },
        end = { x: phase + 1.05, y: phase + 1.05 },
        input = inputFor(start, end)
      input.bounds = {
        minX: phase - 6,
        minY: phase - 6,
        maxX: phase + 6,
        maxY: phase + 6,
      }
      const pair = makePair(input, start, end, {
        step: 0.1,
        maxLength: budget,
        checkReachability: true,
      })
      expect(projection(pair.fresh)).toEqual(projection(pair.old))
      expect(finish(pair.fresh)).toEqual(finish(pair.old))
    }
})

test("history, soft copper, alternate APIs and nonfinite budgets retain the original full grid", () => {
  const start = { x: 0, y: 0 },
    end = { x: 1, y: 0 },
    input = inputFor(start, end),
    options = { step: 0.125, maxLength: 2, checkReachability: true }
  const cases: Array<{
    grid?: Options
    history?: Float32Array
    soft?: Copper[]
    penalty?: number
  }> = [
    { grid: { maxLength: Infinity } },
    { grid: { maxLength: NaN } },
    { grid: { maxLength: -1 } },
    { grid: { starts: [start] } },
    { grid: { ends: [end] } },
    { grid: { nearestTerminalAttachments: true } },
    { grid: { paretoLength: true } },
    { grid: { checkReachability: false } },
    { history: new Float32Array(129 * 129) },
    { penalty: 4 },
    {
      soft: [
        {
          a: { x: 2, y: 2 },
          b: { x: 3, y: 3 },
          radius: 0.01,
          layer: "top",
          owners: ["soft"],
        },
      ],
    },
  ]
  for (const entry of cases) {
    const pair = makePair(
      input,
      start,
      end,
      { ...options, ...entry.grid },
      [],
      entry.history,
      entry.soft ?? [],
      entry.penalty ?? 0,
    )
    expect(pair.fresh.cellCount).toBe(pair.old.cellCount)
    expect(projection(pair.fresh)).toEqual(projection(pair.old))
    expect(finish(pair.fresh)).toEqual(finish(pair.old))
  }
})

test("full preclip8M guard and fallback subclass private fields are preserved", () => {
  const start = { x: 0, y: 0 },
    end = { x: 1, y: 0 },
    input = inputFor(start, end)
  input.bounds = { minX: -100, maxX: 100, minY: -100, maxY: 100 }
  const scene = new VectorScene(input, input.connections[0], 0.02, []),
    oldScene = new OldScene(input, input.connections[0], 0.02, [])
  const options = { step: 0.01, maxLength: 2, checkReachability: true }
  expect(
    () => new OldGrid(oldScene, start, end, [], 0, undefined, options),
  ).toThrow("Dense grid search budget exceeded")
  expect(
    () =>
      new GridVisibilitySearch(scene, start, end, [], 0, undefined, {
        ...options,
        limitLengthBounds: true,
      }),
  ).toThrow("Dense grid search budget exceeded")
  const small = inputFor(start, end),
    copper: Copper[] = [
      { a: start, b: start, radius: 1, layer: "top", owners: ["blocked"] },
    ]
  class Derived extends GridVisibilitySearch {
    #state = "initialized"
    readState() {
      return this.#state
    }
    cancel() {
      throw Error("subclass public cancel must not run inside base constructor")
    }
  }
  const derived = new Derived(
    new VectorScene(small, small.connections[0], 0.02, copper),
    start,
    end,
    [],
    0,
    undefined,
    {
      step: 0.125,
      maxLength: 2,
      checkReachability: true,
      limitLengthBounds: true,
    },
  )
  expect(derived instanceof Derived).toBe(true)
  expect(derived.readState()).toBe("initialized")
  expect(derived.cellCount).toBe(129 * 129)
  expect(derived.failed).toBe(true)
  GridVisibilitySearch.prototype.cancel.call(derived)
})

test("connected occupancy is not physical success across a continuous sub-grid barrier", () => {
  const start = { x: -0.25, y: 0 },
    end = { x: 0.25, y: 0 },
    input = inputFor(start, end)
  const copper: Copper[] = [
    {
      a: { x: 0.0625, y: -7.5 },
      b: { x: 0.0625, y: 7.5 },
      radius: 0.005,
      layer: "top",
      owners: ["barrier"],
    },
  ]
  const pair = makePair(
    input,
    start,
    end,
    { step: 0.125, maxLength: 1, checkReachability: true },
    copper,
  )
  expect(pair.fresh.cellCount).toBeLessThan(pair.old.cellCount)
  expect((pair.fresh as any).alternateAttachments).toBe(false)
  const a = finish(pair.old),
    b = finish(pair.fresh)
  expect(b).toEqual(a)
  expect(b.failed).toBe(true)
  expect(b.solved).toBe(false)
})

test("fallback leaves another active search lease and its result untouched", () => {
  const start = { x: 0.0625, y: 0.0625 },
    end = { x: 0.8125, y: 0.0625 },
    input = inputFor(start, end)
  const opts = { step: 0.125, maxLength: 1, checkReachability: true }
  const copper: Copper[] = [
    {
      a: { x: 0.0625, y: -3 },
      b: { x: 0.0625, y: -3 },
      radius: 0,
      layer: "top",
      owners: ["wall"],
      rect: { minX: -0.015, maxX: 0.14, minY: -6, maxY: 0.023 },
    },
    {
      a: { x: 0.0625, y: 3 },
      b: { x: 0.0625, y: 3 },
      radius: 0,
      layer: "top",
      owners: ["wall"],
      rect: { minX: -0.015, maxX: 0.14, minY: 0.102, maxY: 6 },
    },
  ]
  const active = makePair(input, start, end, opts)
  const fallback = makePair(input, start, end, opts, copper)
  expect(active.fresh.cellCount).toBeLessThan(active.old.cellCount)
  expect(fallback.fresh.cellCount).toBe(fallback.old.cellCount)
  const a = finish(active.old),
    b = finish(active.fresh)
  expect(b).toEqual(a)
  active.fresh.cancel() // A released lease must not clear the other live search.
  expect(finish(fallback.fresh)).toEqual(finish(fallback.old))
  expect(active.fresh.result).toEqual(a.route)
})

test("the unchanged native3000 loop has equal charged yields and capped prefixes", () => {
  for (const cap of [0, 1, 3000]) {
    const start = { x: -0.3125, y: -0.0625 },
      end = { x: 0.8125, y: 0.6875 },
      input = inputFor(start, end)
    const copper: Copper[] = [
      {
        a: { x: 0.1875, y: 0.3125 },
        b: { x: 0.1875, y: 0.3125 },
        radius: 0.125,
        layer: "top",
        owners: ["other"],
      },
    ]
    const pair = makePair(
      input,
      start,
      end,
      { step: 0.125, maxLength: 2, checkReachability: true },
      copper,
    )
    function* nativeLoop(search: GridVisibilitySearch) {
      try {
        let steps = 0
        while (!search.solved && !search.failed && steps++ < cap) {
          search.step()
          yield
        }
        return {
          solved: search.solved,
          failed: search.failed,
          route: search.result,
          expanded: search.expanded,
        }
      } finally {
        search.cancel()
      }
    }
    const collect = (work: Generator) => {
      let yields = 0
      while (true) {
        const next = work.next()
        if (next.done) return { value: next.value, yields }
        yields++
      }
    }
    expect(collect(nativeLoop(pair.fresh))).toEqual(
      collect(nativeLoop(pair.old)),
    )
  }
})

test("nearest minimum scores and insertion-sequence frontier remain identical after each source step", () => {
  const start = { x: -0.3125, y: -0.0625 },
    end = { x: 0.8125, y: 0.6875 },
    input = inputFor(start, end)
  const copper: Copper[] = [
    {
      a: { x: 0.1875, y: 0.3125 },
      b: { x: 0.1875, y: 0.3125 },
      radius: 0.125,
      layer: "top",
      owners: ["other"],
    },
  ]
  const pair = makePair(
    input,
    start,
    end,
    { step: 0.125, maxLength: 2, checkReachability: true },
    copper,
  )
  let steps = 0
  try {
    expect(frontier(pair.fresh)).toEqual(frontier(pair.old))
    while (!pair.old.solved && !pair.old.failed && steps++ < 3000) {
      pair.old.step()
      pair.fresh.step()
      expect(pair.fresh.solved).toBe(pair.old.solved)
      expect(pair.fresh.failed).toBe(pair.old.failed)
      expect(pair.fresh.expanded).toBe(pair.old.expanded)
      expect(frontier(pair.fresh)).toEqual(frontier(pair.old))
    }
    expect(pair.fresh.result).toEqual(pair.old.result)
  } finally {
    pair.old.cancel()
    pair.fresh.cancel()
  }
})

test("inherited, hidden and accessor options retain the full original constructor values", () => {
  const start = { x: 0, y: 0 },
    end = { x: 1, y: 0 },
    input = inputFor(start, end)
  const bounds = { minX: -3.375, maxX: 4.25, minY: -2.25, maxY: 3.625 }
  const inherited = Object.create({
    step: 0.125,
    bounds,
    maxLength: 2,
    checkReachability: true,
    limitLengthBounds: true,
  }) as Options
  const hidden: Options = {
    maxLength: 2,
    checkReachability: true,
    limitLengthBounds: true,
  }
  Object.defineProperties(hidden, {
    step: { value: 0.125, enumerable: false },
    bounds: { value: bounds, enumerable: false },
  })
  const reads = { step: 0, bounds: 0, maxLength: 0 }
  const accessor: Options = { checkReachability: true, limitLengthBounds: true }
  Object.defineProperties(accessor, {
    step: {
      enumerable: true,
      get() {
        expect(this).toBe(accessor)
        reads.step++
        return 0.125
      },
    },
    bounds: {
      enumerable: true,
      get() {
        expect(this).toBe(accessor)
        reads.bounds++
        return bounds
      },
    },
    maxLength: {
      enumerable: true,
      get() {
        expect(this).toBe(accessor)
        reads.maxLength++
        return 2
      },
    },
  })
  for (const options of [inherited, hidden, accessor]) {
    reads.step = reads.bounds = reads.maxLength = 0
    const old = new OldGrid(
      new OldScene(input, input.connections[0], 0.02, []),
      start,
      end,
      [],
      0,
      undefined,
      options,
    )
    const originalReads = { ...reads }
    reads.step = reads.bounds = reads.maxLength = 0
    const fresh = new GridVisibilitySearch(
      new VectorScene(input, input.connections[0], 0.02, []),
      start,
      end,
      [],
      0,
      undefined,
      options,
    )
    expect(reads).toEqual(originalReads)
    expect(fresh.cellCount).toBe(62 * 48)
    expect(fresh.cellCount).toBe(old.cellCount)
    expect(projection(fresh)).toEqual(projection(old))
    expect(finish(fresh)).toEqual(finish(old))
  }
})

test("null-prototype and frozen declarative data options still permit healthy nearest clipping", () => {
  const start = { x: 0, y: 0 },
    end = { x: 1, y: 0 },
    input = inputFor(start, end)
  for (const options of [
    Object.assign(Object.create(null), {
      step: 0.125,
      maxLength: 2,
      checkReachability: true,
      limitLengthBounds: true,
    }) as Options,
    Object.freeze({
      step: 0.125,
      maxLength: 2,
      checkReachability: true,
      limitLengthBounds: true,
    }),
  ]) {
    const oldOptions = { ...options, limitLengthBounds: false }
    const old = new OldGrid(
      new OldScene(input, input.connections[0], 0.02, []),
      start,
      end,
      [],
      0,
      undefined,
      oldOptions,
    )
    const fresh = new GridVisibilitySearch(
      new VectorScene(input, input.connections[0], 0.02, []),
      start,
      end,
      [],
      0,
      undefined,
      options,
    )
    expect(fresh.cellCount).toBeLessThan(old.cellCount)
    expect(projection(fresh)).toEqual(projection(old))
    expect(finish(fresh)).toEqual(finish(old))
  }
})

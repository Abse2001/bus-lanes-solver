import { expect, test } from "bun:test"
import { RouteCandidatePool } from "../lib/select-route-candidates"
import type { Trace } from "../lib/types"

const trace = (name: string, points: number[][]): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: name,
  connection_name: name,
  route: points.map(([x, y]) => ({
    route_type: "wire",
    x,
    y,
    width: 0.1,
    layer: "top",
  })),
})

test("selects compatible generated alternatives instead of the latest colliding routes", () => {
  const pool = new RouteCandidatePool(0.1)
  const direct = trace("a", [
    [0, 0],
    [2, 0],
  ])
  const detour = trace("a", [
    [0, 0],
    [0, 2],
    [2, 2],
    [2, 0],
  ])
  const crossing = trace("b", [
    [1, -1],
    [1, 1],
  ])
  pool.add("a", [direct])
  pool.add("a", [detour])
  pool.add("b", [crossing])
  expect(pool.select(["a", "b"])).toEqual(
    expect.arrayContaining([detour, crossing]),
  )
})

test("cannot split a paired candidate or accept an incomplete assignment", () => {
  const pool = new RouteCandidatePool(0.1)
  pool.add("pair", [
    trace("p", [
      [0, 0],
      [2, 0],
    ]),
    trace("n", [
      [0, 0.3],
      [2, 0.3],
    ]),
  ])
  pool.add("other", [
    trace("x", [
      [1, 0.2],
      [1, 1],
    ]),
  ])
  expect(pool.select(["pair", "other"])).toBeNull()
  expect(pool.select(["pair", "missing"])).toBeNull()
})

test("an unsatisfiable candidate pool can recover when a new route is generated", () => {
  const pool = new RouteCandidatePool(0.1)
  pool.add("a", [
    trace("a", [
      [0, 0],
      [2, 0],
    ]),
  ])
  const crossing = trace("b", [
    [1, -1],
    [1, 1],
  ])
  pool.add("b", [crossing])
  expect(pool.select(["a", "b"])).toBeNull()
  const detour = trace("a", [
    [0, 0],
    [0, 2],
    [2, 2],
    [2, 0],
  ])
  pool.add("a", [detour])
  expect(pool.select(["a", "b"])).toEqual(
    expect.arrayContaining([detour, crossing]),
  )
})

test("retiring older candidates preserves exclusions and accepts new compatible geometry", () => {
  const pool = new RouteCandidatePool(0.1, 3)
  const crossing = trace("b", [
    [1, -1],
    [1, 1],
  ])
  pool.add("b", [crossing])
  for (let i = 0; i < 105; i++) {
    pool.add("a", [
      trace("a", [
        [0, i / 1000],
        [2, i / 1000],
      ]),
    ])
    expect(pool.select(["a", "b"])).toBeNull()
  }
  const detour = trace("a", [
    [0, 0],
    [0, 2],
    [2, 2],
    [2, 0],
  ])
  pool.add("a", [detour])
  expect(pool.select(["a", "b"])).toEqual(
    expect.arrayContaining([detour, crossing]),
  )
})

test("a long independent bus does not hide a shorter bus's avoidable detour", () => {
  const pool = new RouteCandidatePool(0.1)
  const long = trace("a", [
    [0, 0],
    [20, 0],
  ])
  const short = trace("b", [
    [0, 2],
    [4, 2],
  ])
  pool.add("a", [long])
  pool.add("b", [
    trace("b", [
      [0, 2],
      [0, 4],
      [4, 4],
      [4, 2],
    ]),
  ])
  pool.add("b", [short])
  expect(pool.select(["a", "b"], [["a"], ["b"]])).toEqual(
    expect.arrayContaining([long, short]),
  )
})

test("repeated unsatisfiable selections remain recoverable without losing collision exclusions", () => {
  const pool = new RouteCandidatePool(0.1)
  pool.add("a", [
    trace("a", [
      [0, 0],
      [2, 0],
    ]),
  ])
  const crossing = trace("b", [
    [1, -1],
    [1, 1],
  ])
  pool.add("b", [crossing])
  for (let i = 0; i < 160; i++) expect(pool.select(["a", "b"])).toBeNull()
  const detour = trace("a", [
    [0, 0],
    [0, 2],
    [2, 2],
    [2, 0],
  ])
  pool.add("a", [detour])
  expect(pool.select(["a", "b"])).toEqual(
    expect.arrayContaining([detour, crossing]),
  )
})

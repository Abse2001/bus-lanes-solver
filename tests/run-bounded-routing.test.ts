import { expect, test } from "bun:test"
import { runBoundedRouting } from "../lib/run-bounded-routing"

test("bounded routing propagates completed results and closes exhausted searches", () => {
  let closed = 0
  function* search(): Generator<void, string> {
    try {
      yield
      yield
      return "complete"
    } finally {
      closed++
    }
  }
  const completed = runBoundedRouting(search(), 2)
  expect(completed.next().done).toBe(false)
  expect(completed.next().done).toBe(false)
  expect(completed.next()).toEqual({ done: true, value: "complete" })
  expect(closed).toBe(1)
  const exhausted = runBoundedRouting(search(), 1)
  expect(exhausted.next().done).toBe(false)
  expect(exhausted.next()).toEqual({ done: true, value: null })
  expect(closed).toBe(2)
})

test("parent cancellation closes the active child search", () => {
  let closed = false
  function* search(): Generator<void, null> {
    try {
      while (true) yield
    } finally {
      closed = true
    }
  }
  const parent = runBoundedRouting(search(), 100)
  parent.next()
  expect(closed).toBe(false)
  parent.return(null)
  expect(closed).toBe(true)
})

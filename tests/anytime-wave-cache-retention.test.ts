import { expect, test } from "bun:test"
import { AnytimeWaveCache } from "../lib/anytime-wave-cache"
import type { Point } from "../lib/types"

const pointReferences = (value: unknown): number => {
  if (Array.isArray(value))
    return value.reduce((sum, child) => sum + pointReferences(child), 0)
  return value && typeof value === "object" && "x" in value && "y" in value
    ? 1
    : 0
}

test("nested phase variants count shared point references and evict restoration under one exact budget", () => {
  const cache = new AnytimeWaveCache(6, 4),
    bank = {},
    shared = Object.freeze({ x: 0, y: 0 }),
    restoration = Object.freeze([Object.freeze([shared, shared])]),
    phases = Object.freeze([
      Object.freeze([Object.freeze([shared, shared]), Object.freeze([shared])]),
      Object.freeze([Object.freeze([shared, shared, shared])]),
    ])
  let restored = 0,
    phased = 0
  const restore = () =>
    cache.get(
      bank,
      "restore",
      1,
      () => {
        restored++
        return restoration
      },
      pointReferences,
    )
  const phase = () =>
    cache.get(
      bank,
      "phases",
      1,
      () => {
        phased++
        return phases
      },
      pointReferences,
    )
  expect(restore()).toBe(restoration)
  expect(cache.pointReferences).toBe(2)
  expect(phase()).toBe(phases)
  expect(cache.pointReferences).toBe(6)
  expect(cache.size).toBe(1)
  expect(phase()).toBe(phases)
  expect(phased).toBe(1)
  expect(restore()).toBe(restoration)
  expect(restored).toBe(2)
  expect(cache.pointReferences).toBe(2)
  expect(cache.size).toBe(1)
})

test("zero point allowance preserves bounded negative memoization while positive waves remain uncached", () => {
  const cache = new AnytimeWaveCache(0, 2),
    bank = {}
  let rejected = 0,
    built = 0
  const reject = () =>
    cache.get(
      bank,
      "restore",
      1,
      () => {
        rejected++
        return null
      },
      pointReferences,
    )
  const positive = () =>
    cache.get(
      bank,
      "phases",
      1,
      () => {
        built++
        return [[[{ x: 0, y: 0 }]]]
      },
      pointReferences,
    )
  expect(reject()).toBeNull()
  expect(reject()).toBeNull()
  expect(rejected).toBe(1)
  expect(positive()).toEqual(positive())
  expect(built).toBe(2)
  expect(cache.pointReferences).toBe(0)
  expect(cache.size).toBe(1)
})

test("disabled entry retention recomputes positive and rejected values without keeping any references", () => {
  const cache = new AnytimeWaveCache(200_000, 0),
    bank = {}
  let calls = 0
  for (let i = 0; i < 10; i++) {
    const value = cache.get(
      bank,
      i % 2 ? "restore" : "phases",
      1,
      () => {
        calls++
        return i % 2 ? null : [[[{ x: 0, y: 0 }]]]
      },
      pointReferences,
    )
    expect(value).toEqual(i % 2 ? null : [[[{ x: 0, y: 0 }]]])
    expect(cache.size).toBe(0)
    expect(cache.pointReferences).toBe(0)
  }
  expect(calls).toBe(10)
})

test("FIFO bounds retain separate bank and kind ownership without refreshing hits", () => {
  const cache = new AnytimeWaveCache(200_000, 2),
    firstBank = {},
    secondBank = {}
  const calls: string[] = []
  const get = (bank: object, kind: "restore" | "phases", label: string) =>
    cache.get(
      bank,
      kind,
      0,
      () => {
        calls.push(label)
        return Object.freeze([{ x: calls.length, y: 0 }]) as readonly Point[]
      },
      pointReferences,
    )
  const first = get(firstBank, "restore", "first")
  const second = get(firstBank, "phases", "second")
  expect(get(firstBank, "restore", "first")).toBe(first)
  get(secondBank, "restore", "third")
  expect(get(firstBank, "phases", "second")).toBe(second)
  expect(get(firstBank, "restore", "first")).not.toBe(first)
  expect(calls).toEqual(["first", "second", "third", "first"])
  expect(cache.size).toBe(2)
  expect(cache.pointReferences).toBe(2)
})

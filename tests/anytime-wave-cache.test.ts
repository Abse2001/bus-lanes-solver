import { expect, test } from "bun:test"
import { AnytimeWaveCache } from "../lib/anytime-wave-cache"
import type { Point } from "../lib/types"

test("wave memoization shares a point budget across banks and construction kinds", () => {
  const cache = new AnytimeWaveCache(6, 128),
    bank = {},
    otherBank = {},
    calls: string[] = []
  const get = (key: object, kind: "restore" | "phases", amount: number) =>
    cache.get(
      key,
      kind,
      amount,
      () => {
        calls.push(`${kind}:${amount}`)
        return Array.from({ length: 3 }, (_, i) => ({ x: amount, y: i }))
      },
      (points) => points.length,
    )
  const first = get(bank, "restore", 1)
  get(bank, "phases", 1)
  expect(get(bank, "restore", 1)).toBe(first)
  expect(cache.pointReferences).toBe(6)
  get(otherBank, "restore", 1)
  expect(cache.size).toBe(2)
  expect(cache.pointReferences).toBe(6)
  expect(get(bank, "restore", 1)).toEqual(first)
  expect(calls).toEqual(["restore:1", "phases:1", "restore:1", "restore:1"])
})

test("oversized wave results are returned without retaining or evicting useful geometry", () => {
  const cache = new AnytimeWaveCache(4, 4),
    bank = {},
    count = (points: Point[]) => points.length
  let calls = 0
  const small = () => [{ x: 0, y: 0 }],
    large = () => {
      calls++
      return Array.from({ length: 5 }, (_, x) => ({ x, y: 0 }))
    }
  const retained = cache.get(bank, "restore", 1, small, count)
  const first = cache.get(bank, "restore", 2, large, count),
    second = cache.get(bank, "restore", 2, large, count)
  expect(second).toEqual(first)
  expect(second).not.toBe(first)
  expect(calls).toBe(2)
  expect(cache.get(bank, "restore", 1, small, count)).toBe(retained)
  expect(cache.pointReferences).toBe(1)
  expect(cache.size).toBe(1)
})

test("entry bounds include empty and rejected constructions while eviction preserves exact results", () => {
  const cache = new AnytimeWaveCache(12, 4),
    banks = [{}, {}, {}]
  const create = (amount: number): Point[][] | null =>
    amount % 3 === 0
      ? null
      : [
          Array.from({ length: amount % 17 }, (_, i) => ({
            x: i / 3,
            y: Math.sin(i + amount),
          })),
        ]
  let calls = 0
  for (let i = 0; i < 100; i++) {
    const amount = (i * 13) % 23,
      actual = cache.get(
        banks[i % banks.length],
        i % 2 ? "restore" : "phases",
        amount,
        () => {
          calls++
          return create(amount)
        },
        (waves) => waves?.reduce((sum, points) => sum + points.length, 0) ?? 0,
      )
    expect(actual).toEqual(create(amount))
    expect(cache.size).toBeLessThanOrEqual(4)
    expect(cache.pointReferences).toBeLessThanOrEqual(12)
  }
  expect(calls).toBeGreaterThan(4)
})

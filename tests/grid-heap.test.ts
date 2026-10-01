import { expect, test } from "bun:test"
import { GridHeap } from "../lib/grid-heap"

test("numeric grid queue orders by cost, progress, and insertion across updates", () => {
  const heap = new GridHeap(5000)
  const reference: { id: number; g: number; f: number; sequence: number }[] = []
  let sequence = 0
  let random = 17
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0)
  const pop = () => {
    reference.sort((a, b) => a.f - b.f || b.g - a.g || a.sequence - b.sequence)
    const expected = reference.shift()!
    heap.pop()
    expect([heap.id, heap.g]).toEqual([expected.id, expected.g])
    expect(heap.length).toBe(reference.length)
  }
  for (let id = 0; id < 5000; id++) {
    const entry = {
      id,
      g: next() / 1e6,
      f: (next() % 31) / 7,
      sequence: sequence++,
    }
    reference.push(entry)
    heap.push(entry.id, entry.g, entry.f)
    if (id % 11 === 0 && reference.length) {
      const updated = reference[next() % reference.length]
      updated.g += id % 2 ? -0.5 : 0.5
      // Include equal-f replacement to exercise stable tie reordering.
      updated.f -= id % 22 === 0 ? 0 : 0.5
      updated.sequence = sequence++
      heap.push(updated.id, updated.g, updated.f)
    }
    if (id % 3 !== 0) pop()
  }
  while (reference.length) pop()
})

test("queue replacements preserve stable ties when priorities increase or ids are reused", () => {
  const heap = new GridHeap(257)
  const reference = new Map<
    number,
    { id: number; g: number; f: number; sequence: number }
  >()
  let sequence = 0
  let random = 73
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0)
  const pop = () => {
    const expected = [...reference.values()].sort(
      (a, b) => a.f - b.f || b.g - a.g || a.sequence - b.sequence,
    )[0]
    heap.pop()
    expect([heap.id, heap.g]).toEqual([expected.id, expected.g])
    reference.delete(expected.id)
    expect(heap.length).toBe(reference.size)
  }
  for (let operation = 0; operation < 5000; operation++) {
    if (reference.size && next() % 3 === 0) {
      pop()
      continue
    }
    const id = next() % 257,
      g = next() % 7,
      f = next() % 11
    reference.set(id, { id, g, f, sequence: sequence++ })
    heap.push(id, g, f)
  }
  while (reference.size) pop()
})

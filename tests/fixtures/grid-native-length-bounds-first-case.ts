import assert from "node:assert/strict"
import { GridVisibilitySearch } from "../../lib/grid-visibility"
import { fixedCopper, VectorScene } from "../../lib/vector-scene"
import { loadG350Am3352Sample } from "../../scripts/g350-am3352-sample"

// The original first native-grid case runs in this nondiscovered child file.
// Its 5000 ms deadline and all original assertions remain explicit.
let originalAssertions = 0
let deadlineChecks = 0
let membershipPointAttempts = 0
let membershipPointsValidated = 0
const expect = (value: unknown) => {
  const check = (work: () => void) => {
    originalAssertions++
    work()
  }
  return {
    toBe: (expected: unknown) =>
      check(() => assert.strictEqual(value, expected)),
    toEqual: (expected: unknown) =>
      check(() => assert.deepStrictEqual(value, expected)),
    toHaveLength: (expected: number) =>
      check(() =>
        assert.strictEqual((value as { length: number }).length, expected),
      ),
    toBeGreaterThan: (expected: number) =>
      check(() => assert.ok(typeof value === "number" && value > expected)),
    toBeGreaterThanOrEqual: (expected: number) =>
      check(() => assert.ok(typeof value === "number" && value >= expected)),
    toBeLessThan: (expected: number) =>
      check(() => assert.ok(typeof value === "number" && value < expected)),
  }
}
function complete(search: GridVisibilitySearch) {
  let calls = 0
  while (!search.solved && !search.failed && calls < 4000) {
    search.step()
    calls++
  }
  const result = {
    solved: search.solved,
    failed: search.failed,
    route: search.result,
    expanded: search.expanded,
    calls,
  }
  search.cancel()
  return result
}
const caseStarted = performance.now()
const childDeadlineMs = 5000
function deadline() {
  deadlineChecks++
  assert.ok(
    performance.now() - caseStarted < childDeadlineMs,
    "Original native-grid case exceeded its 5000 ms child deadline",
  )
}
try {
  const native = loadG350Am3352Sample()
  const connection = native.connections.find(
    (candidate) => candidate.name === "source_trace_9",
  )!
  const start = connection.pointsToConnect[0]
  const end = { x: -4, y: 13.6, layer: "top" }
  const input = { ...native, connections: [connection] }
  const local = { ...connection, pointsToConnect: [start, end] }
  const scene = new VectorScene(input, local, 0.1016, fixedCopper(input))
  const run = (limitLengthBounds: boolean) =>
    new GridVisibilitySearch(scene, start, end, [], 0, undefined, {
      checkReachability: true,
      allTerminalAttachments: true,
      maxLength: 2,
      paretoLength: true,
      limitLengthBounds,
    })
  deadline()
  const reference = run(false)
  deadline()
  const bounded = run(true)
  deadline()
  const full = reference.getRoutingAccess()
  const clipped = bounded.getRoutingAccess()
  expect(native.obstacles).toHaveLength(854)
  expect(clipped.cellCount).toBeLessThan(full.cellCount / 20)
  const origin = full.point(0)
  const stepX = full.point(1).x - origin.x
  const stepY = full.point(full.nx).y - origin.y
  expect(stepX).toBeGreaterThan(0)
  expect(stepY).toBeGreaterThan(0)
  for (let id = 0; id < clipped.cellCount; id++) {
    membershipPointAttempts++
    const point = clipped.point(id)
    const column = Math.round((point.x - origin.x) / stepX)
    const row = Math.round((point.y - origin.y) / stepY)
    expect(column).toBeGreaterThanOrEqual(0)
    expect(column).toBeLessThan(full.nx)
    expect(row).toBeGreaterThanOrEqual(0)
    expect(row).toBeLessThan(full.ny)
    expect(full.point(row * full.nx + column)).toEqual(point)
    membershipPointsValidated++
    deadline()
  }
  const original = complete(reference)
  deadline()
  const candidate = complete(bounded)
  deadline()
  expect(original.solved).toBe(true)
  expect(candidate).toEqual(original)
  expect(scene.pathVisible(candidate.route)).toBe(true)
  deadline()
  process.stdout.write(
    `${JSON.stringify({
      caseCompleted: true,
      originalAssertions,
      expectedOriginalAssertions: 5 * clipped.cellCount + 7,
      membershipPointAttempts,
      membershipPointsValidated,
      clippedCellCount: clipped.cellCount,
      fullCellCount: full.cellCount,
      nativeObstacleCount: native.obstacles.length,
      childDeadlineMs,
      nativeStepCap: 4000,
      deadlineChecks,
      elapsedMs: performance.now() - caseStarted,
      originalSolved: original.solved,
      originalCalls: original.calls,
      boundedCalls: candidate.calls,
      accepted49: false,
    })}\n`,
  )
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ caseCompleted: false, originalAssertions, membershipPointAttempts, membershipPointsValidated, childDeadlineMs, nativeStepCap: 4000, deadlineChecks, elapsedMs: performance.now() - caseStarted, accepted49: false })}\n`,
  )
  throw error
}

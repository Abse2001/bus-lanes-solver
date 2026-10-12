import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { fixedCopper, VectorScene, type Copper } from "../lib/vector-scene"
import type { Point, SimpleRouteJson } from "../lib/types"
import { loadG350Am3352Sample } from "../scripts/g350-am3352-sample"

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

test("a short native approach retains the exact board grid while avoiding a board-sized raster", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL(
          "./fixtures/grid-native-length-bounds-first-case.ts",
          import.meta.url,
        ),
      ),
    ],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  )
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 5000)
  try {
    const [exitCode, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) {
      process.stdout.write(output)
      process.stderr.write(errors)
    }
    expect(timedOut).toBe(false)
    expect(exitCode).toBe(0)
    expect(errors).toBe("")
    const summary = JSON.parse(output.trim())
    expect(summary.caseCompleted).toBe(true)
    expect(summary.nativeObstacleCount).toBe(854)
    expect(summary.childDeadlineMs).toBe(5000)
    expect(summary.nativeStepCap).toBe(4000)
    expect(summary.originalAssertions).toBe(5 * summary.clippedCellCount + 7)
    expect(summary.expectedOriginalAssertions).toBe(summary.originalAssertions)
    expect(summary.membershipPointAttempts).toBe(summary.clippedCellCount)
    expect(summary.membershipPointsValidated).toBe(summary.clippedCellCount)
    expect(summary.originalSolved).toBe(true)
    expect(summary.boundedCalls).toBe(summary.originalCalls)
    expect(summary.elapsedMs).toBeLessThan(5000)
    process.stdout.write(`GRID_NATIVE_CHILD ${JSON.stringify(summary)}\n`)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
  }
})

test("finite-length clipping preserves endpoint attachment order, detours and bounded search work", () => {
  let seed = 0x1134e57
  const random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  for (let index = 0; index < 80; index++) {
    const step = [0.05, 0.0508, 0.07, 0.1][index % 4]
    const start = {
      x: random() * 4 - 2,
      y: random() * 4 - 2,
      layer: "top",
    }
    const end = {
      x: start.x + random() * 2 - 1,
      y: start.y + random() * 2 - 1,
      layer: "top",
    }
    const maxLength = 0.5 + random() * 2
    const input: SimpleRouteJson = {
      layerCount: 4,
      minTraceWidth: step * 2,
      minTraceToPadEdgeClearance: 0.05,
      minBoardEdgeClearance: 0.1,
      bounds: { minX: -8.713, maxX: 9.15, minY: -7.71, maxY: 8.749 },
      connections: [{ name: "A", pointsToConnect: [start, end] }],
      obstacles: Array.from({ length: index % 8 }, (_, n) => ({
        type: "rect",
        shape: n % 2 ? ("circle" as const) : undefined,
        center: { x: random() * 5 - 2.5, y: random() * 5 - 2.5 },
        width: 0.15 + random() * 0.3,
        height: 0.15 + random() * 0.3,
        layers: ["top"],
        connectedTo: [`obstacle${n}`],
        componentId: `package${n}`,
      })),
    }
    const scene = new VectorScene(
      input,
      input.connections[0],
      input.minTraceWidth,
      fixedCopper(input),
    )
    const soft: Copper[] =
      index % 3
        ? []
        : [
            {
              a: { x: start.x + 0.25, y: start.y - 1 },
              b: { x: start.x + 0.25, y: start.y + 1 },
              radius: 0.05,
              layer: "top",
              owners: ["B"],
            },
          ]
    const run = (limitLengthBounds: boolean) =>
      new GridVisibilitySearch(scene, start, end, soft, 10, undefined, {
        step,
        maxLength,
        paretoLength: true,
        checkReachability: true,
        allTerminalAttachments: true,
        limitLengthBounds,
      })
    expect(complete(run(true))).toEqual(complete(run(false)))
  }
})

test("the opt-in is inert for an unbounded, nearest-only or multi-terminal search", () => {
  const start: Point = { x: 0.013, y: -0.029 }
  const end: Point = { x: 1.017, y: 0.019 }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -5.113, maxX: 5.15, minY: -4.11, maxY: 4.119 },
    obstacles: [],
    connections: [
      {
        name: "A",
        pointsToConnect: [
          { ...start, layer: "top" },
          { ...end, layer: "top" },
        ],
      },
    ],
  }
  const scene = new VectorScene(input, input.connections[0], 0.1, [])
  for (const options of [
    {},
    { maxLength: Infinity },
    { maxLength: 2 },
    { maxLength: 2, starts: [start], ends: [end] },
  ]) {
    const a = new GridVisibilitySearch(
      scene,
      start,
      end,
      [],
      0,
      undefined,
      options,
    )
    const b = new GridVisibilitySearch(scene, start, end, [], 0, undefined, {
      ...options,
      limitLengthBounds: true,
    })
    expect(a.cellCount).toBe(b.cellCount)
    expect(complete(a)).toEqual(complete(b))
  }
})

test("clipping may reject an impossible long detour before expanding its finite-length frontier", () => {
  const start = { x: -0.5, y: 0, layer: "top" }
  const end = { x: 0.5, y: 0, layer: "top" }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -6, maxX: 6, minY: -6, maxY: 6 },
    connections: [{ name: "A", pointsToConnect: [start, end] }],
    obstacles: [
      {
        type: "rect",
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 8,
        layers: ["top"],
        connectedTo: ["wall"],
      },
    ],
  }
  const scene = new VectorScene(
    input,
    input.connections[0],
    0.1,
    fixedCopper(input),
  )
  const run = (limitLengthBounds: boolean) =>
    complete(
      new GridVisibilitySearch(scene, start, end, [], 0, undefined, {
        checkReachability: true,
        allTerminalAttachments: true,
        maxLength: 2,
        paretoLength: true,
        limitLengthBounds,
      }),
    )
  const original = run(false)
  const candidate = run(true)
  // Both legal bypasses pass |y| > 4 mm, outside the immutable 2 mm budget.
  // Work counts may fall when the clipped occupancy graph proves disconnection.
  expect(original).toMatchObject({ solved: false, failed: true, route: [] })
  expect(candidate).toMatchObject({ solved: false, failed: true, route: [] })
  expect(candidate.expanded).toBeLessThan(original.expanded)
})

test("clipping retains the original dense-grid work guard", () => {
  const start = { x: 0, y: 0, layer: "top" }
  const end = { x: 0.5, y: 0, layer: "top" }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.01,
    bounds: { minX: -20, maxX: 20, minY: -20, maxY: 20 },
    connections: [{ name: "A", pointsToConnect: [start, end] }],
    obstacles: [],
  }
  const scene = new VectorScene(input, input.connections[0], 0.01, [])
  for (const limitLengthBounds of [false, true])
    expect(
      () =>
        new GridVisibilitySearch(scene, start, end, [], 0, undefined, {
          maxLength: 1,
          allTerminalAttachments: true,
          limitLengthBounds,
        }),
    ).toThrow("Dense grid search budget exceeded")
})

test("clipping never reinterprets an existing full-grid congestion history", () => {
  const start = { x: 0.013, y: -0.029, layer: "top" }
  const end = { x: 1.017, y: 0.019, layer: "top" }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -5.113, maxX: 5.15, minY: -4.11, maxY: 4.119 },
    obstacles: [],
    connections: [{ name: "A", pointsToConnect: [start, end] }],
  }
  const scene = new VectorScene(input, input.connections[0], 0.1, [])
  const history = new Float32Array(11000)
  for (let index = 0; index < history.length; index++)
    history[index] = index % 17 === 0 ? 10 : 0
  const run = (limitLengthBounds: boolean) =>
    new GridVisibilitySearch(scene, start, end, [], 0, history, {
      maxLength: 2,
      paretoLength: true,
      allTerminalAttachments: true,
      limitLengthBounds,
    })
  const original = run(false)
  const candidate = run(true)
  expect(candidate.cellCount).toBe(original.cellCount)
  expect(complete(candidate)).toEqual(complete(original))
})

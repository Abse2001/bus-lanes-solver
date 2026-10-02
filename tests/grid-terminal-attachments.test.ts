import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { length } from "../lib/geometry"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { fixedCopper, VectorScene } from "../lib/vector-scene"
import { connectors } from "../lib/vector-visibility"
import type { SimpleRouteJson, Trace } from "../lib/types"

function pocket(reverse = false, sealedBoard = false) {
  // The nearest grid node is (0, 0). Its eight grid edges cross this pocket's
  // walls, but the exact off-grid terminal connector passes through the door.
  const walls = [
    [-0.2, -0.2, -0.2, 0.2],
    [-0.2, -0.2, 0.2, -0.2],
    [-0.2, 0.2, 0.2, 0.2],
    [0.2, -0.2, 0.2, 0.075],
    [0.2, 0.125, 0.2, 0.2],
    ...(sealedBoard ? [[1.5, -1, 1.5, 2]] : []),
  ]
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.01,
    minTraceToPadEdgeClearance: 0.01,
    bounds: { minX: -1, maxX: 3, minY: -1, maxY: 2 },
    obstacles: [],
    traces: walls.map(([ax, ay, bx, by], i) => ({
      type: "pcb_trace",
      pcb_trace_id: `wall_${i}`,
      connection_name: "WALL",
      route: [
        { x: ax, y: ay },
        { x: bx, y: by },
      ].map((p) => ({
        ...p,
        route_type: "wire",
        layer: "bottom",
        width: 0.01,
      })),
    })),
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: 0.3, y: 0.1, layer: "bottom" },
          { x: 2, y: 0, layer: "bottom" },
        ],
      },
      { name: "WALL", pointsToConnect: [] },
    ],
  }
  if (reverse) input.connections[0].pointsToConnect.reverse()
  const connection = input.connections[0]
  const scene = new VectorScene(input, connection, 0.01, fixedCopper(input))
  return { input, connection, scene }
}

function search(
  { scene, connection }: ReturnType<typeof pocket>,
  maxLength = Infinity,
) {
  return new GridVisibilitySearch(
    scene,
    connection.pointsToConnect[0],
    connection.pointsToConnect[1],
    [],
    0,
    undefined,
    { step: 1, maxLength },
  )
}

function solve(s: GridVisibilitySearch) {
  while (!s.solved && !s.failed) s.step()
  return s
}

function assertNativeDrc(
  input: SimpleRouteJson,
  path: GridVisibilitySearch["result"],
) {
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "signal_D",
    connection_name: "D",
    route: path.map((p) => ({
      ...p,
      route_type: "wire",
      layer: "bottom",
      width: input.minTraceWidth,
    })),
  }
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [...(input.traces ?? []), trace] },
      clearance: 0.01,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).issues,
  ).toEqual([])
}

for (const reverse of [false, true])
  test(`a grid-isolated nearest ${reverse ? "goal" : "start"} attachment falls back to another continuously clear connector`, () => {
    const fixture = pocket(reverse)
    const terminal = { x: 0.3, y: 0.1 }
    expect(
      connectors(terminal, { x: 0, y: 0 }).some((p) =>
        fixture.scene.pathVisible(p),
      ),
    ).toBe(true)
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) {
        if (!(x || y)) continue
        expect(fixture.scene.visible({ x: 0, y: 0 }, { x, y })).toBe(false)
      }
    const witness = connectors(terminal, { x: 1, y: 0 }).find((p) =>
      fixture.scene.pathVisible(p),
    )!
    expect(fixture.scene.pathVisible([...witness, { x: 2, y: 0 }])).toBe(true)
    assertNativeDrc(fixture.input, [...witness, { x: 2, y: 0 }])
    const s = solve(search(fixture))
    expect(s.solved).toBe(true)
    expect(s.result[0]).toEqual(fixture.connection.pointsToConnect[0])
    expect(s.result.at(-1)).toEqual(fixture.connection.pointsToConnect[1])
    expect(fixture.scene.pathVisible(s.result)).toBe(true)
    assertNativeDrc(fixture.input, s.result)
  })

test("alternate terminal connectors count toward the complete length budget", () => {
  const fixture = pocket()
  for (const maxLength of [1.74, 1.75]) {
    const s = solve(search(fixture, maxLength))
    expect(s.solved).toBe(maxLength === 1.75)
    if (s.solved) expect(length(s.result)).toBeLessThanOrEqual(maxLength + 1e-8)
  }
})

test("terminal alternatives cannot cross a continuous board-wide copper barrier", () => {
  const fixture = pocket(false, true)
  const s = solve(search(fixture))
  expect(s.failed).toBe(true)
  expect(s.solved).toBe(false)
  expect(s.result).toEqual([])
})

test("attachment retries preserve request-local scratch ownership after completion or cancellation", () => {
  const fixture = pocket()
  const complete = solve(search(fixture, 1.75))
  const expected = structuredClone(complete.result)
  const abandoned = search(fixture, 1.75)
  abandoned.cancel()
  const next = search(fixture, 1.75)
  complete.cancel()
  complete.step()
  abandoned.cancel()
  abandoned.step()
  expect(solve(next).result).toEqual(expected)
  expect(complete.result).toEqual(expected)
  expect(solve(search(pocket(), 1.75)).result).toEqual(expected)
})

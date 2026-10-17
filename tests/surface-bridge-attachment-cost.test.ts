import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeSurfaceBridge } from "../lib/route-surface-bridge"
import type { SimpleRouteJson, Trace } from "../lib/types"

function finish<T>(search: Generator<void, T>): T {
  let result = search.next(),
    yields = 0
  while (!result.done && yields++ < 10000) result = search.next()
  if (!result.done) throw Error("Attachment search exceeded its bound")
  return result.value
}

function attachmentFixture(wallX: number) {
  const wall: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "attachment_wall",
    connection_name: "wall",
    source_trace_id: "wall",
    route: [-0.2, 0.2].map((y) => ({
      x: wallX,
      y,
      layer: "top",
      width: 0.02,
      route_type: "wire",
    })),
  }
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.02,
    minTraceToPadEdgeClearance: 0.01,
    minViaPadDiameter: 0.1,
    minViaHoleDiameter: 0.05,
    bounds: { minX: -1, maxX: 1, minY: -0.6, maxY: 0.6 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -0.8, y: 0, layer: "top" },
          { x: 0.8, y: 0, layer: "top" },
        ],
      },
      {
        name: "wall",
        pointsToConnect: wall.route.map((point) => ({
          x: point.x,
          y: point.y,
          layer: "top",
        })),
      },
    ],
  }
  return { input, wall }
}

function clearOfWall(input: SimpleRouteJson, wall: Trace, trace: Trace) {
  return validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: [wall, trace] },
    clearance: 0.01,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0]).valid
}

test("coarse source and goal attachments pay soft-net costs before a complete route is accepted", () => {
  // Each wall lies inside the corresponding four-cell native attachment.
  for (const wallX of [-0.6, 0.6]) {
    const { input, wall } = attachmentFixture(wallX),
      before = structuredClone(input)
    for (const softPenalty of [0, 1000]) {
      const result = finish(
        routeSurfaceBridge(input, input.connections[0], {
          gridStep: 0.1,
          maxExpansions: 20000,
          maxLength: 3,
          softTraces: [wall],
          softPenalty,
          viaPenalty: 100,
        }),
      )
      expect(result).toBeTruthy()
      if (!result) throw Error("Expected a route around the attachment wall")
      const joined = joinSignalEscapes(result.carrier, result.escapes)
      expect(clearOfWall(input, wall, joined)).toBe(softPenalty > 0)
      expect(joined.route[0]).toMatchObject(
        input.connections[0].pointsToConnect[0],
      )
      expect(joined.route.at(-1)).toMatchObject(
        input.connections[0].pointsToConnect[1],
      )
      expect(joined.route.every((point) => point.route_type === "wire")).toBe(
        true,
      )
    }
    expect(input).toEqual(before)
  }
})

test("both native connectors pay congestion history and preserve the selected detour", () => {
  for (const wallX of [-0.6, 0.6]) {
    const { input, wall } = attachmentFixture(wallX),
      before = structuredClone(input),
      step = 0.1,
      columns = Math.floor((input.bounds.maxX - input.bounds.minX) / step) + 1,
      rows = Math.floor((input.bounds.maxY - input.bounds.minY) / step) + 1,
      top = new Float32Array(columns * rows),
      bottom = new Float32Array(columns * rows)
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++)
        if (
          Math.abs(input.bounds.minX + x * step - wallX) < step / 2 &&
          Math.abs(input.bounds.minY + y * step) <= 0.2 + 1e-8
        )
          top[x + y * columns] = 1000
    const originalHistory = top.slice()
    for (const history of [
      undefined,
      { bounds: input.bounds, step, values: [top, bottom] },
    ]) {
      const result = finish(
        routeSurfaceBridge(input, input.connections[0], {
          gridStep: step,
          maxExpansions: 20000,
          maxLength: 3,
          viaPenalty: 100,
          history,
        }),
      )
      expect(result).toBeTruthy()
      if (!result) throw Error("Expected a route around the history cells")
      const joined = joinSignalEscapes(result.carrier, result.escapes)
      expect(clearOfWall(input, wall, joined)).toBe(!!history)
      expect(joined.route.every((point) => point.route_type === "wire")).toBe(
        true,
      )
    }
    expect(top).toEqual(originalHistory)
    expect(input).toEqual(before)
  }
})

test("soft attachment preference preserves a shorter connector required by the full length budget", () => {
  const soft: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "movable_wall",
    connection_name: "wall",
    source_trace_id: "wall",
    route: [0, 0.08].map((y) => ({
      x: 0.04,
      y,
      layer: "top",
      width: 0.01,
      route_type: "wire",
    })),
  }
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.01,
    minTraceToPadEdgeClearance: 0.001,
    minViaPadDiameter: 0.1,
    minViaHoleDiameter: 0.05,
    bounds: { minX: -0.2, maxX: 1.3, minY: -0.2, maxY: 0.8 },
    obstacles: [
      {
        type: "rect",
        shape: "circle",
        center: { x: 0.06, y: 0.06 },
        width: 0.01,
        height: 0.01,
        layers: ["top"],
        connectedTo: ["hard_pad"],
      },
    ],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: 0.025, y: 0.025, layer: "top" },
          { x: 1.025, y: 0.525, layer: "top" },
        ],
      },
      {
        name: "wall",
        pointsToConnect: soft.route.map((point) => ({
          x: point.x,
          y: point.y,
          layer: "top",
        })),
      },
    ],
  }
  const original = structuredClone(input),
    maxLength = 1 + (Math.SQRT2 - 1) * 0.5
  // Every shortest route crosses the provisional wall. A longer native
  // connector can avoid it, but must not discard a physically feasible short
  // connector when the complete route has an exact copper-length budget.
  for (const softPenalty of [0, 1000]) {
    const result = finish(
      routeSurfaceBridge(input, input.connections[0], {
        gridStep: 0.1,
        maxExpansions: 50000,
        maxLength,
        softTraces: [soft],
        softPenalty,
        viaPenalty: 100,
      }),
    )
    expect(result).toBeTruthy()
    if (!result) throw Error("Soft copper must remain traversable")
    const joined = joinSignalEscapes(result.carrier, result.escapes)
    expect(length(joined.route)).toBeCloseTo(maxLength, 8)
    expect(joined.route[0]).toMatchObject(
      input.connections[0].pointsToConnect[0],
    )
    expect(joined.route.at(-1)).toMatchObject(
      input.connections[0].pointsToConnect[1],
    )
    expect(joined.route.every((point) => point.route_type === "wire")).toBe(
      true,
    )
    // Validate hard input separately: the crossing is provisional and cannot
    // weaken clearance to the fixed pad that blocks the direct diagonal.
    expect(
      validateRoutedCopperDrc({
        inputSrj: input,
        routedSrj: { ...input, traces: [joined] },
        clearance: 0.001,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
  }
  expect(input).toEqual(original)
})

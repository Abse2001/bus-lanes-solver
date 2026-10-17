import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  routeSurfaceBridge,
  type SurfaceBridgeOptions,
} from "../lib/route-surface-bridge"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { length } from "../lib/geometry"
import type { SimpleRouteJson } from "../lib"

function board(): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    bounds: { minX: -7, maxX: 7, minY: -2, maxY: 2 },
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -6, y: 0, layer: "top" },
          { x: 6, y: 0, layer: "top" },
        ],
      },
    ],
    buses: [
      {
        busId: "DATA",
        connectionNames: ["D"],
        preferredLayers: ["bottom", "top"],
      },
    ],
  }
}

function finish(input: SimpleRouteJson, options: SurfaceBridgeOptions = {}) {
  const search = routeSurfaceBridge(input, input.connections[0], {
    gridStep: 0.1,
    maxExpansions: 100000,
    ...options,
  })
  let step = search.next(),
    yields = 0
  while (!step.done && yields++ < 3000) step = search.next()
  expect(step.done).toBe(true)
  expect(step.value).toBeTruthy()
  return step.value!
}

test("existing Bottom preference favors short native approaches and a legal Bottom carrier", () => {
  const input = board(),
    original = structuredClone(input)
  // The physical length bound remains in millimeters, rather than being
  // multiplied by the nonpreferred-layer search cost.
  const result = finish(input, { maxLength: 12.000001 })
  const joined = joinSignalEscapes(result.carrier, result.escapes)
  expect(
    result.carrier.route.every(
      (point) => point.route_type === "wire" && point.layer === "bottom",
    ),
  ).toBe(true)
  expect(
    joined.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(2)
  expect(result.escapes.every((escape) => length(escape.route) <= 0.6)).toBe(
    true,
  )
  expect(length(joined.route)).toBeCloseTo(12, 8)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: { ...input, traces: [joined] },
      clearance: 0.05,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect(input).toEqual(original)
})

test("soft layer preferences fall back to Top when manufactured Bottom landings are blocked", () => {
  const input = board()
  input.obstacles.push({
    center: { x: 0, y: 0 },
    width: 14,
    height: 4,
    layers: ["bottom"],
    connectedTo: [],
  })
  const result = finish(input)
  const joined = joinSignalEscapes(result.carrier, result.escapes)
  expect(
    joined.route.every(
      (point) => point.route_type === "wire" && point.layer === "top",
    ),
  ).toBe(true)
  expect(length(joined.route)).toBeCloseTo(12, 8)
})

test("single preferredLayer takes precedence, forbidden hints stay forbidden, and one disables cost", () => {
  const input = board()
  const disabledResult = finish(input, { nonPreferredLayerCost: 1 })
  const disabled = joinSignalEscapes(
    disabledResult.carrier,
    disabledResult.escapes,
  )
  expect(
    disabled.route.every(
      (point) => point.route_type === "wire" && point.layer === "top",
    ),
  ).toBe(true)
  input.buses![0].preferredLayer = "top"
  const explicit = finish(input)
  expect(
    explicit.carrier.route.every(
      (point) => point.route_type === "wire" && point.layer === "top",
    ),
  ).toBe(true)
  delete input.buses![0].preferredLayer
  input.buses![0].allowedLayers = ["top"]
  const allowed = finish(input)
  expect(
    allowed.carrier.route.every(
      (point) => point.route_type === "wire" && point.layer === "top",
    ),
  ).toBe(true)
  for (const nonPreferredLayerCost of [0, -1, NaN, Infinity])
    expect(
      routeSurfaceBridge(input, input.connections[0], {
        nonPreferredLayerCost,
      }).next(),
    ).toEqual({ done: true, value: null })
})

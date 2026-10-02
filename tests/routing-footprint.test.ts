import { expect, test } from "bun:test"
import { measureRoutingFootprint } from "../scripts/measure-routing-footprint"
import type { SimpleRouteJson, Trace } from "../lib/types"

const input: SimpleRouteJson = {
  bounds: { minX: -30, maxX: 30, minY: -30, maxY: 30 },
  layerCount: 2,
  minTraceWidth: 0.1,
  minViaPadDiameter: 0.6,
  obstacles: [],
  connections: [],
}

test("footprints include wire and via radii, separated by copper layer", () => {
  const traces: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "a",
      route: [
        { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.2 },
        { route_type: "wire", x: 2, y: 0, layer: "top", width: 0.2 },
        {
          route_type: "via",
          x: 2,
          y: 0,
          from_layer: "top",
          to_layer: "bottom",
          via_diameter: 0.6,
        },
        { route_type: "wire", x: 2, y: 2, layer: "bottom", width: 0.4 },
      ],
    },
  ]
  const before = structuredClone(traces)
  const measured = measureRoutingFootprint(input, traces)
  expect(measured.bounds!.minX).toBeCloseTo(-0.1)
  expect(measured.bounds!.maxX).toBeCloseTo(2.3)
  expect(measured.bounds!.minY).toBeCloseTo(-0.3)
  expect(measured.bounds!.maxY).toBeCloseTo(2.2)
  expect(measured.bounds!.areaMm2).toBeCloseTo(6)
  expect(measured.layers.find((l) => l.layer === "top")!.areaMm2).toBeCloseTo(
    1.44,
  )
  expect(
    measured.layers.find((l) => l.layer === "bottom")!.areaMm2,
  ).toBeCloseTo(1.5)
  expect(measured.middleRegionMaxCenterOffsetMm).toBeNull()
  expect(traces).toEqual(before)
  expect(measureRoutingFootprint(input, []).bounds).toBeNull()
})

test("middle-region score follows package centers under translation and rotation", () => {
  for (const angle of [0, Math.PI / 2, Math.PI]) {
    const at = (x: number, y: number) => ({
      x: 42 + x * Math.cos(angle) - y * Math.sin(angle),
      y: -7 + x * Math.sin(angle) + y * Math.cos(angle),
    })
    const trace: Trace = {
      type: "pcb_trace",
      pcb_trace_id: "D",
      connection_name: "D",
      route: [at(0, 0), at(5, 3), at(10, 0)].map((p) => ({
        ...p,
        route_type: "wire",
        layer: "top",
        width: 0.1,
      })),
    }
    const board: SimpleRouteJson = {
      ...input,
      connections: [
        {
          name: "D",
          pointsToConnect: [trace.route[0], trace.route.at(-1)!].map((p) => ({
            ...p,
            layer: "top",
          })),
        },
      ],
      obstacles: [0, 10].map((x) => ({
        componentId: `U${x}`,
        center: at(x, 0),
        width: 2,
        height: 2,
        ccwRotationDegrees: (angle * 180) / Math.PI,
        layers: ["top"],
        connectedTo: ["D"],
      })),
    }
    expect(
      measureRoutingFootprint(board, [trace]).middleRegionMaxCenterOffsetMm,
    ).toBeCloseTo(3.05, 7)
  }
})

test("overall bounds retain immutable power copper outside the signal envelope", () => {
  const fixed: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "power",
    route: [
      { route_type: "wire", x: -5, y: -5, layer: "top", width: 0.2 },
      {
        route_type: "via",
        x: -4,
        y: -5,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.6,
      },
    ],
  }
  const signal: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "signal",
    route: [
      { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.1 },
      { route_type: "wire", x: 1, y: 1, layer: "top", width: 0.1 },
    ],
  }
  const board = { ...input, traces: [fixed] },
    before = structuredClone(board)
  const result = measureRoutingFootprint(board, [signal])
  expect(result.bounds!.areaMm2).toBeCloseTo(1.21)
  expect(result.allCopperBounds!.minX).toBeCloseTo(-5.1)
  expect(result.allCopperBounds!.minY).toBeCloseTo(-5.3)
  expect(result.allCopperBounds!.areaMm2).toBeCloseTo(6.15 * 6.35)
  expect(board).toEqual(before)
})

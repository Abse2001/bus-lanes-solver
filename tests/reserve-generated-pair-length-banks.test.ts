import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { offsetPath } from "../lib/coupled-pair-routing"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { pairLengthReports } from "../lib/route-lengths"
import { reserveGeneratedPairLengthBanks } from "../lib/reserve-generated-pair-length-banks"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

const width = 0.1016
const spacing = 0.2216
const wire = (point: Point, layer = "top"): Wire => ({
  ...point,
  route_type: "wire",
  layer,
  width,
})

function fixture(transform: (point: Point) => Point = (point) => point) {
  const centers = [
      { x: -3, y: 5 },
      { x: -2, y: 4 },
      { x: 2, y: 0 },
      { x: 3, y: -1 },
    ],
    nativeCenters = [
      { x: -3.5, y: 5.5 },
      { x: 3.5, y: -1.5 },
    ],
    retained: Trace[] = [],
    escapes: Trace[] = [],
    native: SimpleRouteJson = {
      layerCount: 4,
      allowedLayers: ["top", "bottom"],
      minTraceWidth: width,
      minTraceToPadEdgeClearance: 0.1016,
      minBoardEdgeClearance: 0.3,
      minViaPadDiameter: 0.4572,
      minViaHoleDiameter: 0.254,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
      allowBlindAndBuriedVias: false,
      bounds: { minX: -22, maxX: 22, minY: -22, maxY: 22 },
      obstacles: [],
      connections: [],
      differentialPairs: [
        {
          connectionNames: ["rail-0", "rail-1"],
          traceGap: 0.12,
          lengthTolerance: 0.127,
        },
      ],
      traces: [],
    }
  for (const rail of [0, 1]) {
    const name = `rail-${rail}`,
      offset = ((rail ? 1 : -1) * spacing) / 2,
      points = offsetPath(centers, offset).map(transform),
      pads = offsetPath(nativeCenters, offset).map(transform),
      trace: Trace = {
        type: "pcb_trace",
        pcb_trace_id: `generated-${name}`,
        connection_name: name,
        source_trace_id: `source-${name}`,
        route: points.map((point) => wire(point)),
        coupledSection: [1, 2],
        // This approach chord and its tangent endpoint must survive the new
        // shared bank; it lies outside the replaced diagonal interior.
        curvedSegments: [1],
      }
    retained.push(trace)
    native.connections.push({
      name,
      source_trace_id: `source-${name}`,
      pointsToConnect: pads.map((point, end) => ({
        ...point,
        layer: "top",
        pcb_port_id: `${name}-native-${end}`,
      })),
    })
    for (const end of [0, 1]) {
      native.obstacles.push({
        type: "rect",
        shape: "circle",
        componentId: `package-${end}`,
        center: pads[end],
        width: 0.05,
        height: 0.05,
        layers: ["top"],
        connectedTo: [name, `source-${name}`, `${name}-native-${end}`],
      })
      escapes.push({
        ...trace,
        pcb_trace_id: `owned-${name}-${end}`,
        coupledSection: undefined,
        curvedSegments: undefined,
        route: [
          {
            ...native.connections.at(-1)!.pointsToConnect[end],
            ...wire(pads[end]),
          },
          wire(points[end ? points.length - 1 : 0]),
        ],
      })
    }
  }
  const power = [
    transform({ x: -3.5, y: -1.2 }),
    transform({ x: -2.9, y: -1.2 }),
    transform({ x: -2.9, y: -1.8 }),
  ]
  native.connections.push({
    name: "power",
    pointsToConnect: [
      { ...power[0], layer: "top" },
      { ...power[2], layer: "bottom" },
    ],
  })
  native.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "supplied-power-fanout",
    connection_name: "power",
    route: [
      wire(power[0]),
      wire(power[1]),
      {
        ...power[1],
        route_type: "via",
        from_layer: "top",
        to_layer: "bottom",
        layers: ["top", "inner1", "inner2", "bottom"],
        via_diameter: 0.4572,
        via_hole_diameter: 0.254,
      },
      wire(power[1], "bottom"),
      wire(power[2], "bottom"),
    ],
  })
  return {
    native,
    retained,
    escapes,
    targets: new Map([
      ["rail-0", 30],
      ["rail-1", 30],
    ]),
  }
}

function complete(retained: Trace[], escapes: Trace[]) {
  return retained.map((trace) =>
    joinSignalEscapes(
      trace,
      escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
}

test("a long common bank preserves real native approaches, paired clearance and fixed fanout", () => {
  for (const transform of [
    (point: Point) => point,
    (point: Point) => ({ x: -point.y, y: point.x }),
    (point: Point) => ({ x: -point.x, y: -point.y }),
    (point: Point) => ({ x: point.y, y: -point.x }),
    (point: Point) => ({ x: -point.x, y: point.y }),
    (point: Point) => ({ x: point.x, y: -point.y }),
    (point: Point) => ({ x: point.y, y: point.x }),
    (point: Point) => ({ x: -point.y, y: -point.x }),
  ]) {
    const { native, retained, escapes, targets } = fixture(transform),
      before = structuredClone({ native, retained, escapes }),
      result = reserveGeneratedPairLengthBanks(
        native,
        retained,
        escapes,
        targets,
      )
    expect(result).toBeTruthy()
    if (!result) throw Error("Expected an open thirty-millimetre paired bank")
    const joined = complete(result.retained, result.escapes)
    expect(joined.every((trace) => length(trace.route) >= 30 - 1e-6)).toBe(true)
    expect(
      Math.abs(length(joined[0].route) - length(joined[1].route)),
    ).toBeLessThanOrEqual(0.127 + 1e-6)
    for (const [index, trace] of result.retained.entries()) {
      const old = retained[index],
        newStart = trace.coupledSection![0],
        newEnd = trace.coupledSection![1]
      expect(trace.route.slice(0, newStart + 1)).toEqual(old.route.slice(0, 2))
      expect(trace.route.slice(newEnd)).toEqual(old.route.slice(2))
      expect(trace.curvedSegments).toContain(1)
      expect(joined[index].route[0]).toMatchObject(
        native.connections[index].pointsToConnect[0],
      )
      expect(joined[index].route.at(-1)).toMatchObject(
        native.connections[index].pointsToConnect[1],
      )
    }
    expect(result.escapes).toEqual(escapes)
    expect(routeAnglesAreConventional(joined)).toBe(true)
    expect(
      pairLengthReports(native, joined).every((report) => report.matched),
    ).toBe(true)
    expect(
      exteriorPairSpacingReports(native, joined).every(
        (report) => report.applicable && report.matched,
      ),
    ).toBe(true)
    expect(
      validateRoutedCopperDrc({
        inputSrj: native,
        routedSrj: { ...native, traces: [...native.traces!, ...joined] },
        clearance: 0.1016,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
    expect({ native, retained, escapes }).toEqual(before)
  }
})

test("a paired bank cannot expand through fixed hard copper enclosing the original corridor", () => {
  const { native, retained, escapes, targets } = fixture()
  for (const [index, points] of [
    [
      { x: -21.5, y: 21.5 },
      { x: 21.5, y: -21.5 },
    ],
    [
      { x: -17.5, y: 21.5 },
      { x: 21.5, y: -17.5 },
    ],
  ].entries()) {
    const name = `fixed-boundary-${index}`
    native.connections.push({
      name,
      pointsToConnect: points.map((point) => ({ ...point, layer: "top" })),
    })
    native.traces!.push({
      type: "pcb_trace",
      pcb_trace_id: name,
      connection_name: name,
      route: points.map((point) => wire(point)),
    })
  }
  const before = structuredClone({ native, retained, escapes })
  // The original matched route remains a valid baseline between the walls.
  expect(
    validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: {
        ...native,
        traces: [...native.traces!, ...complete(retained, escapes)],
      },
      clearance: 0.1016,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect(
    reserveGeneratedPairLengthBanks(native, retained, escapes, targets),
  ).toBeNull()
  expect({ native, retained, escapes }).toEqual(before)
})

test("a paired length bank stays within the original board and refuses unachievable demand", () => {
  const { native, retained, escapes, targets } = fixture()
  native.bounds = { minX: -4.5, maxX: 4.5, minY: -2.5, maxY: 6.5 }
  const before = structuredClone({ native, retained, escapes })
  expect(
    reserveGeneratedPairLengthBanks(native, retained, escapes, targets),
  ).toBeNull()
  expect({ native, retained, escapes }).toEqual(before)
})

test("an annotated shared curve is preserved instead of being transported into a different bank", () => {
  const { native, retained, escapes, targets } = fixture()
  retained[0].curvedSegments = [1, 2]
  const before = structuredClone({ native, retained, escapes })
  expect(
    reserveGeneratedPairLengthBanks(native, retained, escapes, targets),
  ).toBeNull()
  expect({ native, retained, escapes }).toEqual(before)
})

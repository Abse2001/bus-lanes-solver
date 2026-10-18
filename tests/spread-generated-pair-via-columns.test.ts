import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { boardBoundaryReports } from "../lib/board-boundary"
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { surfaceBridgeSelfShorts } from "../lib/route-surface-bridge"
import { spreadGeneratedPairViaColumns } from "../lib/spread-generated-pair-via-columns"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"
import { fixedCopper, VectorScene } from "../lib/vector-scene"

function field(rotation = 0, scale = 1) {
  const transform = (point: Point) => {
    let { x, y } = point
    for (let i = 0; i < rotation; i++) [x, y] = [-y, x]
    return { x: scale * x + 7.173, y: scale * y - 2.049 }
  }
  const trace = (
    name: string,
    points: number[][],
    coupled: [number, number],
  ): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `generated-${name}`,
    connection_name: name,
    coupledSection: coupled,
    curvedSegments: [points.length - 1],
    route: points.map(([x, y]) => ({
      ...transform({ x, y }),
      route_type: "wire",
      layer: "top",
      width: scale * 0.1,
    })),
  })
  const retained = [
    trace(
      "rail-a",
      [
        [0, 4.4],
        [0.46, 4.4],
        [0.7, 4.16],
        [0.7, 3],
        [0.4, 2.7],
        [0.4, 2.5],
        [0.4, 1.5],
        [0.9, 1],
        [1.2, 1],
        [1.5, 0.7],
        [1.5, 0.4],
      ],
      [5, 6],
    ),
    trace(
      "rail-b",
      [
        [0, 3.6],
        [0, 2.7],
        [0.2, 2.5],
        [0.2, 1.5],
        [-0.3, 1],
        [-0.7, 1],
        [-1, 0.7],
        [-1, 0.4],
      ],
      [2, 3],
    ),
  ]
  const connections = [
    {
      name: "rail-a",
      points: [
        [-0.4, 4.8],
        [1.5, 0.4],
      ],
    },
    {
      name: "rail-b",
      points: [
        [-0.4, 4],
        [-1, 0.4],
      ],
    },
    {
      name: "ordinary-a",
      points: [
        [0.36, 3.2],
        [2.5, -0.5],
      ],
    },
    {
      name: "ordinary-b",
      points: [
        [0.36, 4],
        [2.5, -1],
      ],
    },
  ].map(({ name, points }) => ({
    name,
    pointsToConnect: points.map(([x, y]) => ({
      ...transform({ x, y }),
      layer: "top",
    })),
  }))
  const obstacles: SimpleRouteJson["obstacles"] = [
    ...connections.map((connection) => ({
      shape: "circle" as const,
      componentId: "package",
      center: connection.pointsToConnect[0],
      width: 0.36 * scale,
      height: 0.36 * scale,
      layers: ["top"],
      connectedTo: [connection.name],
    })),
    ...[3.2, 4].map((y, index) => ({
      shape: "circle" as const,
      componentId: "package",
      center: transform({ x: 1.16, y }),
      width: 0.36 * scale,
      height: 0.36 * scale,
      layers: ["top"],
      connectedTo: [`unrouted-pad-${index}`],
    })),
  ]
  const corners = [transform({ x: -3, y: -2 }), transform({ x: 4, y: 6 })]
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1 * scale,
    minTraceToPadEdgeClearance: 0.1 * scale,
    minViaPadDiameter: 0.4 * scale,
    minViaHoleDiameter: 0.2 * scale,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1 * scale,
    bounds: {
      minX: Math.min(...corners.map((point) => point.x)),
      maxX: Math.max(...corners.map((point) => point.x)),
      minY: Math.min(...corners.map((point) => point.y)),
      maxY: Math.max(...corners.map((point) => point.y)),
    },
    connections,
    obstacles,
    differentialPairs: [
      {
        connectionNames: ["rail-a", "rail-b"],
        traceGap: 0.1 * scale,
        lengthTolerance: 0.2 * scale,
      },
    ],
  }
  const escapes: Trace[] = retained.map((carrier, index) => ({
    type: "pcb_trace",
    pcb_trace_id: `native-approach-${index}`,
    connection_name: carrier.connection_name,
    route: [native.connections[index].pointsToConnect[0], carrier.route[0]].map(
      (point) => ({
        ...point,
        route_type: "wire",
        layer: "top",
        width: native.minTraceWidth,
      }),
    ),
  }))
  const joined = (traces: Trace[]) =>
    traces.map((carrier) =>
      joinSignalEscapes(
        carrier,
        escapes.filter(
          (escape) => escape.connection_name === carrier.connection_name,
        ),
      ),
    )
  return { native, retained, escapes, transform, joined }
}

test("length-neutral pair approaches open native via columns across package orientations", () => {
  for (const rotation of [0, 1, 2, 3])
    for (const scale of [1, 1.7]) {
      const { native, retained, escapes, transform, joined } = field(
        rotation,
        scale,
      )
      const before = JSON.stringify({ native, retained, escapes })
      const via = transform({ x: 0.36, y: 3.3 })
      const visible = (traces: Trace[]) => {
        const input = { ...native, traces: joined(traces) }
        const copper = fixedCopper(input)
        return ["top", "inner1", "inner2", "bottom"].every((layer) =>
          new VectorScene(
            input,
            {
              ...native.connections[2],
              pointsToConnect: native.connections[2].pointsToConnect.map(
                (point) => ({ ...point, layer }),
              ),
            },
            native.minViaPadDiameter!,
            copper,
          ).visible(via, via),
        )
      }
      expect(visible(retained)).toBe(false)
      const result = spreadGeneratedPairViaColumns(native, retained)
      expect(result[0]).not.toBe(retained[0])
      expect(visible(result)).toBe(true)
      for (let index = 0; index < retained.length; index++) {
        expect(length(result[index].route)).toBeCloseTo(
          length(retained[index].route),
          10,
        )
        expect(result[index].coupledSection).toEqual(
          retained[index].coupledSection,
        )
        expect(result[index].curvedSegments).toEqual(
          retained[index].curvedSegments,
        )
        expect(
          result[index].route.slice(retained[index].coupledSection![0]),
        ).toEqual(
          retained[index].route.slice(retained[index].coupledSection![0]),
        )
        expect(result[index].route[0]).toEqual(retained[index].route[0])
        expect(result[index].route.at(-1)).toEqual(retained[index].route.at(-1))
        expect(
          surfaceBridgeSelfShorts(
            native,
            native.connections[index],
            result[index],
          ),
        ).toBe(false)
      }
      const complete = joined(result)
      expect(
        validateRoutedCopperDrc({
          inputSrj: native,
          routedSrj: { ...native, traces: complete },
          clearance: native.minTraceToPadEdgeClearance!,
          allowBlindAndBuriedVias: false,
        } as Parameters<typeof validateRoutedCopperDrc>[0]).issues,
      ).toEqual([])
      expect(routeAnglesAreConventional(complete)).toBe(true)
      expect(boardBoundaryReports(native, complete).valid).toBe(true)
      expect(JSON.stringify({ native, retained, escapes })).toBe(before)
    }
})

test("opposite-end approaches preserve sampled curves and open an outer pad column", () => {
  for (const rotation of [0, 1, 3]) {
    const { native, retained, escapes, transform, joined } = field(
      rotation,
      1.4,
    )
    native.obstacles = native.obstacles.filter(
      (obstacle) =>
        !obstacle.connectedTo.some((owner) =>
          owner.startsWith("unrouted-pad-"),
        ),
    )
    const reversed = retained.map((trace) => ({
      ...trace,
      route: trace.route.toReversed(),
      coupledSection: [
        trace.route.length - 1 - trace.coupledSection![1],
        trace.route.length - 1 - trace.coupledSection![0],
      ] as [number, number],
      curvedSegments: trace
        .curvedSegments!.map((index) => trace.route.length - index)
        .sort((a, b) => a - b),
    }))
    const before = JSON.stringify({ native, reversed, escapes })
    const result = spreadGeneratedPairViaColumns(native, reversed)
    expect(result[0]).not.toBe(reversed[0])
    for (const [index, trace] of result.entries()) {
      const original = reversed[index],
        [first, last] = original.coupledSection
      expect(trace.route.slice(first, last + 1)).toEqual(
        original.route.slice(first, last + 1),
      )
      expect(trace.curvedSegments).toEqual(original.curvedSegments)
      for (const curve of original.curvedSegments)
        expect(trace.route.slice(curve - 1, curve + 1)).toEqual(
          original.route.slice(curve - 1, curve + 1),
        )
      expect(length(trace.route)).toBeCloseTo(length(original.route), 10)
    }
    const complete = joined(result),
      input = { ...native, traces: complete }
    const via = transform({ x: 0.36, y: 3.3 }),
      copper = fixedCopper(input)
    for (const layer of ["top", "inner1", "inner2", "bottom"])
      expect(
        new VectorScene(
          input,
          {
            ...native.connections[2],
            pointsToConnect: native.connections[2].pointsToConnect.map(
              (point) => ({ ...point, layer }),
            ),
          },
          native.minViaPadDiameter!,
          copper,
        ).visible(via, via),
      ).toBe(true)
    expect(
      validateRoutedCopperDrc({
        inputSrj: native,
        routedSrj: input,
        clearance: native.minTraceToPadEdgeClearance!,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
    ).toBe(true)
    expect(routeAnglesAreConventional(complete)).toBe(true)
    expect(JSON.stringify({ native, reversed, escapes })).toBe(before)
  }
})

test("blocking copper and inner-layer via obstacles retain the original pair", () => {
  for (const inner of [false, true]) {
    const { native, retained, transform } = field()
    native.obstacles.push(
      inner
        ? {
            center: transform({ x: 0.36, y: 3.6 }),
            width: 0.1,
            height: 1.2,
            layers: ["inner1"],
            connectedTo: ["buried-obstacle"],
          }
        : {
            shape: "circle",
            center: transform({ x: 1.005, y: 3.5 }),
            width: 0.3,
            height: 0.3,
            layers: ["top"],
            connectedTo: ["blocking-copper"],
          },
    )
    const before = JSON.stringify({ native, retained })
    expect(spreadGeneratedPairViaColumns(native, retained)).toEqual(retained)
    expect(JSON.stringify({ native, retained })).toBe(before)
  }
})

test("supplied fanout and sampled prefix curves are ineligible", () => {
  for (const mode of ["fixed-id", "fixed-connection", "curved-prefix"]) {
    const { native, retained } = field()
    if (mode === "curved-prefix") retained[0].curvedSegments!.push(2)
    else {
      native.traces = [structuredClone(retained[0])]
      if (mode === "fixed-connection")
        native.traces[0].pcb_trace_id = "supplied-fanout-with-another-id"
    }
    const before = JSON.stringify({ native, retained })
    expect(spreadGeneratedPairViaColumns(native, retained)).toEqual(retained)
    expect(JSON.stringify({ native, retained })).toBe(before)
  }
})

test("a concave outline blocks a tentative widening without changing input copper", () => {
  const { native, retained, transform } = field()
  native.outline = [
    [-3, -2],
    [4, -2],
    [4, 3.45],
    [0.755, 3.45],
    [0.755, 3.55],
    [4, 3.55],
    [4, 6],
    [-3, 6],
  ].map(([x, y]) => transform({ x, y }))
  expect(boardBoundaryReports(native, retained).valid).toBe(true)
  expect(spreadGeneratedPairViaColumns(native, retained)).toEqual(retained)
})

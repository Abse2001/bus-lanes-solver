import { expect, test } from "bun:test"
import {
  physicalRoutingAcceptance,
  type PhysicalRoutingAcceptanceReport,
} from "../lib/physical-routing-acceptance"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const wire = (x: number, y: number, layer = "top"): Wire => ({
  route_type: "wire",
  x,
  y,
  layer,
  width: 0.1,
})

function fixture() {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -2, maxX: 12, minY: -2, maxY: 5 },
    obstacles: [],
    connections: [0, 2].map((y) => ({
      name: `D${y}`,
      pointsToConnect: [
        { x: 0, y, layer: "top" },
        { x: 10, y, layer: "top" },
      ],
    })),
    buses: [
      {
        busId: "DATA",
        connectionNames: ["D0", "D2"],
        maxLengthSkew: 0.01,
        minLength: 20,
        maxLength: 5,
      },
    ],
  }
  const traces: Trace[] = [0, 2].map((y) => ({
    type: "pcb_trace",
    pcb_trace_id: `joined-${y}`,
    connection_name: `D${y}`,
    route: [wire(0, y), wire(10, y)],
  }))
  return { input, traces }
}

test("complete clear routes pass physical acceptance while impossible bus limits fail timing", () => {
  const { input, traces } = fixture()
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed",
      connection_name: "D0",
      route: [wire(-1, 0), wire(0, 0)],
    },
  ]
  const before = structuredClone(input)
  const report: PhysicalRoutingAcceptanceReport = physicalRoutingAcceptance(
    input,
    traces,
  )
  expect(report.physicalRoutingAccepted).toBe(true)
  expect(report.ddrTimingAccepted).toBe(false)
  expect(report.buses[0]).toMatchObject({
    aboveMinimumLength: false,
    withinLengthLimit: false,
  })
  expect(report.buses[0].lengths[0].totalLengthMm).toBe(11)
  expect(report.connectedSignals).toBe(2)
  expect(report.output.traces![0]).toBe(input.traces[0])
  expect(report.output.connections).toBe(input.connections)
  expect(input).toEqual(before)
})

test("partial, duplicate, unexpected and broken exact endpoints reject", () => {
  const { input, traces } = fixture()
  expect(
    physicalRoutingAcceptance(input, traces.slice(1)).physicalRoutingAccepted,
  ).toBe(false)
  expect(
    physicalRoutingAcceptance(input, [...traces, traces[0]]).duplicateSignals,
  ).toEqual(["D0"])
  expect(
    physicalRoutingAcceptance(input, [
      ...traces,
      { ...traces[0], connection_name: "foreign" },
    ]).physicalRoutingAccepted,
  ).toBe(false)
  const broken = structuredClone(traces)
  broken[0].route[0].x = 1e-10
  expect(physicalRoutingAcceptance(input, broken).missingSignals).toEqual([
    "D0",
  ])
})

test("unrelated supplied copper keeps its owner and remains in the native DRC audit", () => {
  const { input, traces } = fixture()
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed-power",
      connection_name: "VCC",
      route: [wire(0, 4), wire(10, 4)],
    },
  ]
  const before = structuredClone(input)
  const clear = physicalRoutingAcceptance(input, traces)
  expect(clear.physicalRoutingAccepted).toBe(true)
  expect(clear.nativeDrc.checkedTraceCount).toBe(3)
  expect(clear.output.traces![0]).toBe(input.traces[0])
  expect(input).toEqual(before)
  input.traces[0].route = [wire(5, -1), wire(5, 4)]
  const collision = physicalRoutingAcceptance(input, traces)
  expect(collision.gates.originalFixedCopperPreserved).toBe(true)
  expect(collision.nativeDrc.valid).toBe(false)
  expect(
    collision.nativeDrc.issues.some(
      (issue) =>
        issue.connectionName === "VCC" || issue.otherConnectionName === "VCC",
    ),
  ).toBe(true)
  expect(collision.physicalRoutingAccepted).toBe(false)
})

test("a native foreign copper short rejects despite complete connectivity", () => {
  const { input, traces } = fixture()
  input.connections[1].pointsToConnect = [
    { x: 5, y: -1, layer: "top" },
    { x: 5, y: 3, layer: "top" },
  ]
  traces[1].route = [wire(5, -1), wire(5, 3)]
  const report = physicalRoutingAcceptance(input, traces)
  expect(report.connectedSignals).toBe(2)
  expect(report.nativeDrc.valid).toBe(false)
  expect(
    report.nativeDrc.issues.some(
      (issue) => issue.code === "different-net-trace-clearance",
    ),
  ).toBe(true)
  expect(report.physicalRoutingAccepted).toBe(false)
})

test("hard differential pair length skew is required even when bus timing is relaxed", () => {
  const { input, traces } = fixture()
  input.connections[1].pointsToConnect[1].x = 9
  traces[1].route[1].x = 9
  input.differentialPairs = [
    { connectionNames: ["D0", "D2"], lengthTolerance: 0.01 },
  ]
  const report = physicalRoutingAcceptance(input, traces)
  expect(report.nativeDrc.valid).toBe(true)
  expect(report.gates.differentialPairsMatched).toBe(false)
  expect(report.physicalRoutingAccepted).toBe(false)
})

test("exact escape paths preserve reversed via directions and curve chord permissions", () => {
  const { input, traces } = fixture()
  // The default policy also requires full-stack physical lands.
  input.minViaPadDiameter = 0.3
  input.minViaHoleDiameter = 0.15
  traces[0].route = [
    wire(0, 0),
    wire(1, 0),
    {
      route_type: "via",
      x: 1,
      y: 0,
      from_layer: "top",
      to_layer: "bottom",
      layers: ["top", "bottom"],
      via_diameter: 0.3,
      via_hole_diameter: 0.15,
    },
    wire(1, 0, "bottom"),
    wire(9, 0, "bottom"),
    {
      route_type: "via",
      x: 9,
      y: 0,
      from_layer: "bottom",
      to_layer: "top",
      layers: ["top", "bottom"],
      via_diameter: 0.3,
      via_hole_diameter: 0.15,
    },
    wire(9, 0),
    wire(10, 0),
  ]
  traces[0].curvedSegments = [1]
  const escape: Trace = {
    ...traces[0],
    pcb_trace_id: "escape",
    route: traces[0].route
      .slice(0, 4)
      .toReversed()
      .map((p) =>
        p.route_type === "via"
          ? { ...p, from_layer: p.to_layer, to_layer: p.from_layer }
          : p,
      ),
    curvedSegments: [3],
  }
  const beforeEscape = structuredClone(escape)
  const report = physicalRoutingAcceptance(input, traces, { escapes: [escape] })
  expect(report.physicalRoutingAccepted).toBe(true)
  expect(report.escapes).toEqual([escape])
  expect(report.escapes[0]).not.toBe(escape)
  expect(escape).toEqual(beforeEscape)
  const noPermission = structuredClone(traces)
  noPermission[0].curvedSegments = []
  expect(
    physicalRoutingAcceptance(input, noPermission, { escapes: [escape] })
      .escapesPreserved,
  ).toBe(false)
  const mutated = structuredClone(traces)
  mutated[0].route[2] = {
    ...mutated[0].route[2],
    via_diameter: 0.31,
  } as Trace["route"][number]
  expect(
    physicalRoutingAcceptance(input, mutated, { escapes: [escape] })
      .escapesPreserved,
  ).toBe(false)
})

test("non-finite coordinates, narrow wires, illegal layers and incomplete full-stack lands reject", () => {
  for (const mutate of [
    (t: Trace) => {
      t.route[0].x = NaN
    },
    (t: Trace) => {
      ;(t.route[0] as Wire).width = 0.09
    },
    (t: Trace) => {
      ;(t.route[0] as Wire).layer = "inner1"
    },
  ]) {
    const { input, traces } = fixture()
    mutate(traces[0])
    expect(
      physicalRoutingAcceptance(input, traces).physicalRoutingAccepted,
    ).toBe(false)
  }
  const { input, traces } = fixture()
  input.layerCount = 4
  input.allowBlindAndBuriedVias = false
  traces[0].route.splice(1, 0, {
    route_type: "via",
    x: 0,
    y: 0,
    from_layer: "top",
    to_layer: "bottom",
    layers: ["top", "bottom"],
  })
  expect(physicalRoutingAcceptance(input, traces).gates.viaRulesValid).toBe(
    false,
  )
})

test("drill spacing includes immutable fixed vias", () => {
  const { input, traces } = fixture()
  input.minViaHoleEdgeToViaHoleEdgeClearance = 0.2
  const via = {
    route_type: "via" as const,
    x: 1,
    y: 0,
    from_layer: "top",
    to_layer: "bottom",
    via_diameter: 0.3,
    via_hole_diameter: 0.15,
  }
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed-via",
      connection_name: "D0",
      route: [wire(1, 0), via, wire(1, 0, "bottom")],
    },
  ]
  traces[0].route.splice(
    1,
    0,
    wire(1.3, 0),
    { ...via, x: 1.3 },
    wire(1.3, 0, "bottom"),
    wire(9, 0, "bottom"),
    { ...via, x: 9, from_layer: "bottom", to_layer: "top" },
    wire(9, 0),
  )
  expect(physicalRoutingAcceptance(input, traces).gates.drillSpacingValid).toBe(
    false,
  )
})

test("native self-short check detects a bypass in an otherwise connected signal", () => {
  const { input, traces } = fixture()
  traces[0].route = [
    wire(0, 0),
    wire(4, 0),
    wire(5, 1),
    wire(5, 2),
    wire(4, 3),
    wire(3, 3),
    wire(2, 2),
    wire(2, 1),
    wire(3, 0),
    wire(10, 0),
  ]
  const report = physicalRoutingAcceptance(input, traces)
  expect(report.selfShorts.length).toBeGreaterThan(0)
  expect(report.gates.zeroSelfShorts).toBe(false)
  expect(report.physicalRoutingAccepted).toBe(false)
})

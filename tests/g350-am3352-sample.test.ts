import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import circuit from "./fixtures/g350-am3352/circuit.json"
import connections from "./fixtures/g350-am3352/memory-byte1-top-centered-swizzled-connections.json"
import cpuMap from "./fixtures/g350-am3352/cpu-ball-map.json"
import ramMap from "./fixtures/g350-am3352/ram-ball-map.json"
import {
  g350Am3352Metadata as metadata,
  loadG350Am3352CompleteInput,
  loadG350Am3352Sample,
} from "../scripts/g350-am3352-sample"
import { validateG350Am3352Sample } from "../scripts/validate-g350-am3352-sample"
import type { SimpleRouteJson, Trace, Wire } from "../lib"

// The imported circuit contains heterogeneous records. Narrow by record type
// below while retaining the original JSON field names and numeric pin numbers.
const records = circuit as unknown as Array<Record<string, any>>
const ofType = (type: string) => records.filter((e) => e.type === type)

test("G350 capture is hash indexed and independent of the board checkout", () => {
  const directory = join(dirname(import.meta.path), "fixtures/g350-am3352")
  for (const [file, hash] of Object.entries(metadata.filesSha256))
    expect(
      createHash("sha256")
        .update(readFileSync(join(directory, file)))
        .digest("hex"),
    ).toBe(hash)
  const input = loadG350Am3352Sample()
  input.connections[0].pointsToConnect[0].x += 1
  expect(loadG350Am3352Sample().connections[0].pointsToConnect[0].x).not.toBe(
    input.connections[0].pointsToConnect[0].x,
  )
})

test("all real BGA and support pads survive, including unused and NC balls", () => {
  const input = loadG350Am3352Sample()
  expect(ofType("source_component")).toHaveLength(194)
  expect(ofType("pcb_smtpad")).toHaveLength(854)
  expect(input.obstacles).toHaveLength(854)
  for (const [name, map, count, diameter] of [
    ["U_SOC", cpuMap, 324, 0.4],
    ["U_RAM", ramMap, 96, 0.42],
  ] as const) {
    const component = ofType("source_component").find((e) => e.name === name)!
    const pcb = ofType("pcb_component").find(
      (e) => e.source_component_id === component.source_component_id,
    )!
    const ports = ofType("source_port").filter(
      (e) => e.source_component_id === component.source_component_id,
    )
    expect(ports).toHaveLength(count)
    expect(new Set(ports.map((p) => p.name))).toEqual(
      new Set(Object.keys(map.pins)),
    )
    const pads = input.obstacles.filter(
      (o) => o.componentId === pcb.pcb_component_id,
    )
    expect(pads).toHaveLength(count)
    expect(
      pads.every(
        (o) =>
          o.shape === "circle" &&
          Math.abs(o.width - diameter) < 1e-7 &&
          o.layers[0] === "top",
      ),
    ).toBe(true)
  }
  const names = ofType("source_component").map((e) => e.name as string)
  expect(names.filter((n) => n.startsWith("C_"))).toHaveLength(125)
  for (const required of [
    "U_PMIC",
    "U_POR",
    "R_CPU_POR",
    "U_SD_REG",
    "C_POR_BYPASS",
    "C_POR_SENSE",
    "U_IO_BOOST",
    "X_MAIN",
    "R_XTAL_DAMP",
    "SW_RESET",
    "R_VREF_HI",
    "R_VREF_LO",
    "R_DDR_ZQ",
    "R_DDR_VTP",
    "C_VREF_CPU",
    "C_VREF_RAM_CA",
    "C_VREF_RAM_DQ",
    "C_DDR_CPU_BULK1",
    "C_DDR_CPU_BULK2",
    "C_DDR_RAM_BULK1",
    "C_DDR_RAM_BULK2",
  ])
    expect(names).toContain(required)
  expect(input.traces).toEqual([])
})

test("49 signals terminate at the actual swizzled numeric CPU and RAM pins", () => {
  const input = loadG350Am3352Sample()
  const sourcePorts = new Map(
    ofType("source_port").map((p) => [p.source_port_id, p]),
  )
  const pcbPorts = new Map(ofType("pcb_port").map((p) => [p.pcb_port_id, p]))
  const traces = ofType("source_trace")
  expect(input.connections).toHaveLength(49)
  expect(connections).toHaveLength(49)
  for (const mapping of connections) {
    const trace = traces.find((t) => t.name === mapping.name)!
    const connection = input.connections.find(
      (c) => c.source_trace_id === trace.source_trace_id,
    )!
    expect(connection.pointsToConnect).toHaveLength(2)
    for (const [index, pin, ball] of [
      [0, mapping.socPin, mapping.socBall],
      [1, mapping.ramPin, mapping.ramBall],
    ] as const) {
      const source = sourcePorts.get(trace.connected_source_port_ids[index])!
      expect(source.pin_number).toBe(Number(pin.slice(3)))
      expect(source.name).toBe(ball)
      const terminal = connection.pointsToConnect[index]
      const port = pcbPorts.get(terminal.pcb_port_id!)!
      expect(port.source_port_id).toBe(source.source_port_id)
      expect(terminal.x).toBe(port.x)
      expect(terminal.y).toBe(port.y)
      expect(terminal.layer).toBe("top")
    }
  }
})

test("power, ground, VREF, calibration, clock and reset connectivity is retained", () => {
  const complete = loadG350Am3352CompleteInput()
  expect(complete.connections).toHaveLength(117)
  const terminals = new Set(
    complete.connections.flatMap((c) =>
      c.pointsToConnect.map((p) => p.pcb_port_id),
    ),
  )
  for (const source of ofType("source_port").filter(
    (p) => p.requires_power || p.requires_ground,
  )) {
    const pcb = ofType("pcb_port").find(
      (p) => p.source_port_id === source.source_port_id,
    )!
    expect(terminals.has(pcb.pcb_port_id)).toBe(true)
  }
  for (const name of [
    "GND",
    "DDR_1V5",
    "DDR_VREF",
    "DDR_ZQ",
    "DDR_VTP",
    "VDD_MPU",
    "VDD_CORE",
    "VDDS_1V8",
    "ANALOG_1V8",
    "IO_3V3",
    "CPU_PORn",
    "RTC_PORn",
    "XTAL_IN",
    "XTAL_OUT",
    "XTAL_DRIVE",
  ]) {
    const net = ofType("source_net").find((n) => n.name === name)!
    expect(
      complete.connections.find((c) => c.name === net.source_net_id)
        ?.pointsToConnect.length,
    ).toBeGreaterThanOrEqual(2)
  }
  const ram = ofType("source_component").find((c) => c.name === "U_RAM")!
  const ramPorts = ofType("source_port").filter(
    (p) => p.source_component_id === ram.source_component_id,
  )
  expect(ramPorts.filter((p) => p.requires_power)).toHaveLength(18)
  expect(ramPorts.filter((p) => p.requires_ground)).toHaveLength(21)
  expect(ramPorts.filter((p) => p.do_not_connect)).toHaveLength(5)
})

test("four layers, all buses and all differential matching rules remain mandatory", () => {
  const input = loadG350Am3352Sample()
  expect(input.layerCount).toBe(4)
  expect(input.allowedLayers).toEqual(["top", "bottom"])
  expect(input.allowBlindAndBuriedVias).toBe(false)
  expect(input.minTraceWidth).toBe(0.1016)
  expect(input.minTraceToPadEdgeClearance).toBe(0.1016)
  expect(input.minViaPadDiameter).toBe(0.4572)
  expect(input.minViaHoleDiameter).toBe(0.254)
  expect(input.minViaHoleEdgeToViaHoleEdgeClearance).toBe(0.254)
  expect(input.buses?.map((b) => b.connectionNames.length)).toEqual([
    1, 11, 11, 26,
  ])
  expect(input.buses?.slice(1).map((b) => b.maxLengthSkew)).toEqual([
    0.635, 0.635, 0.635,
  ])
  expect(new Set(input.buses?.flatMap((b) => b.connectionNames))).toEqual(
    new Set(input.connections.map((c) => c.name)),
  )
  expect(input.differentialPairs).toHaveLength(3)
  expect(
    input.differentialPairs?.every(
      (p) => p.lengthTolerance === 0.127 && p.traceGap === 0.12,
    ),
  ).toBe(true)
  const report = validateG350Am3352Sample(input, { ...input, traces: [] })
  expect(report.valid).toBe(false)
  expect(report.complete).toBe(false)
  expect(report.connectedSignals).toBe(0)
  expect(report.matched).toBe(false)
  expect(report.missingSignals).toHaveLength(49)
})

test("49 straight connections through foreign BGA pads cannot count as a routing pass", () => {
  const input = loadG350Am3352Sample()
  const output = {
    ...input,
    traces: input.connections.map((connection, i) => ({
      type: "pcb_trace" as const,
      pcb_trace_id: `synthetic_${i}`,
      connection_name: connection.name,
      source_trace_id: connection.source_trace_id,
      route: connection.pointsToConnect.map((point) => ({
        route_type: "wire" as const,
        x: point.x,
        y: point.y,
        layer: point.layer,
        width: 0.1016,
      })),
    })),
  }
  const report = validateG350Am3352Sample(input, output)
  expect(report.connectedSignals).toBe(49)
  expect(report.complete).toBe(true)
  expect(report.drc.valid).toBe(false)
  expect(report.valid).toBe(false)
  expect(report.fabricationReady).toBe(false)
})

// Small copper examples isolate the independent acceptance checks from routing
// and preserve the full, hash-indexed G350 capture above.
const acceptanceWire = (x: number, y: number, layer = "top"): Wire => ({
  route_type: "wire",
  x,
  y,
  layer,
  width: 0.1016,
})
const acceptanceVia = (x: number, y: number, from = "top", to = "bottom") => ({
  route_type: "via" as const,
  x,
  y,
  from_layer: from,
  to_layer: to,
  layers: ["top", "inner1", "inner2", "bottom"],
  via_diameter: 0.4572,
  via_hole_diameter: 0.254,
})
function copperAcceptance(
  route: Trace["route"],
  obstacles: SimpleRouteJson["obstacles"] = [],
  board: Partial<
    Pick<SimpleRouteJson, "outline" | "minBoardEdgeClearance">
  > = {},
) {
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
    minTraceWidth: 0.1016,
    minTraceToPadEdgeClearance: 0.1016,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    obstacles,
    connections: [
      {
        name: "CONTROL",
        pointsToConnect: [acceptanceWire(0, 0), acceptanceWire(4, 0)],
      },
    ],
    buses: [],
    differentialPairs: [],
    traces: [],
    ...board,
  }
  const output: SimpleRouteJson = {
    ...input,
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "control",
        connection_name: "CONTROL",
        source_trace_id: "CONTROL",
        route,
      },
    ],
  }
  const before = structuredClone(input)
  const report = validateG350Am3352Sample(input, output)
  expect(input).toEqual(before)
  return report
}

test("G350 acceptance rejects non-finite or undersized copper independently of DRC", () => {
  expect(
    copperAcceptance([acceptanceWire(0, 0), acceptanceWire(4, 0)]).valid,
  ).toBe(true)
  for (const point of [
    { ...acceptanceWire(2, 0), x: Number.NaN },
    { ...acceptanceWire(2, 0), y: Number.POSITIVE_INFINITY },
    { ...acceptanceWire(2, 0), width: Number.NaN },
    { ...acceptanceWire(2, 0), width: Number.POSITIVE_INFINITY },
    { ...acceptanceWire(2, 0), width: 0.01 },
  ]) {
    const report = copperAcceptance([
      acceptanceWire(0, 0),
      point,
      acceptanceWire(4, 0),
    ])
    expect(report.complete).toBe(true)
    expect(report.routeGeometryValid).toBe(false)
    expect(report.valid).toBe(false)
  }
})

test("G350 acceptance detects same-net shortcuts on untimed controls", () => {
  const report = copperAcceptance([
    acceptanceWire(0, 0),
    acceptanceWire(4, 4),
    acceptanceWire(0, 4),
    acceptanceWire(4, 0),
  ])
  expect(report.complete).toBe(true)
  expect(report.drc.valid).toBe(true)
  expect(report.matched).toBe(true)
  expect(report.selfShorts).not.toHaveLength(0)
  expect(report.valid).toBe(false)
})

test("G350 acceptance requires drill spacing even between vias on the same net", () => {
  const viaRoute = (secondX: number): Trace["route"] => [
    acceptanceWire(0, 0),
    acceptanceWire(1, 1),
    acceptanceVia(1, 1),
    acceptanceWire(1, 1, "bottom"),
    acceptanceWire(secondX, 1, "bottom"),
    acceptanceVia(secondX, 1, "bottom", "top"),
    acceptanceWire(secondX, 1),
    acceptanceWire(4, 0),
  ]
  expect(copperAcceptance(viaRoute(2)).valid).toBe(true)
  const report = copperAcceptance(viaRoute(1.5))
  expect(report.drc.valid).toBe(true)
  expect(report.drillSpacingValid).toBe(false)
  expect(report.valid).toBe(false)
})

test("G350 acceptance rejects incorrect via dimensions and partial layer spans", () => {
  for (const change of [
    { via_diameter: 0.3 },
    { via_hole_diameter: 0.2 },
    { layers: ["top", "bottom"] },
    { from_layer: "inner1" },
    { to_layer: "top" },
  ]) {
    const report = copperAcceptance([
      acceptanceWire(0, 0),
      acceptanceWire(1, 1),
      { ...acceptanceVia(1, 1), ...change },
      acceptanceWire(1, 1, "bottom"),
      acceptanceWire(2, 1, "bottom"),
      acceptanceVia(2, 1, "bottom", "top"),
      acceptanceWire(2, 1),
      acceptanceWire(4, 0),
    ])
    expect(report.complete).toBe(true)
    expect(report.allowedLayers).toBe(false)
    expect(report.valid).toBe(false)
  }
})

test("G350 acceptance rejects missing and offset layer-transition vias", () => {
  for (const route of [
    [
      acceptanceWire(0, 0),
      acceptanceWire(2, 1, "bottom"),
      acceptanceWire(4, 0),
    ],
    [
      acceptanceWire(0, 0),
      acceptanceWire(1, 1),
      acceptanceVia(1.01, 1),
      acceptanceWire(1.01, 1, "bottom"),
      acceptanceWire(2, 1, "bottom"),
      acceptanceVia(2, 1, "bottom", "top"),
      acceptanceWire(2, 1),
      acceptanceWire(4, 0),
    ],
  ]) {
    const report = copperAcceptance(route)
    expect(report.complete).toBe(true)
    expect(
      report.drc.issues.some((issue) => issue.code === "disconnected-trace"),
    ).toBe(true)
    expect(report.valid).toBe(false)
  }
})

test("G350 acceptance audits the larger copper width at a segment transition", () => {
  const report = copperAcceptance(
    [{ ...acceptanceWire(0, 0), width: 0.4 }, acceptanceWire(4, 0)],
    [
      {
        center: { x: 2, y: 0.3 },
        width: 0.05,
        height: 0.05,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  )
  expect(report.routeGeometryValid).toBe(true)
  expect(report.drc.valid).toBe(false)
  expect(report.valid).toBe(false)
})

test("G350 acceptance rejects copper that crosses an outline cutout inside the bounds", () => {
  const report = copperAcceptance(
    [acceptanceWire(0, 0), acceptanceWire(4, 0)],
    [],
    {
      outline: [
        { x: -5, y: -5 },
        { x: 5, y: -5 },
        { x: 5, y: 5 },
        { x: 3, y: 5 },
        { x: 3, y: -1 },
        { x: 1, y: -1 },
        { x: 1, y: 5 },
        { x: -5, y: 5 },
      ],
      minBoardEdgeClearance: 0.3,
    },
  )
  expect(report.complete).toBe(true)
  expect(report.drc.valid).toBe(true)
  expect(report.boundary.valid).toBe(false)
  expect(report.valid).toBe(false)
})

test("non-finite G350 pair copper is rejected before exterior coupling sampling", () => {
  const input = loadG350Am3352Sample()
  const connection = input.connections.find(
    (c) => c.name === input.differentialPairs![0].connectionNames[0],
  )!
  const output: SimpleRouteJson = {
    ...input,
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "nonfinite_pair",
        connection_name: connection.name,
        source_trace_id: connection.source_trace_id,
        route: [
          {
            ...connection.pointsToConnect[0],
            route_type: "wire",
            width: 0.1016,
          },
          acceptanceWire(Number.POSITIVE_INFINITY, 10),
          {
            ...connection.pointsToConnect[1],
            route_type: "wire",
            width: 0.1016,
          },
        ],
      },
    ],
  }
  const report = validateG350Am3352Sample(input, output)
  expect(report.routeGeometryValid).toBe(false)
  expect(
    report.coupling.every((pair) => !pair.applicable && !pair.matched),
  ).toBe(true)
  expect(report.valid).toBe(false)
})

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
  expect(metadata.cpu).toMatchObject({ x: 0, y: 20, rotation: 0 })
  expect(metadata.ram).toMatchObject({ x: 0, y: -2, rotation: 270 })
  for (const [name, map, count, diameter] of [
    ["U_SOC", cpuMap, 324, 0.4],
    ["U_RAM", ramMap, 96, 0.42],
  ] as const) {
    const component = ofType("source_component").find((e) => e.name === name)!
    const pcb = ofType("pcb_component").find(
      (e) => e.source_component_id === component.source_component_id,
    )!
    const placement = name === "U_SOC" ? metadata.cpu : metadata.ram
    expect(pcb.center).toEqual({ x: placement.x, y: placement.y })
    expect(pcb.display_offset_x).toBe(placement.x)
    expect(pcb.display_offset_y).toBe(placement.y)
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

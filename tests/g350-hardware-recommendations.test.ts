import { expect, test } from "bun:test"
import circuit from "./fixtures/g350-am3352/circuit.json"
import {
  auditG350HardwareRecommendations,
  computeG350LengthBounds,
  validateG350LengthConstraints,
} from "../scripts/g350-hardware-recommendations"
import {
  loadG350Am3352CompleteInput,
  loadG350Am3352Sample,
} from "../scripts/g350-am3352-sample"
import { validateG350Am3352Sample } from "../scripts/validate-g350-am3352-sample"

const records = circuit as unknown as Array<
  Record<string, any> & { type: string }
>

test("G350 DDR bypass placement and battery sense meet the captured hardware requirements", () => {
  const report = auditG350HardwareRecommendations(
    records,
    loadG350Am3352CompleteInput(),
  )
  expect(report.issues).toEqual([])
  expect(report.valid).toBe(true)
  expect(report.capacitors).toHaveLength(32)
  expect(report.batterySenseConnected).toBe(true)
  expect(report.supportRoutingVerified).toBe(false)
  expect(report.electricalTimingVerified).toBe(false)
})

test("TI absolute length budgets follow the actual G350 pin placement and remain mandatory", () => {
  const input = loadG350Am3352Sample()
  const rules = computeG350LengthBounds(input)
  for (const [index, distance] of [22.4, 22.4, 24].entries())
    expect(rules[index].longestManhattanMm).toBeCloseTo(distance, 7)
  expect(rules[0].maxLength).toBeCloseTo(22.4, 7)
  expect(rules[1].maxLength).toBeCloseTo(22.4, 7)
  expect(rules[2].minLength).toBeCloseTo(30.35, 7)
  expect(rules[2].maxLength).toBeCloseTo(32.89, 7)
  expect(validateG350LengthConstraints(input).issues).toEqual([])
  for (const rule of rules) {
    const source = records.find(
      (r) => r.type === "source_bus" && r.name === rule.busId,
    )
    const captured = input.buses?.find((b) => b.busId === rule.busId)
    expect(source).toBeDefined()
    expect(captured).toBeDefined()
    expect(source?.min_length).toBe(captured?.minLength)
    expect(source?.max_length).toBe(captured?.maxLength)
    expect(source?.max_length_skew).toBe(captured?.maxLengthSkew)
    expect(source?.source_trace_ids.toSorted()).toEqual(
      captured?.connectionNames.toSorted(),
    )
  }
})

test("all 854 physical pads, ports, obstacles and captured endpoints retain matching coordinates and layers", () => {
  const input = loadG350Am3352CompleteInput()
  const pads = records.filter((r) => r.type === "pcb_smtpad")
  const ports = new Map(
    records
      .filter((r) => r.type === "pcb_port")
      .map((p) => [p.pcb_port_id as string, p]),
  )
  const obstacles = new Map(
    input.obstacles.map((obstacle) => {
      const record = obstacle as typeof obstacle & {
        circuitJsonMetadata: { pcb_smtpad_id: string; pcb_port_id: string }
      }
      return [record.circuitJsonMetadata.pcb_smtpad_id, record] as const
    }),
  )
  expect(pads).toHaveLength(854)
  expect(ports.size).toBe(854)
  expect(obstacles.size).toBe(854)
  expect(input.obstacles).toHaveLength(854)
  for (const pad of pads) {
    const port = ports.get(pad.pcb_port_id)
    const obstacle = obstacles.get(pad.pcb_smtpad_id)
    expect(port).toBeDefined()
    expect(obstacle).toBeDefined()
    for (const value of [
      pad.x,
      pad.y,
      port?.x,
      port?.y,
      obstacle?.center.x,
      obstacle?.center.y,
    ])
      expect(Number.isFinite(value)).toBe(true)
    expect(port?.x).toBeCloseTo(pad.x, 7)
    expect(port?.y).toBeCloseTo(pad.y, 7)
    expect(port?.pcb_component_id).toBe(pad.pcb_component_id)
    expect(port?.layers).toEqual([pad.layer])
    expect(obstacle?.center.x).toBeCloseTo(pad.x, 7)
    expect(obstacle?.center.y).toBeCloseTo(pad.y, 7)
    expect(obstacle?.componentId).toBe(pad.pcb_component_id)
    expect(obstacle?.layers).toEqual([pad.layer])
    expect(obstacle?.circuitJsonMetadata.pcb_port_id).toBe(pad.pcb_port_id)
  }
  const endpoints = input.connections.flatMap((c) => c.pointsToConnect)
  expect(endpoints.length).toBeGreaterThan(0)
  for (const endpoint of endpoints) {
    const port = ports.get(endpoint.pcb_port_id ?? "")
    expect(port).toBeDefined()
    expect(Number.isFinite(endpoint.x)).toBe(true)
    expect(Number.isFinite(endpoint.y)).toBe(true)
    expect(endpoint.x).toBeCloseTo(port?.x, 7)
    expect(endpoint.y).toBeCloseTo(port?.y, 7)
    expect(port?.layers).toContain(endpoint.layer)
  }
})

test("missing absolute bounds cannot silently become an accepted matching configuration", () => {
  const input = loadG350Am3352Sample()
  delete input.buses!.find((b) => b.busId === "DDR_BYTE0")!.maxLength
  const constraints = validateG350LengthConstraints(input)
  expect(constraints.valid).toBe(false)
  expect(constraints.issues).toContain(
    "DDR_BYTE0: missing or changed TI absolute-length/skew bounds",
  )
  const report = validateG350Am3352Sample(input, input)
  expect(report.lengthConstraints.valid).toBe(false)
  expect(report.valid).toBe(false)
})

test("removing a long signal from a byte cannot relax the TI length budget", () => {
  const input = loadG350Am3352Sample()
  const byte0 = input.buses!.find((b) => b.busId === "DDR_BYTE0")!
  byte0.connectionNames.pop()
  expect(validateG350LengthConstraints(input).issues).toContain(
    "DDR_BYTE0: signal membership differs from the pin manifest",
  )
})

test("a misplaced bypass capacitor fails even when capacitor counts and capacitance remain sufficient", () => {
  const misplaced = structuredClone(records)
  const capacitor = misplaced.find(
    (r) => r.type === "source_component" && r.name === "C_DDR_RAM_12",
  )!
  const pcb = misplaced.find(
    (r) =>
      r.type === "pcb_component" &&
      r.source_component_id === capacitor.source_component_id,
  )!
  pcb.center = { x: 30, y: -30 }
  const report = auditG350HardwareRecommendations(
    misplaced,
    loadG350Am3352CompleteInput(),
  )
  expect(report.valid).toBe(false)
  expect(report.issues).toContain(
    "C_DDR_RAM_12: capacitor center exceeds the 3.81 mm TI bypass placement limit",
  )
})

test("a logical battery-sense connection without a captured physical terminal fails", () => {
  const input = loadG350Am3352CompleteInput()
  const pmic = records.find(
    (r) => r.type === "source_component" && r.name === "U_PMIC",
  )!
  const sense = records.find(
    (r) =>
      r.type === "source_port" &&
      r.source_component_id === pmic.source_component_id &&
      r.name === "BAT_SENSE",
  )!
  const pcb = records.find(
    (r) => r.type === "pcb_port" && r.source_port_id === sense.source_port_id,
  )!
  for (const connection of input.connections)
    connection.pointsToConnect = connection.pointsToConnect.filter(
      (p) => p.pcb_port_id !== pcb.pcb_port_id,
    )
  const report = auditG350HardwareRecommendations(records, input)
  expect(report.batterySenseConnected).toBe(false)
  expect(report.issues).toContain(
    "U_PMIC.BAT_SENSE: missing explicit VBAT source/captured routing connection",
  )
})

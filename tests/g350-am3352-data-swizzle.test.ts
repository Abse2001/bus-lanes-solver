import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import originalCircuit from "./fixtures/g350-am3352/circuit.json"
import {
  deriveG350Am3352DataSwizzle,
  g350OriginalCpuToRamDq,
  g350RepairedCpuToRamDq,
  loadG350Am3352RepairedSample,
  validateG350Am3352RepairedSample,
} from "../scripts/g350-am3352-data-swizzle"
import {
  g350Am3352Metadata,
  loadG350Am3352Sample,
} from "../scripts/g350-am3352-sample"

const selectedMapping = [7, 4, 1, 2, 5, 6, 0, 3, 8, 10, 14, 12, 9, 11, 13, 15]
const records = originalCircuit as unknown as Array<Record<string, any>>
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

test("the repaired reproduction maps CPU data bits to physical Micron DQ pins", () => {
  const original = loadG350Am3352Sample()
  const { input, manifest } = deriveG350Am3352DataSwizzle()
  expect(selectedMapping).toEqual([...g350RepairedCpuToRamDq])
  expect(manifest.cpuToRamDq).toEqual(selectedMapping)
  expect(input.connections).toHaveLength(49)
  expect(input.obstacles).toHaveLength(854)
  expect(input.traces).toEqual([])
  expect(manifest.mapping.map((row) => row.ram.ball)).toEqual([
    "H7",
    "H3",
    "F7",
    "F2",
    "H8",
    "G2",
    "E3",
    "F8",
    "D7",
    "C8",
    "B8",
    "A7",
    "C3",
    "C2",
    "A2",
    "A3",
  ])
  const targetPorts = new Set<string>()
  for (const row of manifest.mapping) {
    expect(row.logicalName).toBe(`DDR_D${row.cpuBit}`)
    expect(row.ramBit).toBe(selectedMapping[row.cpuBit])
    expect(row.originalRamBit).toBe(g350OriginalCpuToRamDq[row.cpuBit])
    const physicalRamPort = records.find(
      (record) =>
        record.type === "source_port" &&
        record.source_component_id === "source_component_1" &&
        record.port_hints.includes(`DQ${row.ramBit}`),
    )!
    expect(row.ram.sourcePortId).toBe(physicalRamPort.source_port_id)
    expect(row.ram.ball).toBe(physicalRamPort.name)
    expect(row.ram.numericPin).toBe(physicalRamPort.pin_number)
    const pcbPort = records.find(
      (record) =>
        record.type === "pcb_port" &&
        record.source_port_id === physicalRamPort.source_port_id,
    )!
    const originalTerminal = original.connections
      .flatMap((connection) => connection.pointsToConnect)
      .find((point) => point.pcb_port_id === pcbPort.pcb_port_id)!
    const connection = input.connections.find(
      (connection) => connection.name === row.connectionName,
    )!
    const oldConnection = original.connections.find(
      (connection) => connection.name === row.connectionName,
    )!
    expect(connection.pointsToConnect[1]).toEqual(originalTerminal)
    expect(row.ram.terminal).toEqual(originalTerminal)
    expect({
      ...connection,
      pointsToConnect: oldConnection.pointsToConnect,
    }).toEqual(oldConnection)
    expect(connection.pointsToConnect[0]).toEqual(
      oldConnection.pointsToConnect[0],
    )
    targetPorts.add(connection.pointsToConnect[1].pcb_port_id!)
  }
  expect(targetPorts.size).toBe(16)
})

test("only DQ RAM endpoints and their pad trace owners change", () => {
  const original = loadG350Am3352Sample()
  const { input, manifest } = deriveG350Am3352DataSwizzle()
  const dataNames = new Set(manifest.mapping.map((row) => row.connectionName))
  const ownerByPort = new Map(
    manifest.mapping.map((row) => [row.ram.pcbPortId, row.connectionName]),
  )
  for (let i = 0; i < input.connections.length; i++)
    if (!dataNames.has(input.connections[i].name))
      expect(input.connections[i]).toEqual(original.connections[i])
  let assignedPads = 0
  for (let i = 0; i < input.obstacles.length; i++) {
    const pad = input.obstacles[i]
    const oldPad = original.obstacles[i]
    expect({ ...pad, connectedTo: oldPad.connectedTo }).toEqual(oldPad)
    const targetPort = pad.connectedTo.find((id) => ownerByPort.has(id))
    if (targetPort) {
      assignedPads++
      expect(pad.connectedTo.filter((id) => dataNames.has(id))).toEqual([
        ownerByPort.get(targetPort)!,
      ])
      expect(pad.connectedTo.filter((id) => !dataNames.has(id))).toEqual(
        oldPad.connectedTo.filter((id) => !dataNames.has(id)),
      )
    } else expect(pad).toEqual(oldPad)
  }
  expect(assignedPads).toBe(16)
  expect({
    ...input,
    connections: original.connections,
    obstacles: original.obstacles,
  }).toEqual(original)
})

test("the derived source circuit agrees with the routed netlist without moving physical pads", () => {
  const { circuitJson, manifest } = deriveG350Am3352DataSwizzle()
  const byTrace = new Map(
    manifest.mapping.map((row) => [row.connectionName, row]),
  )
  const byRamPort = new Map(
    manifest.mapping.map((row) => [row.ram.sourcePortId, row]),
  )
  expect(circuitJson).toHaveLength(records.length)
  for (let i = 0; i < circuitJson.length; i++) {
    const record = circuitJson[i]
    const original = records[i]
    const data = byTrace.get(record.source_trace_id)
    const ram = byRamPort.get(record.source_port_id)
    if (record.type === "source_trace" && data) {
      expect(record.connected_source_port_ids).toEqual([
        data.cpu.sourcePortId,
        data.ram.sourcePortId,
      ])
      expect(record.display_name).toBe(
        `U_SOC.pin${data.cpu.numericPin} to U_RAM.pin${data.ram.numericPin}`,
      )
      expect(original).toEqual({
        ...record,
        connected_source_port_ids: original.connected_source_port_ids,
        display_name: original.display_name,
      })
    } else if (record.type === "source_port" && ram) {
      const source = circuitJson.find(
        (candidate) =>
          candidate.type === "source_trace" &&
          candidate.source_trace_id === ram.connectionName,
      )!
      expect(record.subcircuit_connectivity_map_key).toBe(
        source.subcircuit_connectivity_map_key,
      )
      expect(original).toEqual({
        ...record,
        subcircuit_connectivity_map_key:
          original.subcircuit_connectivity_map_key,
      })
    } else expect(record).toEqual(original)
  }
})

test("the original mapping reproduces the captured input and source circuit exactly", () => {
  const original = loadG350Am3352Sample()
  const { input, circuitJson, manifest } = deriveG350Am3352DataSwizzle(
    g350OriginalCpuToRamDq,
  )
  expect(input).toEqual(original)
  expect(circuitJson).toEqual(records)
  expect(manifest.mapping.every((row) => !row.changed)).toBe(true)
  expect(manifest.baseInputSha256).toBe(hash(original))
  expect(manifest.derivedInputSha256).toBe(manifest.baseInputSha256)
})

test("invalid, non-bijective and cross-byte DQ mappings are rejected", () => {
  const invalid = [
    [],
    selectedMapping.slice(1),
    [...selectedMapping, 0],
    selectedMapping.map((bit, i) => (i === 0 ? 4 : bit)),
    selectedMapping.map((bit, i) => (i === 0 ? 16 : bit)),
    selectedMapping.map((bit, i) => (i === 0 ? -1 : bit)),
    selectedMapping.map((bit, i) => (i === 0 ? 0.5 : bit)),
    selectedMapping.map((bit, i) => (i === 0 ? Number.NaN : bit)),
    selectedMapping.map((bit, i) => (i === 0 ? 8 : i === 8 ? 7 : bit)),
    new Array<number>(16),
  ]
  for (const mapping of invalid)
    expect(() => loadG350Am3352RepairedSample(mapping)).toThrow(
      "G350 DQ mapping",
    )
})

test("derived outputs retain hashes and do not mutate the captured input or later loads", () => {
  const original = loadG350Am3352Sample()
  const beforeCircuit = hash(originalCircuit)
  const expected = deriveG350Am3352DataSwizzle()
  expect(expected.manifest.baseCaptureSha256).toBe(
    g350Am3352Metadata.filesSha256["native-input.json"],
  )
  expect(expected.manifest.baseCircuitSha256).toBe(
    g350Am3352Metadata.filesSha256["circuit.json"],
  )
  expect(expected.manifest.derivedInputSha256).toBe(hash(expected.input))
  expect(expected.manifest.derivedCircuitSha256).toBe(
    hash(expected.circuitJson),
  )
  const mutation = deriveG350Am3352DataSwizzle()
  mutation.input.connections[0].pointsToConnect[0].x += 10
  mutation.input.obstacles[0].connectedTo.push("foreign_owner")
  mutation.circuitJson[0].type = "modified"
  mutation.manifest.cpuToRamDq[0] = 0
  mutation.manifest.mapping[0].ram.terminal.x += 10
  expect(deriveG350Am3352DataSwizzle()).toEqual(expected)
  expect(loadG350Am3352Sample()).toEqual(original)
  expect(hash(originalCircuit)).toBe(beforeCircuit)
  expect(Object.isFrozen(g350OriginalCpuToRamDq)).toBe(true)
  expect(Object.isFrozen(g350RepairedCpuToRamDq)).toBe(true)
})

test("repaired acceptance reconstructs the explicit netlist and rejects arbitrary endpoint or ownership changes", () => {
  const input = loadG350Am3352RepairedSample()
  const unrouted = validateG350Am3352RepairedSample(input)
  expect(unrouted.geometryPreserved).toBe(true)
  expect(unrouted.complete).toBe(false)
  expect(unrouted.valid).toBe(false)
  expect(unrouted.dataSwizzle.cpuToRamDq).toEqual(selectedMapping)
  const original = validateG350Am3352RepairedSample(loadG350Am3352Sample())
  expect(original.geometryPreserved).toBe(false)
  const moved = structuredClone(input)
  moved.connections[0].pointsToConnect[1].x += 0.01
  expect(validateG350Am3352RepairedSample(moved).geometryPreserved).toBe(false)
  const owner = structuredClone(input)
  owner.obstacles
    .find((pad) => pad.connectedTo.includes("pcb_port_379"))!
    .connectedTo.push("foreign_owner")
  expect(validateG350Am3352RepairedSample(owner).geometryPreserved).toBe(false)
})

test("the repaired browser fixture bundles without Node dependencies", async () => {
  const build = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "../scripts/g350-am3352-repaired-sample.ts"),
    ],
    target: "browser",
  })
  expect(build.logs).toEqual([])
  expect(build.success).toBe(true)
})

import { createHash } from "node:crypto"
import originalCircuit from "../tests/fixtures/g350-am3352/circuit.json"
import type { SimpleRouteJson } from "../lib"
import { g350Am3352Metadata, loadG350Am3352Sample } from "./g350-am3352-sample"
import { validateG350Am3352Sample } from "./validate-g350-am3352-sample"
import {
  deriveG350Am3352InputSwizzle,
  g350OriginalCpuToRamDq,
  g350RepairedCpuToRamDq,
} from "./g350-am3352-repaired-sample"
export {
  g350OriginalCpuToRamDq,
  g350RepairedCpuToRamDq,
  loadG350Am3352RepairedSample,
} from "./g350-am3352-repaired-sample"

const tiSources = [
  "https://e2e.ti.com/support/processors-group/processors/f/processors-forum/1205797/am4376-about-ddr3-data-line-swapping",
  "https://e2e.ti.com/support/processors-group/processors/f/processors-forum/481726/am3354-ddr3-routing-and-pin-swapping",
]
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Derive the authorized netlist from the immutable hash-indexed capture.
 * Connection IDs retain their CPU meaning. A RAM terminal's complete port
 * identity moves with its assignment, and only that pad's trace ownership
 * changes. The matching source circuit provides an explicit schematic patch.
 */
export function deriveG350Am3352DataSwizzle(
  cpuToRamDq: readonly number[] = g350RepairedCpuToRamDq,
) {
  const derived = deriveG350Am3352InputSwizzle(cpuToRamDq)
  const input = derived.input
  const circuitJson = structuredClone(
    originalCircuit as unknown as Array<Record<string, any>>,
  )
  const sourcePorts = new Map(
    circuitJson
      .filter((record) => record.type === "source_port")
      .map((record) => [record.source_port_id as string, record]),
  )
  const sourcePortByPcbPort = new Map(
    circuitJson
      .filter((record) => record.type === "pcb_port")
      .map((record) => [
        record.pcb_port_id as string,
        record.source_port_id as string,
      ]),
  )
  const withSourcePort = (pin: (typeof derived.mapping)[number]["cpu"]) => ({
    ...pin,
    sourcePortId: sourcePortByPcbPort.get(pin.pcbPortId)!,
  })
  const mapping = derived.mapping.map((pin) => {
    const cpu = withSourcePort(pin.cpu)
    const ram = withSourcePort(pin.ram)
    const source = circuitJson.find(
      (record) =>
        record.type === "source_trace" &&
        record.source_trace_id === pin.connectionName,
    )!
    source.connected_source_port_ids = [cpu.sourcePortId, ram.sourcePortId]
    source.display_name = `U_SOC.pin${cpu.numericPin} to U_RAM.pin${ram.numericPin}`
    sourcePorts.get(ram.sourcePortId)!.subcircuit_connectivity_map_key =
      source.subcircuit_connectivity_map_key
    return { ...pin, cpu, ram, originalRam: withSourcePort(pin.originalRam) }
  })
  const manifest = {
    kind: "g350-ddr-data-swizzle" as const,
    authorization: "Explicit reproduction-only DQ permutation within each byte",
    baseCaptureSha256: g350Am3352Metadata.filesSha256["native-input.json"],
    baseCircuitSha256: g350Am3352Metadata.filesSha256["circuit.json"],
    baseInputSha256: hash(loadG350Am3352Sample()),
    derivedInputSha256: hash(input),
    derivedCircuitSha256: hash(circuitJson),
    cpuToRamDq: [...cpuToRamDq],
    originalCpuToRamDq: [...g350OriginalCpuToRamDq],
    tiSources: [...tiSources],
    mapping,
  }
  return { input, circuitJson, manifest }
}

/** Reconstruct expected endpoints and ownership from the capture, rather than
 * trusting a caller-provided modified input to declare its own acceptance. */
export function validateG350Am3352RepairedSample(
  output: SimpleRouteJson,
  cpuToRamDq: readonly number[] = g350RepairedCpuToRamDq,
) {
  const derived = deriveG350Am3352DataSwizzle(cpuToRamDq)
  return {
    ...validateG350Am3352Sample(derived.input, output),
    dataSwizzle: derived.manifest,
  }
}

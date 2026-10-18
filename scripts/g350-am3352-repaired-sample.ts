import originalConnections from "../tests/fixtures/g350-am3352/memory-byte1-top-centered-swizzled-connections.json"
import type { SimpleRouteJson, Terminal } from "../lib"
import { g350Am3352Metadata, loadG350Am3352Sample } from "./g350-am3352-sample"

/** CPU D0..D15 -> physical Micron DQ number. The capture already has a swizzle. */
export const g350OriginalCpuToRamDq = Object.freeze([
  2, 5, 0, 4, 1, 6, 3, 7, 10, 12, 9, 13, 8, 11, 15, 14,
] as const)

/** Explicit reproduction-only netlist repair. The general solver does not
 * choose or change pin assignments. DQS, DM and all other signals stay fixed. */
export const g350RepairedCpuToRamDq = Object.freeze([
  7, 4, 1, 2, 5, 6, 0, 3, 8, 10, 14, 12, 9, 11, 13, 15,
] as const)

function assertWithinBytePermutation(mapping: readonly number[]) {
  if (!Array.isArray(mapping) || mapping.length !== 16)
    throw Error("G350 DQ mapping requires exactly 16 CPU-to-RAM bit entries")
  for (let cpuBit = 0; cpuBit < 16; cpuBit++) {
    const ramBit = mapping[cpuBit]
    if (
      !Number.isInteger(ramBit) ||
      ramBit < 0 ||
      ramBit > 15 ||
      Math.floor(cpuBit / 8) !== Math.floor(ramBit / 8)
    )
      throw Error("G350 DQ mapping must permute data bits within each byte")
  }
  if (new Set(mapping).size !== 16)
    throw Error("G350 DQ mapping must be bijective")
}

/** Pure input transformation shared by the browser fixture and Node export.
 * Physical endpoints move as complete identities, with matching pad ownership.
 * The returned mapping names physical RAM DQ bits, not captured CPU aliases.
 */
export function deriveG350Am3352InputSwizzle(
  cpuToRamDq: readonly number[] = g350RepairedCpuToRamDq,
) {
  assertWithinBytePermutation(cpuToRamDq)
  const input = loadG350Am3352Sample()
  const names = g350Am3352Metadata.signalNames as Record<string, string>
  const physicalPin = (
    terminal: Terminal,
    ball: string,
    numericPin: string,
  ) => {
    const pads = input.obstacles.filter((obstacle) =>
      obstacle.connectedTo.includes(terminal.pcb_port_id!),
    )
    const padIds = pads.flatMap((obstacle) =>
      obstacle.connectedTo.filter((id) => id.startsWith("pcb_smtpad_")),
    )
    if (pads.length !== 1 || padIds.length !== 1)
      throw Error(`Unexpected G350 physical pad for ${terminal.pcb_port_id}`)
    return {
      ball,
      numericPin: Number(numericPin.slice(3)),
      pcbPortId: terminal.pcb_port_id!,
      pcbSmtpadId: padIds[0],
      terminal: structuredClone(terminal),
    }
  }
  const data = originalConnections
    .filter((connection) => /^DDR_D\d+$/.test(connection.name))
    .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)))
    .map((mapping) => {
      const connection = input.connections.find(
        (connection) => names[connection.name] === mapping.name,
      )!
      return {
        cpuBit: Number(mapping.name.slice(5)),
        ramBit: Number(mapping.ramFunction.slice(2)),
        logicalName: mapping.name,
        connectionName: connection.name,
        connection,
        cpu: physicalPin(
          connection.pointsToConnect[0],
          mapping.socBall,
          mapping.socPin,
        ),
        ram: physicalPin(
          connection.pointsToConnect[1],
          mapping.ramBall,
          mapping.ramPin,
        ),
      }
    })
  if (
    data.length !== 16 ||
    data.some(
      (pin, index) =>
        pin.cpuBit !== index || pin.ramBit !== g350OriginalCpuToRamDq[index],
    )
  )
    throw Error("G350 capture no longer matches the recorded DQ assignments")
  const ramByBit = new Map(data.map((pin) => [pin.ramBit, pin]))
  const dataNames = new Set(data.map((pin) => pin.connectionName))
  const targetOwners = new Map<string, string>()
  const mapping = data.map((pin) => {
    const target = ramByBit.get(cpuToRamDq[pin.cpuBit])!
    pin.connection.pointsToConnect[1] = structuredClone(target.ram.terminal)
    targetOwners.set(target.ram.pcbPortId, pin.connectionName)
    return {
      cpuBit: pin.cpuBit,
      ramBit: target.ramBit,
      originalRamBit: pin.ramBit,
      logicalName: pin.logicalName,
      connectionName: pin.connectionName,
      cpu: pin.cpu,
      ram: target.ram,
      originalRam: pin.ram,
      changed: target.ramBit !== pin.ramBit,
    }
  })
  const seenPorts = new Set<string>()
  for (const obstacle of input.obstacles) {
    const target = [...targetOwners].find(([portId]) =>
      obstacle.connectedTo.includes(portId),
    )
    if (!target) continue
    const [portId, owner] = target
    if (
      obstacle.connectedTo.filter((id) => dataNames.has(id)).length !== 1 ||
      obstacle.componentId !== "pcb_component_1" ||
      seenPorts.has(portId)
    )
      throw Error(`Unexpected G350 RAM pad ownership for ${portId}`)
    seenPorts.add(portId)
    obstacle.connectedTo = obstacle.connectedTo.map((id) =>
      dataNames.has(id) ? owner : id,
    )
  }
  if (seenPorts.size !== 16)
    throw Error("G350 DQ mapping requires all 16 physical RAM pads")
  return { input, mapping }
}

export function loadG350Am3352RepairedSample(
  cpuToRamDq: readonly number[] = g350RepairedCpuToRamDq,
): SimpleRouteJson {
  return deriveG350Am3352InputSwizzle(cpuToRamDq).input
}

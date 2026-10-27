import metadata from "../tests/fixtures/g350-am3352/metadata.json"
import type { SimpleRouteJson } from "../lib/types"

type CircuitRecord = { type: string; [key: string]: any }
const epsilon = 1e-7
const near = (a: number | undefined, b: number | undefined) =>
  a === b || (a !== undefined && b !== undefined && Math.abs(a - b) < epsilon)

const signalEntries = Object.entries(metadata.signalNames)
const byteNames = (byte: number) =>
  signalEntries
    .filter(([, signal]) => {
      const dataBit = /^DDR_D(\d+)$/.exec(signal)
      return dataBit
        ? Math.floor(Number(dataBit[1]) / 8) === byte
        : [`DDR_DQM${byte}`, `DDR_DQS${byte}`, `DDR_DQSn${byte}`].includes(
            signal,
          )
    })
    .map(([name]) => name)

const byte0 = byteNames(0)
const byte1 = byteNames(1)
const dataNames = new Set([...byte0, ...byte1])
const commandNames = signalEntries
  .filter(([name, signal]) => !dataNames.has(name) && signal !== "DDR_RESETn")
  .map(([name]) => name)

/** TI SPRS717L, Tables 7-68/69 (pp. 187–188): CACLM is the longest
 * clock/address/control Manhattan distance plus 300 mil, with a ±50 mil
 * nominal-length window. Each byte has its own DQLM nominal maximum.
 * https://www.ti.com/lit/ds/sprs717l/sprs717l.pdf
 * These are PCB planar-length constraints, not a timing/impedance sign-off.
 */
export function computeG350LengthBounds(input: SimpleRouteJson) {
  return [
    { busId: "DDR_BYTE0", connectionNames: byte0 },
    { busId: "DDR_BYTE1", connectionNames: byte1 },
    { busId: "DDR_COMMAND_CLOCK", connectionNames: commandNames },
  ].map((bus) => {
    const distances = bus.connectionNames.map((name) => {
      const points = input.connections.find(
        (c) => c.name === name,
      )?.pointsToConnect
      if (points?.length !== 2)
        throw Error(`${bus.busId}: missing two-terminal signal ${name}`)
      return (
        Math.abs(points[0].x - points[1].x) +
        Math.abs(points[0].y - points[1].y)
      )
    })
    const longestManhattanMm = Math.max(...distances)
    const command = bus.busId === "DDR_COMMAND_CLOCK"
    const nominalLengthMm = longestManhattanMm + (command ? 7.62 : 0)
    return {
      ...bus,
      longestManhattanMm,
      nominalLengthMm,
      minLength: command ? nominalLengthMm - 1.27 : undefined,
      maxLength: nominalLengthMm + (command ? 1.27 : 0),
    }
  })
}

/** Reject omitted/relaxed fixture constraints instead of letting them turn
 * into unconstrained matching reports. Membership is derived from the pin
 * manifest independently of the input's bus declarations.
 */
export function validateG350LengthConstraints(input: SimpleRouteJson) {
  const issues: string[] = []
  let expected: ReturnType<typeof computeG350LengthBounds> = []
  try {
    expected = computeG350LengthBounds(input)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }
  for (const rule of expected) {
    const buses = (input.buses ?? []).filter((b) => b.busId === rule.busId)
    const bus = buses[0]
    if (
      buses.length !== 1 ||
      !bus ||
      bus.connectionNames.length !== rule.connectionNames.length ||
      new Set(bus.connectionNames).size !== rule.connectionNames.length ||
      rule.connectionNames.some((name) => !bus.connectionNames.includes(name))
    ) {
      issues.push(
        `${rule.busId}: signal membership differs from the pin manifest`,
      )
      continue
    }
    if (
      !near(bus.maxLength, rule.maxLength) ||
      !near(bus.minLength, rule.minLength) ||
      !near(bus.maxLengthSkew, 0.635)
    )
      issues.push(
        `${rule.busId}: missing or changed TI absolute-length/skew bounds`,
      )
  }
  return { valid: issues.length === 0, issues, expected }
}

/** Static placement/connectivity checks from TI SPRS717L Table 7-65 and
 * TPS65217 SLVSB64I §6. Straight-line center distances are necessary placement
 * checks; they do not establish via inductance or routed support connectivity.
 */
export function auditG350HardwareRecommendations(
  circuit: readonly CircuitRecord[],
  completeInput: SimpleRouteJson,
) {
  const issues: string[] = []
  const ofType = (type: string) => circuit.filter((r) => r.type === type)
  const components = ofType("source_component")
  const sourcePorts = ofType("source_port")
  const pcbPorts = ofType("pcb_port")
  const pcbComponents = ofType("pcb_component")
  const sourcePortById = new Map(sourcePorts.map((p) => [p.source_port_id, p]))
  const capacitors: Array<{
    name: string
    limitMm: number
    powerDistanceMm: number
    groundDistanceMm: number
  }> = []
  for (const [chipName, prefix, count, minimumCapacitance, limitMm] of [
    ["U_SOC", "C_DDR_CPU_", 20, 1e-6, 10.16],
    ["U_RAM", "C_DDR_RAM_", 12, 0.85e-6, 3.81],
  ] as const) {
    const chip = components.find((c) => c.name === chipName)
    const chipPorts = pcbPorts.filter(
      (p) =>
        sourcePortById.get(p.source_port_id)?.source_component_id ===
        chip?.source_component_id,
    )
    const power = chipPorts.filter((p) => {
      const source = sourcePortById.get(p.source_port_id)!
      return chipName === "U_SOC"
        ? source.port_hints?.some((hint: string) => /^VDDS_DDR\d*$/.test(hint))
        : source.requires_power
    })
    const ground = chipPorts.filter(
      (p) => sourcePortById.get(p.source_port_id)?.requires_ground,
    )
    const caps = components.filter(
      (c) =>
        c.name.startsWith(prefix) && /^\d+$/.test(c.name.slice(prefix.length)),
    )
    if (
      caps.length < count ||
      caps.reduce((sum, c) => sum + (c.capacitance ?? 0), 0) <
        minimumCapacitance - 1e-12
    )
      issues.push(`${chipName}: insufficient high-speed DDR bypass capacitors`)
    for (const cap of caps) {
      const pcb = pcbComponents.find(
        (p) => p.source_component_id === cap.source_component_id,
      )
      const nearest = (ports: CircuitRecord[]) =>
        pcb
          ? Math.min(
              ...ports.map((p) =>
                Math.hypot(p.x - pcb.center.x, p.y - pcb.center.y),
              ),
            )
          : Infinity
      const report = {
        name: cap.name as string,
        limitMm,
        powerDistanceMm: nearest(power),
        groundDistanceMm: nearest(ground),
      }
      capacitors.push(report)
      if (
        Math.max(report.powerDistanceMm, report.groundDistanceMm) >
        limitMm + epsilon
      )
        issues.push(
          `${cap.name}: capacitor center exceeds the ${limitMm} mm TI bypass placement limit`,
        )
    }
  }
  const pmic = components.find((c) => c.name === "U_PMIC")
  const sense = sourcePorts.find(
    (p) =>
      p.source_component_id === pmic?.source_component_id &&
      p.name === "BAT_SENSE",
  )
  const sensePcb = pcbPorts.find(
    (p) => p.source_port_id === sense?.source_port_id,
  )
  const vbat = ofType("source_net").find((n) => n.name === "VBAT")
  const batterySenseConnected =
    !!sense &&
    !!sensePcb &&
    !!vbat &&
    ofType("source_trace").some(
      (t) =>
        t.connected_source_port_ids?.includes(sense.source_port_id) &&
        t.connected_source_net_ids?.includes(vbat.source_net_id),
    ) &&
    completeInput.connections.some(
      (c) =>
        c.name === vbat.source_net_id &&
        c.pointsToConnect.some((p) => p.pcb_port_id === sensePcb.pcb_port_id),
    )
  if (!batterySenseConnected)
    issues.push(
      "U_PMIC.BAT_SENSE: missing explicit VBAT source/captured routing connection",
    )
  const lengthConstraints = validateG350LengthConstraints(completeInput)
  issues.push(...lengthConstraints.issues)
  return {
    valid: issues.length === 0,
    issues,
    capacitors,
    batterySenseConnected,
    lengthConstraints,
    supportRoutingVerified: false,
    electricalTimingVerified: false,
  }
}

import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import type {
  FanoutSolverOptions,
  FanoutSolverOutput,
} from "@tscircuit/fanout-solver"
import type { Connection, SimpleRouteJson, Trace } from "../lib"

export type Am3352SampleName =
  | "control"
  | "right"
  | "left"
  | "above"
  | "inner-layers"
export type Am3352Component = "soc" | "ram"
export const am3352SamplePlacements = [
  { name: "control", ram: { x: 0, y: -27 } },
  { name: "right", ram: { x: 27, y: 0 } },
  { name: "left", ram: { x: -27, y: 0 } },
  { name: "above", ram: { x: 0, y: 27 } },
  {
    name: "inner-layers",
    ram: { x: 0, y: -27 },
    allowedLayers: ["inner1", "inner2"],
  },
] as const

export interface PowerConnection extends Connection {
  netConnectionName: string
}
/** Board-world points: right-handed XY, +X right, +Y up; mm. */
export interface PowerPad {
  component: Am3352Component
  componentId: string
  componentName: string
  ball: string
  signal: string
  net: string
  role: "ground" | "supply" | "monitor" | "decoupling_output"
  connectionName: string
  pcbPortId: string
  pcbSmtpadId: string
  x: number
  y: number
  layer: string
}
interface OwnershipManifest {
  source: { inputSha256: string; [key: string]: unknown }
  components: Record<
    Am3352Component,
    {
      name: string
      componentId: string
      center: { x: number; y: number }
      ballSignals: Record<string, string>
    }
  >
  signalNames: Record<string, string>
}
export interface FanoutGeneratorIdentity {
  name: string
  version: string
  dependency: string
  sourceSha256: string
}
export interface Am3352FanoutRecord {
  generator: FanoutGeneratorIdentity
  component: Am3352Component
  coordinateFrame: "component_local_mm"
  inputSha256: string
  options: FanoutSolverOptions
  optionsSha256: string
  output: Pick<
    FanoutSolverOutput,
    "fanoutTraces" | "planeTerminations" | "validation"
  >
  tracesSha256: string
  outputSha256: string
}
export interface FanoutRecordReference {
  file: string
  inputSha256: string
  optionsSha256: string
  tracesSha256: string
  outputSha256: string
  generator: FanoutGeneratorIdentity
}
export interface Am3352SampleMetadata {
  name: Am3352SampleName
  placement: { cpu: { x: number; y: number }; ram: { x: number; y: number } }
  /** Translations from each saved component-local frame into board-world mm. */
  componentTranslations: Record<Am3352Component, { x: number; y: number }>
  signalNames: Record<string, string>
  fixedFanoutTraces: Trace[]
  powerConnections: PowerConnection[]
  powerPadManifest: PowerPad[]
  provenance: Record<Am3352Component, FanoutRecordReference>
}

const fixtureUrl = new URL("../tests/fixtures/am3352-ram/", import.meta.url)
export const am3352Hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Fingerprint the installed generator, without requiring a Git checkout. */
export async function getAm3352FanoutGeneratorIdentity(): Promise<FanoutGeneratorIdentity> {
  const packageRoot = dirname(
    dirname(Bun.resolveSync("@tscircuit/fanout-solver", import.meta.dir)),
  )
  const packageJson = await Bun.file(
    resolve(packageRoot, "package.json"),
  ).json()
  const solverPackage = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()
  const sourceHash = createHash("sha256")
  for (const file of [
    ...new Bun.Glob("lib/**/*.ts").scanSync(packageRoot),
  ].sort())
    sourceHash
      .update(file)
      .update("\n")
      .update(await Bun.file(resolve(packageRoot, file)).text())
      .update("\n")
  return {
    name: packageJson.name,
    version: packageJson.version,
    dependency: solverPackage.devDependencies["@tscircuit/fanout-solver"],
    sourceSha256: sourceHash.digest("hex"),
  }
}

export async function loadAm3352NativeInput(): Promise<SimpleRouteJson> {
  return Bun.file(new URL("native-input.json", fixtureUrl)).json()
}
async function loadOwnership(): Promise<OwnershipManifest> {
  return Bun.file(new URL("power-ownership.json", fixtureUrl)).json()
}
export async function loadAm3352FanoutRecord(
  component: Am3352Component,
): Promise<Am3352FanoutRecord> {
  return Bun.file(new URL(`${component}-power-fanout.json`, fixtureUrl)).json()
}

/** Translate component-local mm points to board-world mm (+X right, +Y up).
 * Saved power fanouts may contain only physical wires and vias. */
export function translateAm3352FanoutTraces(
  traces: FanoutSolverOutput["fanoutTraces"],
  origin: { x: number; y: number },
): Trace[] {
  return traces.map((trace) => ({
    ...trace,
    route: trace.route.map((point) => {
      if (point.route_type !== "wire" && point.route_type !== "via")
        throw Error(`Unsupported power fanout primitive: ${point.route_type}`)
      return { ...point, x: point.x + origin.x, y: point.y + origin.y }
    }),
  }))
}

function supply(signal: string, component: Am3352Component) {
  // Preserve the reference TSX's explicit GND ties as well as named grounds.
  if (
    signal.startsWith("VSS") ||
    (component === "soc" && ["VREFN", "RTC_KALDO_ENn", "VPP"].includes(signal))
  )
    return { net: "GND", role: "ground" as const }
  if (signal.startsWith("CAP_VDD"))
    return { net: signal, role: "decoupling_output" as const }
  if (signal === "VDD_MPU_MON") return { net: signal, role: "monitor" as const }
  if (!signal.startsWith("VDD")) return undefined
  return {
    net: component === "ram" || signal === "VDDS_DDR" ? "DDR_1V5" : signal,
    role: "supply" as const,
  }
}

function powerPads(input: SimpleRouteJson, ownership: OwnershipManifest) {
  const pads: PowerPad[] = []
  for (const component of ["soc", "ram"] as const) {
    const chip = ownership.components[component]
    for (const obstacle of input.obstacles) {
      if (obstacle.componentId !== chip.componentId) continue
      const native = obstacle as typeof obstacle & {
        circuitJsonMetadata: {
          pcb_smtpad_id: string
          pcb_port_id: string
          source_port_name: string
        }
      }
      const ball = native.circuitJsonMetadata.source_port_name
      const signal = chip.ballSignals[ball]
      if (!signal) throw Error(`${chip.name}.${ball}: missing ball label`)
      const rail = supply(signal, component)
      if (!rail) continue
      pads.push({
        component,
        componentId: chip.componentId,
        componentName: chip.name,
        ball,
        signal,
        ...rail,
        connectionName: `power_${chip.name}_${ball}`,
        pcbPortId: native.circuitJsonMetadata.pcb_port_id,
        pcbSmtpadId: native.circuitJsonMetadata.pcb_smtpad_id,
        x: obstacle.center.x,
        y: obstacle.center.y,
        layer: obstacle.layers[0],
      })
    }
  }
  if (pads.length !== 161)
    throw Error(`Expected 161 power-related pads, got ${pads.length}`)
  return pads
}
function powerConnection(pad: PowerPad): PowerConnection {
  return {
    name: pad.connectionName,
    source_trace_id: pad.connectionName,
    netConnectionName: pad.net,
    nominalTraceWidth: 0.1,
    width: 0.1,
    pointsToConnect: [
      {
        x: pad.x,
        y: pad.y,
        layer: pad.layer,
        pcb_port_id: pad.pcbPortId,
        pointId: pad.pcbPortId,
      },
    ],
  }
}
function addPowerOwnership(input: SimpleRouteJson, pads: PowerPad[]) {
  for (const pad of pads) {
    const obstacle = input.obstacles.find((o) =>
      o.connectedTo.includes(pad.pcbSmtpadId),
    )
    if (!obstacle) throw Error(`Missing native pad ${pad.pcbSmtpadId}`)
    obstacle.connectedTo.push(pad.connectionName, pad.net)
  }
}

/** Regenerate the FanoutSolver input in component-local mm, +X right/+Y up.
 * Only translations are applied; every original pad diameter and spacing stays exact. */
export async function prepareAm3352PowerFanout(component: Am3352Component) {
  const [input, ownership] = await Promise.all([
    loadAm3352NativeInput(),
    loadOwnership(),
  ])
  if (am3352Hash(input) !== ownership.source.inputSha256)
    throw Error("Native AM3352 input provenance changed")
  const chip = ownership.components[component]
  const pads = powerPads(input, ownership).filter(
    (p) => p.component === component,
  )
  addPowerOwnership(input, pads)
  const localPads = pads.map((p) => ({
    ...p,
    x: p.x - chip.center.x,
    y: p.y - chip.center.y,
  }))
  const obstacles = input.obstacles
    .filter((o) => o.componentId === chip.componentId)
    .map((o) => ({
      ...o,
      center: { x: o.center.x - chip.center.x, y: o.center.y - chip.center.y },
    }))
  const componentBounds = {
    minX: Math.min(...obstacles.map((o) => o.center.x - o.width / 2)),
    maxX: Math.max(...obstacles.map((o) => o.center.x + o.width / 2)),
    minY: Math.min(...obstacles.map((o) => o.center.y - o.height / 2)),
    maxY: Math.max(...obstacles.map((o) => o.center.y + o.height / 2)),
  }
  const bounds = {
    minX: componentBounds.minX - 1,
    maxX: componentBounds.maxX + 1,
    minY: componentBounds.minY - 1,
    maxY: componentBounds.maxY + 1,
  }
  const fanoutInput = {
    ...input,
    bounds,
    obstacles,
    connections: localPads.map(powerConnection),
    buses: [],
    differentialPairs: [],
    traces: [],
  }
  const options: FanoutSolverOptions = {
    sourceComponentId: chip.componentId,
    componentBounds: { [chip.componentId]: componentBounds },
    sharedBoundary: bounds,
    escapeLayers: ["top", "inner1", "inner2", "bottom"],
    allowBlindAndBuriedVias: false,
    allowSameNetMerges: true,
    traceWidth: 0.1,
    clearance: 0.1,
    viaDiameter: 0.3,
    viaHoleDiameter: 0.15,
    buses: localPads.map((pad) => ({
      busId: pad.connectionName,
      connectionNames: [pad.connectionName],
      sourceComponentId: chip.componentId,
      direction:
        Math.abs(pad.x) > Math.abs(pad.y)
          ? pad.x < 0
            ? "left"
            : "right"
          : pad.y < 0
            ? "down"
            : "up",
      termination: {
        type: "plane",
        layer: pad.role === "ground" ? "inner1" : "inner2",
      },
    })),
  }
  return { input: fanoutInput, options }
}

/** Load only 47 unresolved signals. Fixed power copper is real trace/via data,
 * not extra rectangular keepouts; all coordinate translations are board-world mm. */
export async function loadAm3352Sample(name: Am3352SampleName) {
  const placement = am3352SamplePlacements.find((p) => p.name === name)
  if (!placement) throw Error(`Unknown AM3352 sample ${name}`)
  const [input, ownership, soc, ram] = await Promise.all([
    loadAm3352NativeInput(),
    loadOwnership(),
    loadAm3352FanoutRecord("soc"),
    loadAm3352FanoutRecord("ram"),
  ])
  if (am3352Hash(input) !== ownership.source.inputSha256)
    throw Error("Native AM3352 input provenance changed")
  if ("allowedLayers" in placement)
    input.allowedLayers = [...placement.allowedLayers]
  const pads = powerPads(input, ownership)
  addPowerOwnership(input, pads)
  const ramCenter = ownership.components.ram.center
  const dx = placement.ram.x - ramCenter.x,
    dy = placement.ram.y - ramCenter.y
  const ramPorts = new Set(
    input.obstacles
      .filter((o) => o.componentId === ownership.components.ram.componentId)
      .map((o) => {
        const port = (
          o as typeof o & { circuitJsonMetadata: { pcb_port_id: string } }
        ).circuitJsonMetadata?.pcb_port_id
        if (!port) throw Error("RAM pad is missing its native port identity")
        return port
      }),
  )
  for (const obstacle of input.obstacles)
    if (obstacle.componentId === ownership.components.ram.componentId)
      obstacle.center = { x: obstacle.center.x + dx, y: obstacle.center.y + dy }
  for (const connection of input.connections)
    for (const point of connection.pointsToConnect)
      if (ramPorts.has(point.pcb_port_id ?? point.pointId ?? "")) {
        point.x += dx
        point.y += dy
      }
  const translatedPads = pads.map((p) =>
    p.component === "ram" ? { ...p, x: p.x + dx, y: p.y + dy } : p,
  )
  const componentTranslations = {
    soc: ownership.components.soc.center,
    ram: { ...placement.ram },
  }
  const provenance = {} as Record<Am3352Component, FanoutRecordReference>
  const fixedFanoutTraces: Trace[] = []
  for (const [component, record] of [
    ["soc", soc],
    ["ram", ram],
  ] as const) {
    const prepared = await prepareAm3352PowerFanout(component)
    if (
      record.inputSha256 !== am3352Hash(prepared.input) ||
      record.optionsSha256 !== am3352Hash(prepared.options) ||
      record.tracesSha256 !== am3352Hash(record.output.fanoutTraces) ||
      record.outputSha256 !== am3352Hash(record.output) ||
      !record.output.validation.valid
    )
      throw Error(`${component}: FanoutSolver provenance mismatch`)
    const origin = componentTranslations[component]
    fixedFanoutTraces.push(
      ...translateAm3352FanoutTraces(record.output.fanoutTraces, origin),
    )
    provenance[component] = {
      file: `tests/fixtures/am3352-ram/${component}-power-fanout.json`,
      inputSha256: record.inputSha256,
      optionsSha256: record.optionsSha256,
      tracesSha256: record.tracesSha256,
      outputSha256: record.outputSha256,
      generator: record.generator,
    }
  }
  input.traces = fixedFanoutTraces
  if (
    input.connections.length !== 47 ||
    input.obstacles.length !== 420 ||
    input.traces.length !== 161
  )
    throw Error("Incomplete AM3352 benchmark input")
  const metadata: Am3352SampleMetadata = {
    name,
    placement: {
      cpu: ownership.components.soc.center,
      ram: { ...placement.ram },
    },
    componentTranslations,
    signalNames: ownership.signalNames,
    fixedFanoutTraces,
    powerConnections: translatedPads.map(powerConnection),
    powerPadManifest: translatedPads,
    provenance,
  }
  return { input, metadata }
}

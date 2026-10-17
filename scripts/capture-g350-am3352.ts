import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import metadata from "../tests/fixtures/g350-am3352/metadata.json"

/** Re-capture through the board's pinned public Core adapter, independently of
 * the Bus Lanes implementation. This is optional; normal reproduction needs
 * only the committed fixtures and this repository's regular dependencies.
 */
if (import.meta.main) {
  const [coreArgument, ...extra] = process.argv.slice(2)
  if (!coreArgument || extra.length)
    throw Error(
      "Usage: bun scripts/capture-g350-am3352.ts /path/to/core/dist/index.js",
    )
  const coreEntry = resolve(coreArgument)
  const corePackage = JSON.parse(
    readFileSync(resolve(dirname(coreEntry), "../package.json"), "utf8"),
  )
  if (
    corePackage.name !== "@tscircuit/core" ||
    corePackage.version !== metadata.capturedWith.core
  )
    throw Error("Use the recorded Core version to reproduce the capture")
  const root = resolve(import.meta.dir, "../tests/fixtures/g350-am3352")
  const bytes = readFileSync(resolve(root, "circuit.json"))
  const full = JSON.parse(bytes.toString()) as Array<Record<string, any>>
  const names = new Set(Object.values(metadata.componentNames))
  const netNames = new Set(Object.values(metadata.netNames))
  const sourceIds = new Set(
    full
      .filter((e) => e.type === "source_component" && names.has(e.name))
      .map((e) => e.source_component_id),
  )
  const componentIds = new Set(
    full
      .filter(
        (e) =>
          e.type === "pcb_component" && sourceIds.has(e.source_component_id),
      )
      .map((e) => e.pcb_component_id),
  )
  const portIds = new Set(
    full
      .filter(
        (e) => e.type === "source_port" && sourceIds.has(e.source_component_id),
      )
      .map((e) => e.source_port_id),
  )
  const netIds = new Set(
    full
      .filter((e) => e.type === "source_net" && netNames.has(e.name))
      .map((e) => e.source_net_id),
  )
  const traceIds = new Set(
    full
      .filter(
        (e) =>
          e.type === "source_trace" &&
          e.connected_source_port_ids.length &&
          e.connected_source_port_ids.every((id: string) => portIds.has(id)) &&
          e.connected_source_net_ids.every((id: string) => netIds.has(id)),
      )
      .map((e) => e.source_trace_id),
  )
  const circuit = full.filter((e) => {
    if (["source_board", "source_group", "pcb_board"].includes(e.type))
      return true
    if (
      [
        "source_component",
        "source_port",
        "source_component_internal_connection",
      ].includes(e.type)
    )
      return sourceIds.has(e.source_component_id)
    if (e.type === "source_net") return netIds.has(e.source_net_id)
    if (e.type === "source_trace") return traceIds.has(e.source_trace_id)
    if (e.type === "source_bus")
      return e.source_trace_ids.every((id: string) => traceIds.has(id))
    return (
      [
        "pcb_component",
        "pcb_port",
        "pcb_smtpad",
        "pcb_plated_hole",
        "pcb_courtyard_outline",
        "pcb_courtyard_circle",
        "pcb_courtyard_rect",
      ].includes(e.type) && componentIds.has(e.pcb_component_id)
    )
  })
  const { getSimpleRouteJsonFromCircuitJson } = await import(
    pathToFileURL(coreEntry).href
  )
  const { simpleRouteJson: complete } = getSimpleRouteJsonFromCircuitJson({
    circuitJson: circuit,
    minTraceWidth: 0.1016,
    nominalTraceWidth: 0.1016,
  })
  const connectionNames = new Set(complete.connections.map((c: any) => c.name))
  // Drop repeated off-board aliases while keeping ownership of every physical
  // pad by every captured net, as well as its pad/port identity. No geometry moves.
  for (const obstacle of complete.obstacles) {
    obstacle.connectedTo = [
      ...new Set<string>(
        obstacle.connectedTo.filter(
          (id: string) =>
            connectionNames.has(id) ||
            id.startsWith("source_net_") ||
            id === obstacle.circuitJsonMetadata?.pcb_port_id ||
            id === obstacle.circuitJsonMetadata?.pcb_smtpad_id,
        ),
      ),
    ].sort()
    delete obstacle.offBoardConnectsTo
    delete obstacle.netIsAssignable
  }
  const sourceBuses = circuit.filter((e) => e.type === "source_bus")
  complete.buses = sourceBuses
    .filter((b) =>
      ["DDR_RESET", "DDR_BYTE0", "DDR_BYTE1", "DDR_COMMAND_CLOCK"].includes(
        b.name,
      ),
    )
    .map((b) => ({
      busId: b.name,
      connectionNames: b.source_trace_ids,
      traceWidth: 0.1016,
      allowedLayers: ["top", "bottom"],
      preferredLayers: ["bottom", "top"],
      ...(b.max_length_skew === undefined
        ? {}
        : { maxLengthSkew: b.max_length_skew }),
    }))
  complete.differentialPairs = sourceBuses
    .filter((b) => b.name.endsWith("_PAIR"))
    .map((b) => ({
      connectionNames: b.source_trace_ids,
      lengthTolerance: b.max_length_skew,
      traceGap: metadata.pairTraceGapMm,
    }))
  complete.traces = []
  const native = {
    ...complete,
    allowedLayers: ["top", "bottom"],
    connections: complete.connections.filter(
      (c: any) => c.name in metadata.signalNames,
    ),
  }
  if (
    sourceIds.size !== 194 ||
    complete.obstacles.length !== 854 ||
    complete.connections.length !== 117 ||
    native.connections.length !== 49
  )
    throw Error("Capture lost components, pads or required connections")
  // Verify every byte before replacing anything. Unexpected captures stay local.
  const files = { "circuit.json": circuit, "native-input.json": complete }
  for (const [name, value] of Object.entries(files)) {
    const serialized = JSON.stringify(value, null, 2) + "\n"
    const hash = createHash("sha256").update(serialized).digest("hex")
    if (
      hash !== metadata.filesSha256[name as keyof typeof metadata.filesSha256]
    )
      throw Error(`Regenerated ${name} differs from its recorded hash`)
  }
  console.log(
    JSON.stringify({
      verified: true,
      components: 194,
      pads: 854,
      ddrSignals: 49,
      supportNets: 68,
      core: corePackage.version,
    }),
  )
}

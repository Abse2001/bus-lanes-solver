import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { SimpleRouteJson, Trace, Terminal, Wire } from "../lib"
import { distance } from "../lib/geometry"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import {
  am3352Hash,
  am3352SamplePlacements,
  loadAm3352FanoutRecord,
  loadAm3352NativeInput,
  prepareAm3352PowerFanout,
  translateAm3352FanoutTraces,
  type Am3352SampleMetadata,
  type PowerConnection,
} from "./am3352-samples"

const fail = (message: string): never => {
  throw Error(`Invalid AM3352 sample: ${message}`)
}
const same = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  distance(a, b) <= 1e-8
const traceMap = (traces: Trace[]) => {
  const result = new Map<string, Trace>()
  for (const trace of traces) {
    if (result.has(trace.pcb_trace_id)) fail("duplicate fixed trace ID")
    result.set(trace.pcb_trace_id, trace)
  }
  return result
}

/** Independently audit the four native AM3352/RAM benchmark placements. Fixed
 * power is known electrical copper, never another unresolved routing request.
 * Omit signalTraces for the input audit; pass only newly generated signals for
 * the completed audit. Malformed fixtures throw; routing validity is reported. */
export async function validateAm3352Sample(
  input: SimpleRouteJson,
  metadata: Am3352SampleMetadata,
  signalTraces?: Trace[],
) {
  if (
    input.layerCount !== 4 ||
    input.outline?.length ||
    input.connections.length !== 47 ||
    input.obstacles.length !== 420 ||
    input.buses?.length !== 2 ||
    input.differentialPairs?.length !== 3 ||
    !metadata.fixedFanoutTraces.length
  )
    fail("incomplete native signal/power fixture")
  const names = new Set(input.connections.map((c) => c.name))
  if (
    names.size !== 47 ||
    Object.keys(metadata.signalNames).length !== 47 ||
    [...names].some((name) => !metadata.signalNames[name]) ||
    input.connections.some((c) => c.pointsToConnect.length !== 2)
  )
    fail("signal identities or terminals changed")
  const fixed = traceMap(input.traces ?? [])
  if (fixed.size !== metadata.fixedFanoutTraces.length)
    fail("missing or extra fixed power copper")
  for (const trace of metadata.fixedFanoutTraces)
    if (
      !fixed.has(trace.pcb_trace_id) ||
      am3352Hash(fixed.get(trace.pcb_trace_id)) !== am3352Hash(trace)
    )
      fail("fixed power copper changed")

  const placement =
    am3352SamplePlacements.find((p) => p.name === metadata.name) ??
    fail("unknown sample placement")
  if (
    am3352Hash(metadata.placement.cpu) !== am3352Hash({ x: 0, y: 0 }) ||
    am3352Hash(metadata.placement.ram) !== am3352Hash(placement.ram) ||
    am3352Hash(metadata.componentTranslations.soc) !==
      am3352Hash(metadata.placement.cpu) ||
    am3352Hash(metadata.componentTranslations.ram) !== am3352Hash(placement.ram)
  )
    fail("sample is not one of the four declared component placements")
  const native = await loadAm3352NativeInput()
  const rules = ({
    connections: _connections,
    obstacles: _obstacles,
    traces: _traces,
    ...rules
  }: SimpleRouteJson) => rules
  if (am3352Hash(rules(input)) !== am3352Hash(rules(native)))
    fail("native board rules or signal constraints changed")

  const expectedPower = new Map<string, PowerConnection>()
  const expectedTraces = new Map<string, Trace>()
  let ramComponentId: string | undefined
  for (const component of ["soc", "ram"] as const) {
    const [record, prepared] = await Promise.all([
      loadAm3352FanoutRecord(component),
      prepareAm3352PowerFanout(component),
    ])
    const reference = metadata.provenance[component]
    if (
      record.component !== component ||
      record.coordinateFrame !== "component_local_mm" ||
      !record.output.validation.valid ||
      reference.file !==
        `tests/fixtures/am3352-ram/${component}-power-fanout.json` ||
      record.generator.name !== "@tscircuit/fanout-solver" ||
      am3352Hash(record.generator) !== am3352Hash(reference.generator) ||
      am3352Hash(prepared.input) !== reference.inputSha256 ||
      record.inputSha256 !== reference.inputSha256 ||
      am3352Hash(prepared.options) !== reference.optionsSha256 ||
      am3352Hash(record.options) !== reference.optionsSha256 ||
      record.optionsSha256 !== reference.optionsSha256 ||
      am3352Hash(record.output.fanoutTraces) !== reference.tracesSha256 ||
      record.tracesSha256 !== reference.tracesSha256 ||
      am3352Hash(record.output) !== reference.outputSha256 ||
      record.outputSha256 !== reference.outputSha256
    )
      fail(`${component}: fixed FanoutSolver provenance changed`)
    const origin = metadata.componentTranslations[component]
    if (component === "ram") ramComponentId = prepared.options.sourceComponentId
    for (const connection of prepared.input.connections) {
      const translated = {
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((p) => ({
          ...p,
          x: p.x + origin.x,
          y: p.y + origin.y,
        })),
      } as PowerConnection
      expectedPower.set(connection.name, translated)
    }
    for (const trace of translateAm3352FanoutTraces(
      record.output.fanoutTraces,
      origin,
    ))
      expectedTraces.set(trace.pcb_trace_id, trace)
  }
  if (!ramComponentId) fail("missing native RAM component identity")
  const dx = placement.ram.x - am3352SamplePlacements[0].ram.x
  const dy = placement.ram.y - am3352SamplePlacements[0].ram.y
  const ramPorts = new Set(
    native.obstacles
      .filter((o) => o.componentId === ramComponentId)
      .flatMap((o) => o.connectedTo),
  )
  const translatedConnections = native.connections.map((c) => ({
    ...c,
    pointsToConnect: c.pointsToConnect.map((p) =>
      ramPorts.has(p.pcb_port_id ?? p.pointId ?? "")
        ? { ...p, x: p.x + dx, y: p.y + dy }
        : p,
    ),
  }))
  if (am3352Hash(translatedConnections) !== am3352Hash(input.connections))
    fail("native signal terminals or widths changed")
  for (let i = 0; i < native.obstacles.length; i++) {
    const original = native.obstacles[i],
      pad = input.obstacles[i]
    const translated = {
      ...original,
      center: {
        x:
          original.center.x +
          (original.componentId === ramComponentId ? dx : 0),
        y:
          original.center.y +
          (original.componentId === ramComponentId ? dy : 0),
      },
      connectedTo: [...original.connectedTo],
    }
    for (const power of metadata.powerPadManifest)
      if (original.connectedTo.includes(power.pcbSmtpadId))
        translated.connectedTo.push(power.connectionName, power.net)
    if (am3352Hash(translated) !== am3352Hash(pad))
      fail("native component pad geometry or ownership changed")
  }
  if (
    !expectedPower.size ||
    expectedPower.size !== expectedTraces.size ||
    expectedPower.size !== metadata.powerConnections.length ||
    expectedPower.size !== metadata.powerPadManifest.length ||
    expectedTraces.size !== metadata.fixedFanoutTraces.length
  )
    fail("incomplete native power FanoutSolver records")
  const powerNames = new Set<string>()
  for (const connection of metadata.powerConnections) {
    if (
      powerNames.has(connection.name) ||
      names.has(connection.name) ||
      !expectedPower.has(connection.name) ||
      am3352Hash(connection) !== am3352Hash(expectedPower.get(connection.name))
    )
      fail("power domains or original pad identities changed")
    powerNames.add(connection.name)
  }
  for (const trace of metadata.fixedFanoutTraces) {
    if (
      !expectedTraces.has(trace.pcb_trace_id) ||
      am3352Hash(trace) !==
        am3352Hash(expectedTraces.get(trace.pcb_trace_id)) ||
      !powerNames.has(trace.connection_name ?? "") ||
      trace.route.filter((p) => p.route_type === "via").length !== 1
    )
      fail("fixed power dogbone differs from the native solver record")
  }
  const pads = new Set<string>()
  for (const pad of metadata.powerPadManifest) {
    const connection = expectedPower.get(pad.connectionName)
    const obstacle = input.obstacles.find(
      (o) =>
        o.componentId === pad.componentId &&
        o.connectedTo.includes(pad.pcbSmtpadId),
    )
    const routes = metadata.fixedFanoutTraces.filter(
      (t) => t.connection_name === pad.connectionName,
    )
    const terminal = connection?.pointsToConnect[0]
    if (
      pads.has(pad.pcbSmtpadId) ||
      !obstacle ||
      !terminal ||
      connection?.netConnectionName !== pad.net ||
      terminal.pcb_port_id !== pad.pcbPortId ||
      !same(terminal, pad) ||
      !same(obstacle.center, pad) ||
      !obstacle.connectedTo.includes(pad.connectionName) ||
      !obstacle.connectedTo.includes(pad.net) ||
      !obstacle.layers.includes(pad.layer) ||
      routes.length !== 1 ||
      ![routes[0].route[0], routes[0].route.at(-1)!].some(
        (p) => p.route_type === "wire" && p.layer === pad.layer && same(p, pad),
      )
    )
      fail("fixed power dogbone lost its native pad join or ownership")
    pads.add(pad.pcbSmtpadId)
  }
  const validationInput = {
    ...input,
    connections: [...input.connections, ...metadata.powerConnections],
  }
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const audit = (traces: Trace[]) =>
    validateRoutedCopperDrc({
      inputSrj: validationInput,
      routedSrj: { ...validationInput, traces },
      clearance,
      allowBlindAndBuriedVias: input.allowBlindAndBuriedVias ?? false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  const fixedDrc = audit(metadata.fixedFanoutTraces)
  const issues: string[] = []
  let complete = false
  if (signalTraces) {
    complete =
      signalTraces.length === 47 &&
      names.size === new Set(signalTraces.map((t) => t.connection_name)).size &&
      input.connections.every((connection) => {
        const routes = signalTraces.filter(
          (t) => t.connection_name === connection.name,
        )
        if (routes.length !== 1 || routes[0].route.length < 2) return false
        const first = routes[0].route[0],
          last = routes[0].route.at(-1)!
        const [a, b] = connection.pointsToConnect
        const matches = (p: typeof first, terminal: Terminal) =>
          p.route_type === "wire" &&
          p.layer === terminal.layer &&
          same(p, terminal)
        return (
          (matches(first, a) && matches(last, b)) ||
          (matches(first, b) && matches(last, a))
        )
      })
    if (!complete)
      issues.push(
        "signals are not connected exactly once between original pads",
      )
    const traceIds = new Set(fixed.keys())
    for (const trace of signalTraces) {
      if (traceIds.has(trace.pcb_trace_id))
        issues.push("duplicate output trace ID")
      traceIds.add(trace.pcb_trace_id)
      const vias = trace.route.flatMap((p, i) =>
        p.route_type === "via" ? [i] : [],
      )
      if (vias.length !== 2) {
        issues.push(
          `${trace.connection_name}: expected two terminal dogbones and no carrier vias`,
        )
        continue
      }
      const carrier = trace.route.slice(vias[0] + 1, vias[1])
      const layer = (carrier[0] as Wire | undefined)?.layer
      if (
        carrier.length < 2 ||
        !carrier.every((p) => p.route_type === "wire" && p.layer === layer) ||
        !tuningPathIsSelfClear(carrier, (carrier[0] as Wire).width + clearance)
      )
        issues.push(
          `${trace.connection_name}: carrier must be a clear single-layer route`,
        )
    }
  }
  const busLengths = busLengthReports(input, signalTraces ?? [])
  const pairLengths = pairLengthReports(input, signalTraces ?? [])
  const matched =
    complete &&
    busLengths.every((b) => b.matched) &&
    pairLengths.every((p) => p.matched)
  if (signalTraces && !matched)
    issues.push("declared bus or pair length matching is incomplete")
  const combinedDrc = signalTraces
    ? audit([...metadata.fixedFanoutTraces, ...signalTraces])
    : null
  return {
    valid:
      fixedDrc.valid &&
      (signalTraces === undefined ||
        (complete && matched && combinedDrc!.valid && !issues.length)),
    complete,
    matched,
    fixedPowerTraces: fixed.size,
    fixedPowerVias: metadata.fixedFanoutTraces.reduce(
      (n, t) => n + t.route.filter((p) => p.route_type === "via").length,
      0,
    ),
    fixedPowerPadJoins: pads.size,
    fixedDrc,
    combinedDrc,
    busLengths,
    pairLengths,
    issues,
  }
}

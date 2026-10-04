import {
  checkEachPcbTraceNonOverlapping,
  checkPcbTraceSelfShorts,
} from "@tscircuit/checks"
import type { AnyCircuitElement, LayerRef } from "circuit-json"
import { BusLanesPipelineSolver, type SimpleRouteJson } from "../lib"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { distance } from "../lib/geometry"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { measureAm3352RoutingQuality } from "./measure-am3352-routing-quality"
import native from "../tests/fixtures/am3352-ram/native-input.json"
import buses from "../tests/fixtures/am3352-ram/multilayer-matching-buses.json"

// Only bus declarations differ from the original immutable core input. This
// is the real core PR input: 2 byte/strobe groups + 24 address/clock signals.
export function coreMultilayerInput(): SimpleRouteJson {
  return structuredClone({ ...native, buses }) as unknown as SimpleRouteJson
}
export function validateCoreMultilayer(solver: BusLanesPipelineSolver) {
  if (
    !solver.solved ||
    solver.failed ||
    solver.traces.length !== solver.input.connections.length ||
    new Set(solver.traces.map((trace) => trace.connection_name)).size !==
      solver.input.connections.length
  )
    throw Error("Refusing incomplete core DDR routing")
  for (const connection of solver.input.connections) {
    const trace = solver.traces.find(
      (trace) => trace.connection_name === connection.name,
    )
    if (!trace) throw Error(`Core DDR missing ${connection.name}`)
    const endpoints = [trace.route[0], trace.route.at(-1)!]
    if (
      connection.pointsToConnect.length !== 2 ||
      connection.pointsToConnect.some(
        (terminal) =>
          !endpoints.some(
            (point) =>
              point?.route_type === "wire" &&
              distance(point, terminal) < 1e-8 &&
              (terminal.layers ?? [terminal.layer]).includes(point.layer),
          ),
      )
    )
      throw Error(`Core DDR disconnected terminal for ${connection.name}`)
  }
  const busReports = busLengthReports(solver.input, solver.traces)
  const pairReports = pairLengthReports(solver.input, solver.traces)
  if ([...busReports, ...pairReports].some((report) => !report.matched))
    throw Error("Core DDR length matching failed")
  if (!routeAnglesAreConventional(solver.traces))
    throw Error("Core DDR has illegal angles")
  const circuit: AnyCircuitElement[] = []
  for (const connection of solver.input.connections)
    circuit.push({
      type: "source_trace",
      source_trace_id: connection.source_trace_id ?? connection.name,
      name: connection.name,
      connected_source_port_ids: [],
      connected_source_net_ids: [],
    })
  for (const bus of solver.input.buses ?? [])
    circuit.push({
      type: "source_bus",
      source_bus_id: bus.busId,
      name: bus.name,
      source_trace_ids: bus.connectionNames.map(
        (name) =>
          solver.input.connections.find(
            (connection) => connection.name === name,
          )!.source_trace_id ?? name,
      ),
      max_length_skew: bus.maxLengthSkew,
    })
  for (const trace of solver.traces) {
    circuit.push({
      type: "pcb_trace",
      pcb_trace_id: trace.pcb_trace_id,
      source_trace_id: trace.source_trace_id,
      route: trace.route.map((point) =>
        point.route_type === "wire"
          ? { ...point, layer: point.layer as LayerRef }
          : {
              route_type: "via",
              x: point.x,
              y: point.y,
              from_layer: point.from_layer as LayerRef,
              to_layer: point.to_layer as LayerRef,
            },
      ),
    })
    trace.route.forEach((point, index) => {
      if (point.route_type !== "via") return
      circuit.push({
        type: "pcb_via",
        pcb_via_id: `${trace.pcb_trace_id}_via_${index}`,
        pcb_trace_id: trace.pcb_trace_id,
        x: point.x,
        y: point.y,
        outer_diameter:
          point.via_diameter ?? solver.input.minViaPadDiameter ?? 0.6,
        hole_diameter:
          point.via_hole_diameter ?? solver.input.minViaHoleDiameter ?? 0.3,
        layers: (point.layers ?? [
          point.from_layer,
          point.to_layer,
        ]) as LayerRef[],
      })
    })
  }
  const errors = [
    ...checkPcbTraceSelfShorts(circuit),
    ...checkEachPcbTraceNonOverlapping(circuit, {
      minClearance: solver.input.minTraceToPadEdgeClearance ?? 0.1,
    }),
  ]
  if (errors.length)
    throw Error(`Core DDR native copper DRC failed: ${JSON.stringify(errors)}`)
  const layerCounts: Record<string, number> = {}
  for (const trace of solver.traces) {
    const vias = trace.route.flatMap((point, index) =>
      point.route_type === "via" ? [index] : [],
    )
    if (vias.length !== 2) throw Error("Core DDR must have two local dogbones")
    const carrier = trace.route.slice(vias[0] + 1, vias[1])
    if (
      !carrier.length ||
      carrier.some(
        (point) =>
          point.route_type !== "wire" ||
          point.layer !== (carrier[0] as { layer: string }).layer,
      )
    )
      throw Error("Core DDR carrier changed layer")
    const layer = (carrier[0] as { layer: string }).layer
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1
  }
  const command = solver.input.buses!.find(
    (bus) => bus.busId === "DDR_ADDR_CTRL",
  )!
  const commandLayers = new Set(
    command.connectionNames.map((name) => {
      const trace = solver.traces.find(
        (trace) => trace.connection_name === name,
      )!
      return trace.route.find((point) => point.route_type === "via")!.to_layer
    }),
  )
  if (commandLayers.size < 2)
    throw Error("Expanded address/clock test must exercise multiple layers")
  const quality = measureAm3352RoutingQuality(solver.input, solver.traces)
  if (
    quality.issues.length ||
    quality.pairGaps.some((pair) => !pair.matched) ||
    quality.exteriorPairGaps.some((pair) => !pair.matched)
  )
    throw Error("Core DDR pair coupling or routing geometry failed")
  return {
    complete: true,
    nativeCopperDrc: true,
    layerCounts,
    busReports,
    pairReports,
    quality,
  }
}

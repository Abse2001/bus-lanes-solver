import { expect, test } from "bun:test"
import {
  getCopperLayerNames,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { BusLanesPipelineSolver } from "../lib/bus-lanes-pipeline-solver"
import { localDogboneInput } from "../lib/local-dogbone-input"
import { localSignalSiteCandidates } from "../lib/reachable-signal-dogbones"
import { signalDogboneOptions } from "../lib/repair-bus-dogbones"
import type { SimpleRouteJson } from "../lib/types"

function fixture(): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["inner1"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    bounds: { minX: -5, maxX: 5, minY: -2, maxY: 2 },
    connections: [
      {
        name: "route_a",
        source_trace_id: "source_a",
        pointsToConnect: [-2.4, 2.4].map((x) => ({ x, y: 0, layer: "top" })),
      },
    ],
    obstacles: [-2.4, 2.4].flatMap((offset, component) =>
      [0, 0.8].flatMap((x) =>
        [0, 0.8].map((y) => ({
          componentId: `package_${component}`,
          shape: "circle" as const,
          center: { x: offset + x, y },
          width: 0.4,
          height: 0.4,
          layers: ["top"],
          // One pad declares the name/source electrical alias; the first pad names
          // only the source token. Original native DRC propagates that identity.
          connectedTo:
            !x && !y
              ? component
                ? ["source_a", "route_a"]
                : ["source_a"]
              : [`other_${component}_${x}_${y}`],
        })),
      ),
    ),
  }
}

test("source-only pad ownership reaches full pipeline dogbones without changing native metadata", () => {
  const input = fixture(),
    before = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input, { smoothTuning: false })
  solver.solve()
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toHaveLength(1)
  expect(solver.traces[0].connection_name).toBe("route_a")
  expect(solver.traces[0].source_trace_id).toBe("source_a")
  const vias = solver.traces[0].route.filter(
    (point) => point.route_type === "via",
  )
  expect(vias).toHaveLength(2)
  expect(
    vias.every((via) => via.layers?.join() === getCopperLayerNames(4).join()),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: solver.getOutput(),
      clearance: 0.05,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect(input).toEqual(before)
  expect(solver.getOutput().obstacles).toEqual(before.obstacles)
})

test("reachable-site enumeration accepts source-only pad aliases", () => {
  const input = fixture(),
    before = structuredClone(input)
  const sites = localSignalSiteCandidates(
    input,
    input.connections[0],
    signalDogboneOptions(input, new Map([["route_a", "inner1"]])),
  )
  expect(sites.every((end) => end.length > 0)).toBe(true)
  expect(input).toEqual(before)
})

test("fanout adapter retains all exact shared-source aliases without mutating native ownership", () => {
  const input = fixture()
  input.connections.push({ ...input.connections[0], name: "route_b" })
  const before = structuredClone(input),
    adapted = localDogboneInput(input)
  expect(adapted.obstacles[0].connectedTo).toEqual([
    "source_a",
    "route_a",
    "route_b",
  ])
  expect(adapted.obstacles[1]).toBe(input.obstacles[1])
  expect(adapted.connections).toBe(input.connections)
  expect(localDogboneInput(adapted)).toBe(adapted)
  expect(input).toEqual(before)
})

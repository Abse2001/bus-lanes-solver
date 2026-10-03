import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  reachableSignalDogbones,
  localSignalSiteCandidates,
} from "../lib/reachable-signal-dogbones"
import { signalDogboneOptions } from "../lib/repair-bus-dogbones"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { VectorScene, fixedCopper } from "../lib/vector-scene"
import type { SimpleRouteJson, Trace } from "../lib/types"
function fixture(turns: number): SimpleRouteJson {
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["inner1", "inner2"],
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -8, maxX: 8, minY: -8, maxY: 8 },
    connections: [
      {
        name: "renamed_signal",
        pointsToConnect: [
          { x: 0, y: 0, layer: "top" },
          { x: 4.8, y: 0, layer: "top" },
        ],
      },
    ],
    obstacles: [],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "immutable_guard",
        connection_name: "guard",
        route: [
          [0, -0.8],
          [0.8, -0.8],
          [0.8, 0],
          [0, 0],
          [0, -0.8],
        ].map(([x, y]) => ({
          route_type: "wire",
          x,
          y,
          layer: "inner1",
          width: 0.04,
        })),
      },
    ],
  }
  for (const [componentId, offset] of [
    ["first_package", 0],
    ["second_package", 4.8],
  ] as const)
    for (let row = 0; row < 2; row++)
      for (let column = 0; column < 2; column++)
        input.obstacles.push({
          componentId,
          shape: "circle",
          center: { x: offset + column * 0.8, y: row * 0.8 },
          width: 0.4,
          height: 0.4,
          layers: ["top"],
          connectedTo: row === 0 && column === 0 ? ["renamed_signal"] : [],
        })
  const rotate = (p: { x: number; y: number }) => {
    for (let i = 0; i < turns; i++) [p.x, p.y] = [-p.y, p.x]
  }
  for (const c of input.connections)
    for (const p of c.pointsToConnect) rotate(p)
  for (const o of input.obstacles) rotate(o.center)
  for (const t of input.traces!) for (const p of t.route) rotate(p)
  return input
}
for (let rotation = 0; rotation < 4; rotation++)
  test(`reachable dogbones clear a sealed preferred site after ${rotation} quarter turns`, () => {
    const input = fixture(rotation),
      before = structuredClone(input),
      targets = new Map([["renamed_signal", "inner1"]]),
      options = signalDogboneOptions(input, targets)
    const sites = localSignalSiteCandidates(
      input,
      input.connections[0],
      options,
    )
    expect(sites.every((end) => end.length > 1)).toBe(true)
    const generator = reachableSignalDogbones(
      input,
      options,
      new Map([["renamed_signal", ["inner1"]]]),
    )
    let result = generator.next(),
      steps = 0
    while (!result.done && steps++ < 20000) result = generator.next()
    expect(result.done).toBe(true)
    if (!result.done || !result.value) throw Error("No handoff assignment")
    const { connections, traces } = result.value,
      local = { ...input, connections, traces: [...input.traces!, ...traces] },
      connection = connections[0],
      search = new GridVisibilitySearch(
        new VectorScene(local, connection, 0.1, fixedCopper(local)),
        connection.pointsToConnect[0],
        connection.pointsToConnect[1],
      )
    while (!search.solved && !search.failed) search.step()
    expect(search.solved).toBe(true)
    const carrier: Trace = {
      type: "pcb_trace",
      pcb_trace_id: "new_signal",
      connection_name: connection.name,
      route: search.result.map((p) => ({
        ...p,
        route_type: "wire",
        layer: "inner1",
        width: 0.1,
      })),
    }
    const drcInput = {
      ...input,
      connections: [
        ...input.connections,
        { name: "guard", pointsToConnect: [] },
      ],
    }
    expect(
      validateRoutedCopperDrc({
        inputSrj: drcInput,
        routedSrj: { ...drcInput, traces: [...local.traces, carrier] },
        clearance: 0.1,
        allowBlindAndBuriedVias: false,
      } as Parameters<typeof validateRoutedCopperDrc>[0]).issues,
    ).toEqual([])
    expect(input).toEqual(before)
    expect(traces).toHaveLength(2)
    expect(traces.every((t) => t.source_trace_id === "renamed_signal")).toBe(
      true,
    )
  })

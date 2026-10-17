import { expect, test } from "bun:test"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { initialSignalDogbones } from "../lib/initial-signal-dogbones"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import type { SurfaceNegotiationProgress } from "../lib/negotiate-surface-routes"
import { routeJointSurfaceBuses } from "../lib/route-joint-surface-buses"
import { signalDogboneOptions } from "../lib/repair-bus-dogbones"
import type { SimpleRouteJson, Trace } from "../lib/types"

test("joint surface routing preserves fixed copper while selecting complete native-pad approaches", () => {
  const lines = [
    ["P", -2],
    ["N", -2.24],
    ["A", 0],
    ["B", 1],
  ] as const
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.12,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    minTraceToPadEdgeClearance: 0.08,
    bounds: { minX: -6, maxX: 6, minY: -5, maxY: 5 },
    obstacles: lines.flatMap(([name, y]) =>
      [-3, 3].map((x) => ({
        componentId: x < 0 ? "driver" : "receiver",
        center: { x, y },
        width: 0.12,
        height: 0.12,
        layers: ["top"],
        connectedTo: [name],
      })),
    ),
    connections: lines.map(([name, y]) => ({
      name,
      pointsToConnect: [
        { x: -3, y, layer: "top" },
        { x: 3, y, layer: "top" },
      ],
    })),
    buses: [{ busId: "data", connectionNames: ["A", "B"], maxLengthSkew: 0.1 }],
    differentialPairs: [
      { connectionNames: ["P", "N"], lengthTolerance: 0.05, traceGap: 0.12 },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "supply",
        connection_name: "SUPPLY",
        route: [
          { route_type: "wire", x: -4, y: 4, layer: "top", width: 0.12 },
          { route_type: "wire", x: 4, y: 4, layer: "top", width: 0.12 },
        ],
      },
    ],
  }
  const before = structuredClone(input)
  const generated = initialSignalDogbones(
    input,
    signalDogboneOptions(
      input,
      new Map(input.connections.map((c) => [c.name, "bottom"])),
    ),
    0,
  )
  const allocation = {
    ...input,
    connections: generated.connections,
  } as SimpleRouteJson
  const progress: SurfaceNegotiationProgress[] = []
  const generator = routeJointSurfaceBuses(
    input,
    allocation,
    generated.traces as Trace[],
    new Map(input.connections.map((c) => [c.name, ["top", "bottom"]])),
    { smoothTuning: true, denseSearch: true },
    {
      negotiation: {
        congestionHistory: true,
        onProgress: (p) => progress.push(p),
      },
    },
  )
  let result = generator.next(),
    iterations = 0
  try {
    while (!result.done && ++iterations < 30000) result = generator.next()
    expect(result.done).toBe(true)
    expect(result.value).not.toBeNull()
    expect(progress.at(-1)).toMatchObject({
      stage: "complete",
      routedSignals: 2,
      requestedSignals: 2,
      mutuallyClearSignals: 2,
      conflicts: 0,
    })
    expect(input).toEqual(before)
    const routed = result.value!
    expect(routed.traces).toHaveLength(input.connections.length)
    expect(routed.input.traces!.slice(0, input.traces!.length)).toEqual(
      input.traces!,
    )
    const validation = BusLanesSolver.forValidation(routed.input, routed.traces)
    validation.solve()
    expect(validation.solved).toBe(true)
    for (const trace of routed.traces) {
      const joined = joinSignalEscapes(
        trace,
        routed.escapes.filter(
          (e) => e.connection_name === trace.connection_name,
        ),
      )
      const native = input.connections.find(
        (c) => c.name === trace.connection_name,
      )!
      expect(joined.route[0]).toMatchObject(native.pointsToConnect[0])
      expect(joined.route.at(-1)).toMatchObject(native.pointsToConnect[1])
      expect(
        joined.route.every(
          (p) => p.route_type === "via" || ["top", "bottom"].includes(p.layer),
        ),
      ).toBe(true)
    }
  } finally {
    if (!result.done) generator.return(null)
  }
})

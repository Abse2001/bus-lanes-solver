import { expect, test } from "bun:test"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { spreadCoupledTuningLanes } from "../lib/spread-coupled-tuning-lanes"
import { fixedCopper, routeCopper, VectorScene } from "../lib/vector-scene"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

test("tuning banks derive their orientation from endpoints and preserve paired escapes", () => {
  for (const rotate of [false, true]) {
    const at = (x: number, y: number): Point =>
      rotate ? { x: 50 - y, y: 30 - x } : { x: 50 + x, y: 30 + y }
    const traces: Trace[] = [-0.11, 0.11, 1, 2].map((y, i) => ({
      type: "pcb_trace",
      pcb_trace_id: `t${i}`,
      connection_name: `d${i}`,
      coupledSection: i < 2 ? [1, 2] : undefined,
      curvedSegments: i < 2 ? [3, 4] : undefined,
      route: (i < 2 ? [0, 1, 19, 19.5, 20] : [0, 1, 19, 20]).map((x) => ({
        ...at(x, y + (i < 2 && x > 19 ? (x - 19) ** 2 * 0.05 : 0)),
        route_type: "wire",
        layer: "top",
        width: 0.1,
      })),
    }))
    const input: SimpleRouteJson = {
      layerCount: 2,
      minTraceWidth: 0.1,
      defaultObstacleMargin: 0.1,
      bounds: { minX: 20, maxX: 80, minY: 0, maxY: 60 },
      obstacles: [],
      connections: traces.map((t) => ({
        name: t.connection_name!,
        pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
          ...p,
          layer: "top",
        })),
      })),
      buses: [
        {
          busId: "data",
          connectionNames: traces.map((t) => t.connection_name!),
          maxLengthSkew: 0.5,
        },
      ],
      differentialPairs: [
        { connectionNames: ["d0", "d1"], traceGap: 0.12, lengthTolerance: 0.1 },
      ],
    }
    const before = structuredClone(traces)
    const result = spreadCoupledTuningLanes(input, traces, 0.8)
    expect(result).not.toBeNull()
    expect(traces).toEqual(before)
    const copper = [...fixedCopper(input), ...result!.flatMap(routeCopper)]
    for (const [i, t] of result!.entries()) {
      expect(t.route[0]).toEqual(traces[i].route[0])
      expect(t.route.at(-1)).toEqual(traces[i].route.at(-1))
      expect(
        new VectorScene(input, input.connections[i], 0.1, copper).pathVisible(
          t.route,
        ),
      ).toBe(true)
      expect(tuningPathIsSelfClear(t.route, 0.2)).toBe(true)
      if (i < 2) {
        for (const [k, index] of t.curvedSegments!.entries()) {
          const original = traces[i].curvedSegments![k]
          expect(t.route.slice(index - 1, index + 1)).toEqual(
            traces[i].route.slice(original - 1, original + 1),
          )
        }
        expect(t.route.slice(0, t.coupledSection![0] + 1)).toEqual(
          traces[i].route.slice(0, 2),
        )
        expect(t.route.slice(t.coupledSection![1])).toEqual(
          traces[i].route.slice(2),
        )
      }
    }
  }
})

test("staggered shared handoffs are aligned before reconstructing a tuning bank", () => {
  const traces: Trace[] = [-0.11, 0.11, 1, 2].map((y, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `t${i}`,
    connection_name: `d${i}`,
    coupledSection: i < 2 ? [1, 2] : undefined,
    route: [0, i === 1 ? 1.1 : 1, 19, 20].map((x) => ({
      x,
      y,
      route_type: "wire",
      layer: "top",
      width: 0.1,
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    defaultObstacleMargin: 0.1,
    bounds: { minX: -5, maxX: 25, minY: -10, maxY: 10 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        ...p,
        layer: "top",
      })),
    })),
    buses: [
      {
        busId: "data",
        connectionNames: traces.map((t) => t.connection_name!),
        maxLengthSkew: 0.5,
      },
    ],
    differentialPairs: [
      { connectionNames: ["d0", "d1"], traceGap: 0.12, lengthTolerance: 0.1 },
    ],
  }
  const before = structuredClone(traces)
  const result = spreadCoupledTuningLanes(input, traces, 0.8)!
  expect(result).not.toBeNull()
  expect(traces).toEqual(before)
  const copper = [...fixedCopper(input), ...result.flatMap(routeCopper)]
  for (const [i, t] of result.entries()) {
    expect([t.route[0], t.route.at(-1)]).toEqual([
      traces[i].route[0],
      traces[i].route.at(-1),
    ])
    expect(
      new VectorScene(input, input.connections[i], 0.1, copper).pathVisible(
        t.route,
      ),
    ).toBe(true)
  }
})

test("a bus tuning bank preserves a standalone pair sharing its layer", () => {
  const traces: Trace[] = [-0.11, 0.11, 1, 2].map((y, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `shared_${i}`,
    connection_name: `signal_${i}`,
    coupledSection: i < 2 ? [1, 2] : undefined,
    route: [0, 1, 19, 20].map((x) => ({
      x,
      y,
      route_type: "wire",
      layer: "inner1",
      width: 0.1,
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 25, minY: -10, maxY: 10 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        x: p.x,
        y: p.y,
        layer: "inner1",
      })),
    })),
    buses: [{ busId: "data", connectionNames: ["signal_2", "signal_3"] }],
    differentialPairs: [
      {
        connectionNames: ["signal_0", "signal_1"],
        traceGap: 0.12,
        lengthTolerance: 0.1,
      },
    ],
  }
  const result = spreadCoupledTuningLanes(input, traces, 0.8)
  expect(result).not.toBeNull()
  expect(sharedPairSpacingReports(input, result!).every((r) => r.matched)).toBe(
    true,
  )
  const copper = [...fixedCopper(input), ...result!.flatMap(routeCopper)]
  for (const trace of result!) {
    const connection = input.connections.find(
      (c) => c.name === trace.connection_name,
    )!
    expect(
      new VectorScene(input, connection, 0.1, copper).pathVisible(trace.route),
    ).toBe(true)
    expect(tuningPathIsSelfClear(trace.route, 0.2)).toBe(true)
  }
})

test("buses spanning planes open every bank once regardless of bus membership order", () => {
  const traces: Trace[] = ["inner1", "inner2"].flatMap((layer) =>
    [-0.11, 0.11, 1, 2].map((y, i) => ({
      type: "pcb_trace" as const,
      pcb_trace_id: `${layer}_${i}`,
      connection_name: `${layer}_${i}`,
      coupledSection: i < 2 ? ([1, 2] as [number, number]) : undefined,
      route: [0, 1, 19, 20].map((x) => ({
        x,
        y,
        route_type: "wire" as const,
        layer,
        width: 0.1,
      })),
    })),
  )
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 25, minY: -10, maxY: 10 },
    obstacles: [],
    connections: traces.map((trace) => ({
      name: trace.connection_name!,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!].map((point) => ({
        x: point.x,
        y: point.y,
        layer: (point as Wire).layer,
      })),
    })),
    buses: [
      {
        busId: "first",
        connectionNames: traces
          .filter((trace) => !trace.connection_name!.endsWith("_3"))
          .map((trace) => trace.connection_name!),
      },
      { busId: "second", connectionNames: ["inner1_3", "inner2_3"] },
    ],
    differentialPairs: ["inner1", "inner2"].map((layer) => ({
      connectionNames: [`${layer}_0`, `${layer}_1`],
      traceGap: 0.12,
      lengthTolerance: 0.1,
    })),
  }
  const before = structuredClone(traces)
  const result = spreadCoupledTuningLanes(input, traces, 0.8)
  expect(result).not.toBeNull()
  expect(traces).toEqual(before)
  const once = spreadCoupledTuningLanes(
    {
      ...input,
      buses: [
        {
          busId: "all",
          connectionNames: traces.map((t) => t.connection_name!),
        },
      ],
    },
    traces,
    0.8,
  )
  expect(result).toEqual(once)
  expect(
    spreadCoupledTuningLanes(
      { ...input, buses: input.buses!.toReversed() },
      traces,
      0.8,
    ),
  ).toEqual(result)
  const copper = [...fixedCopper(input), ...result!.flatMap(routeCopper)]
  for (const [index, trace] of result!.entries()) {
    expect(trace.route).not.toEqual(before[index].route)
    expect([trace.route[0], trace.route.at(-1)]).toEqual([
      before[index].route[0],
      before[index].route.at(-1),
    ])
    expect(
      new VectorScene(input, input.connections[index], 0.1, copper).pathVisible(
        trace.route,
      ),
    ).toBe(true)
    expect(tuningPathIsSelfClear(trace.route, 0.2)).toBe(true)
  }
  expect(
    sharedPairSpacingReports(input, result!).every((pair) => pair.matched),
  ).toBe(true)
})

test("redundant paired vertices leave the allocated tuning bank unchanged", () => {
  const traces: Trace[] = [-0.11, 0.11, 1, 2].map((y, i) => ({
    type: "pcb_trace",
    pcb_trace_id: `split_${i}`,
    connection_name: `split_${i}`,
    coupledSection: i < 2 ? [1, 2] : undefined,
    route: [0, 1, 19, 20].map((x) => ({
      x,
      y,
      route_type: "wire",
      layer: "inner1",
      width: 0.1,
    })),
  }))
  const input: SimpleRouteJson = {
    layerCount: 4,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -5, maxX: 25, minY: -10, maxY: 10 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
        ...p,
        layer: "inner1",
      })),
    })),
    buses: [{ busId: "data", connectionNames: ["split_2", "split_3"] }],
    differentialPairs: [
      {
        connectionNames: ["split_0", "split_1"],
        traceGap: 0.12,
        lengthTolerance: 0.1,
      },
    ],
  }
  const split = structuredClone(traces)
  split[1].route.splice(
    2,
    0,
    { ...split[1].route[1], x: 7 },
    { ...split[1].route[1], x: 10 },
  )
  split[1].coupledSection = [1, 4]
  const before = structuredClone(split)
  const baseline = spreadCoupledTuningLanes(input, traces, 0.8)
  expect(baseline).not.toBeNull()
  expect(spreadCoupledTuningLanes(input, split, 0.8)).toEqual(baseline)
  expect(split).toEqual(before)
})

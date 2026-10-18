import { beforeAll, expect, test } from "bun:test"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { initialSignalDogbones } from "../lib/initial-signal-dogbones"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { planSharedPairCorridors } from "../lib/plan-shared-pair-corridors"
import {
  refineGeneratedPairSeed,
  type GeneratedPairSeed,
  type RefineGeneratedPairSeedOptions,
} from "../lib/refine-generated-pair-seed"
import { signalDogboneOptions } from "../lib/repair-bus-dogbones"
import { retargetGeneratedEscape } from "../lib/retarget-generated-escape"
import { pairLengthReports } from "../lib/route-lengths"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { spreadGeneratedPairViaColumns } from "../lib/spread-generated-pair-via-columns"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"
import { fixedCopper, VectorScene } from "../lib/vector-scene"
import { loadG350Am3352RepairedSample } from "../scripts/g350-am3352-repaired-sample"
import { validateG350Am3352Sample } from "../scripts/validate-g350-am3352-sample"

let native: SimpleRouteJson
let raw: GeneratedPairSeed

beforeAll(() => {
  native = loadG350Am3352RepairedSample()
  const generated = initialSignalDogbones(
    native,
    signalDogboneOptions(
      native,
      new Map(
        native.connections.map((connection) => [connection.name, "bottom"]),
      ),
    ),
    0,
  )
  const paired = new Set(
    native.differentialPairs!.flatMap((pair) => pair.connectionNames),
  )
  const escapes = (generated.traces as Trace[]).filter((trace) =>
    paired.has(trace.connection_name!),
  )
  const allocation = {
    ...native,
    connections: generated.connections,
    traces: [...(native.traces ?? []), ...escapes],
  } as SimpleRouteJson
  const preferred = new Map(
    allocation.connections.map((connection) => [
      connection.name,
      [...new Set([connection.pointsToConnect[0].layer, "bottom", "top"])],
    ]),
  )
  const plans = planSharedPairCorridors(allocation, preferred, true, {
    preferPackageOnlyTuning: true,
  })
  let next = plans.next(),
    steps = 0
  try {
    while (!next.done && !next.value && ++steps < 100000) next = plans.next()
    if (!next.value) throw Error("The fresh paired planner produced no seed")
    const retained: Trace[] = next.value
    raw = {
      retained,
      escapes: escapes.map((escape) =>
        retargetGeneratedEscape(
          escape,
          (
            retained.find(
              (trace) => trace.connection_name === escape.connection_name,
            )!.route[0] as Wire
          ).layer,
        ),
      ),
    }
  } finally {
    if (!next.done) plans.return(undefined)
  }
}, 120000)

function refine(
  input: SimpleRouteJson,
  seed: GeneratedPairSeed,
  options: RefineGeneratedPairSeedOptions = {},
  spread = true,
) {
  const work = refineGeneratedPairSeed(
    input,
    spread
      ? spreadGeneratedPairViaColumns(input, seed.retained)
      : seed.retained,
    seed.escapes,
    {},
    options,
  )
  let next = work.next(),
    steps = 0
  try {
    while (!next.done && ++steps < 100000) next = work.next()
    if (!next.done) throw Error("Pair seed refinement exceeded its test budget")
    return next.value
  } finally {
    if (!next.done) work.return(null)
  }
}

function joined(seed: GeneratedPairSeed) {
  return seed.retained.map((trace) =>
    joinSignalEscapes(
      trace,
      seed.escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
}

function audit(input: SimpleRouteJson, seed: GeneratedPairSeed) {
  const traces = joined(seed)
  const paired = new Set(
    input.differentialPairs!.flatMap((pair) => pair.connectionNames),
  )
  const pairInput = {
    ...input,
    connections: input.connections.filter((connection) =>
      paired.has(connection.name),
    ),
    buses: [],
  }
  const report = validateG350Am3352Sample(pairInput, {
    ...pairInput,
    traces: [...(input.traces ?? []), ...traces],
  })
  expect(report.valid).toBe(true)
  expect(report.connectedSignals).toBe(6)
  expect(report.selfShorts).toEqual([])
  expect(report.drc.issues).toEqual([])
  expect(report.coupling.every((pair) => pair.applicable && pair.matched)).toBe(
    true,
  )
  expect(
    sharedPairSpacingReports(input, traces).every((pair) => pair.matched),
  ).toBe(true)
  const full = validateG350Am3352Sample(input, {
    ...input,
    traces: [...(input.traces ?? []), ...traces],
  })
  expect(full.complete).toBe(false)
  expect(full.connectedSignals).toBe(6)
  return traces
}

test("fresh first six rails gain physically coupled package entries without consuming native via columns", () => {
  const before = JSON.stringify({ native, raw })
  expect(native.obstacles).toHaveLength(854)
  expect(
    native.differentialPairs!.map(
      (pair) =>
        (
          raw.retained.find(
            (trace) => trace.connection_name === pair.connectionNames[0],
          )!.route[0] as Wire
        ).layer,
    ),
  ).toEqual(["bottom", "top", "top"])
  expect(
    exteriorPairSpacingReports(native, joined(raw)).some(
      (pair) => !pair.matched,
    ),
  ).toBe(true)
  const result = refine(native, raw)
  expect(result).not.toBeNull()
  const traces = audit(native, result!)
  const qualifiedBefore = JSON.stringify(result)
  const preserved = refine(native, result!, {}, false)
  expect(preserved).not.toBeNull()
  expect(JSON.stringify(preserved)).toBe(qualifiedBefore)
  expect(JSON.stringify(result)).toBe(qualifiedBefore)
  expect(preserved!.retained[0]).not.toBe(result!.retained[0])
  const sceneInput = {
    ...native,
    traces: [...(native.traces ?? []), ...traces],
  }
  const copper = fixedCopper(sceneInput)
  for (const [name, x, y] of [
    ["source_trace_41", 2, 13.3],
    ["source_trace_30", 2, 13.9],
    ["source_trace_44", -3.6, 13.3],
    ["source_trace_9", -3.6, 13.9],
  ] as const) {
    const connection = native.connections.find(
      (connection) => connection.name === name,
    )!
    const via = { x, y }
    for (const layer of ["top", "inner1", "inner2", "bottom"])
      expect(
        new VectorScene(
          sceneInput,
          {
            ...connection,
            pointsToConnect: connection.pointsToConnect.map((point) => ({
              ...point,
              layer,
            })),
          },
          native.minViaPadDiameter!,
          copper,
        ).visible(via, via),
      ).toBe(true)
    expect(
      new VectorScene(
        sceneInput,
        connection,
        native.minTraceWidth,
        copper,
      ).visible(connection.pointsToConnect[0], via),
    ).toBe(true)
  }
  expect(JSON.stringify({ native, raw })).toBe(before)
}, 120000)

function rotated(input: SimpleRouteJson, seed: GeneratedPairSeed) {
  const point = (value: Point) => ({ x: -value.y + 17.173, y: value.x - 4.219 })
  const trace = (value: Trace): Trace => ({
    ...value,
    route: value.route.map((item) => ({ ...item, ...point(item) })),
  })
  const corners = [
    point({ x: input.bounds.minX, y: input.bounds.minY }),
    point({ x: input.bounds.maxX, y: input.bounds.maxY }),
  ]
  return {
    input: {
      ...input,
      bounds: {
        minX: Math.min(...corners.map((value) => value.x)),
        maxX: Math.max(...corners.map((value) => value.x)),
        minY: Math.min(...corners.map((value) => value.y)),
        maxY: Math.max(...corners.map((value) => value.y)),
      },
      outline: input.outline?.map(point),
      obstacles: input.obstacles.map((obstacle) => ({
        ...obstacle,
        center: point(obstacle.center),
        ccwRotationDegrees: (obstacle.ccwRotationDegrees ?? 0) + 90,
      })),
      connections: input.connections.map((connection) => ({
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((item) => ({
          ...item,
          ...point(item),
        })),
      })),
      traces: input.traces?.map(trace),
    },
    seed: {
      retained: seed.retained.map(trace),
      escapes: seed.escapes.map(trace),
    },
  }
}

test("the same package refinement works after rotating and translating the complete obstacle field", () => {
  const transformed = rotated(native, raw)
  const before = JSON.stringify(transformed)
  const result = refine(transformed.input, transformed.seed)
  expect(result).not.toBeNull()
  audit(transformed.input, result!)
  expect(JSON.stringify(transformed)).toBe(before)
}, 120000)

test("additional early pair reservations change only generated copper and preserve native constraints", () => {
  const initial = refine(native, raw)!
  const report = pairLengthReports(
    { ...native, traces: initial.escapes },
    initial.retained,
  )[0]
  const pair = native.differentialPairs![0]
  const target =
    Math.max(...report.lengths.map((item) => item.totalLengthMm!)) + 0.75
  const before = JSON.stringify({ native, initial })
  const result = refine(native, initial, {
    minimumTotalLengths: new Map([[pair.connectionNames[0], target]]),
    maxTuningCandidates: 16384,
  })
  expect(result).not.toBeNull()
  audit(native, result!)
  const reserved = pairLengthReports(
    { ...native, traces: result!.escapes },
    result!.retained,
  )[0]
  expect(
    reserved.lengths.every((item) => item.totalLengthMm! >= target - 1e-7),
  ).toBe(true)
  expect(JSON.stringify({ native, initial })).toBe(before)
}, 120000)

test("supplied pair ownership and malformed reservation targets cannot become generated seed geometry", () => {
  const before = JSON.stringify({ native, raw })
  const supplied = {
    ...native,
    traces: [
      {
        ...raw.retained[0],
        pcb_trace_id: "fixed-distinct-id",
        connection_name: "fixed-alias",
      },
    ],
  }
  expect(refine(supplied, raw)).toBeNull()
  for (const minimumTotalLengths of [
    new Map([["missing", 1]]),
    new Map([[raw.retained[0].connection_name!, Number.NaN]]),
    new Map([[raw.retained[0].connection_name!, -1]]),
  ])
    expect(refine(native, raw, { minimumTotalLengths })).toBeNull()
  expect(JSON.stringify({ native, raw })).toBe(before)
})

test("unrequested named supply copper remains hard geometry and native endpoints remain mandatory", () => {
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.12,
    minTraceToPadEdgeClearance: 0.08,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    bounds: { minX: -5, maxX: 5, minY: -4, maxY: 4 },
    obstacles: [],
    connections: [0, 0.24].map((y, index) => ({
      name: `rail-${index}`,
      pointsToConnect: [-3, 3].map((x) => ({ x, y, layer: "top" })),
    })),
    differentialPairs: [
      {
        connectionNames: ["rail-0", "rail-1"],
        traceGap: 0.12,
        lengthTolerance: 0.05,
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed-supply",
        connection_name: "SUPPLY",
        route: [-3, 3].map((x) => ({
          route_type: "wire",
          x,
          y: 2,
          layer: "top",
          width: 0.12,
        })),
      },
    ],
  }
  const seed: GeneratedPairSeed = {
    retained: input.connections.map(
      (connection): Trace => ({
        type: "pcb_trace",
        pcb_trace_id: `generated-${connection.name}`,
        connection_name: connection.name,
        source_trace_id: connection.name,
        coupledSection: [0, 1],
        route: connection.pointsToConnect.map((point) => ({
          ...point,
          route_type: "wire",
          width: 0.12,
        })),
      }),
    ),
    escapes: [],
  }
  const before = JSON.stringify({ input, seed })
  expect(refine(input, seed)).not.toBeNull()
  const blocked = structuredClone(input)
  blocked.traces![0].route = [-1, 1].map((y) => ({
    route_type: "wire",
    x: 0,
    y,
    layer: "top",
    width: 0.12,
  }))
  expect(refine(blocked, seed)).toBeNull()
  const disconnected = structuredClone(seed)
  for (const trace of disconnected.retained)
    for (const point of trace.route) point.x += 0.5
  expect(refine(input, disconnected)).toBeNull()
  expect(JSON.stringify({ input, seed })).toBe(before)
})

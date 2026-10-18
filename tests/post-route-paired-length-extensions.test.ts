import { expect, test } from "bun:test"
import { getCopperLayerNames } from "@tscircuit/fanout-solver"
import { findFixedPathRanges } from "../lib/fixed-route-paths"
import { length } from "../lib/geometry"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { physicalRoutingAcceptance } from "../lib/physical-routing-acceptance"
import {
  enumeratePairedBodyLengthExtensions,
  createPairedBodyForeignPrefilter,
  type PairedBodyLengthExtensionProposal,
} from "../lib/post-route-paired-length-extensions"
import { smoothTuningLobes } from "../lib/smooth-tuning"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

function fixture(carrierLayer = "bottom") {
  const nativeLayer = carrierLayer === "bottom" ? "top" : "bottom"
  const wire = (x: number, y: number, layer: string): Wire => ({
    route_type: "wire",
    x,
    y,
    layer,
    width: 0.1,
  })
  const escapes: Trace[] = []
  const joined: Trace[] = []
  for (const [rail, sign] of [1, -1].entries()) {
    const name = `rail_${rail}`,
      y = sign * 0.11
    const owned = [0, 1].map((end) => {
      const direction = end ? -1 : 1
      const native = { x: end ? 14 : 0, y: sign * 0.8 }
      const via = { x: native.x + direction * (rail ? 1.8 : 1.2), y: native.y }
      const top = smoothTuningLobes(
        native,
        via,
        0.2,
        1,
        sign * direction,
        0.12,
      )!
      const route: Trace["route"] = [
        ...top.map((point) => wire(point.x, point.y, nativeLayer)),
        {
          ...via,
          route_type: "via",
          from_layer: nativeLayer,
          to_layer: carrierLayer,
          layers: getCopperLayerNames(4),
          via_diameter: 0.4572,
          via_hole_diameter: 0.254,
        },
        wire(via.x, via.y, carrierLayer),
        wire(via.x + direction * 0.3, via.y, carrierLayer),
        wire(via.x + direction * (0.3 + 0.69), y, carrierLayer),
        wire(end ? 11 : 3, y, carrierLayer),
      ]
      return {
        type: "pcb_trace" as const,
        pcb_trace_id: `fixed_${name}_${end}`,
        connection_name: name,
        route,
        curvedSegments: top.slice(1).map((_, index) => index + 1),
      }
    })
    escapes.push(...owned)
    joined.push(
      joinSignalEscapes(
        {
          type: "pcb_trace",
          pcb_trace_id: name,
          connection_name: name,
          coupledSection: [0, 1],
          route: [wire(3, y, carrierLayer), wire(11, y, carrierLayer)],
        },
        owned,
      ),
    )
  }
  const guard: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "foreign_guard",
    connection_name: "guard",
    route: [wire(4, 2, carrierLayer), wire(10, 2, carrierLayer)],
  }
  joined.push(guard)
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
    minTraceToPadEdgeClearance: 0.05,
    bounds: { minX: -1, maxX: 15, minY: -7, maxY: 7 },
    connections: joined.map((trace) => ({
      name: trace.connection_name!,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!].map((point) => ({
        x: point.x,
        y: point.y,
        layer: (point as Wire).layer,
      })),
    })),
    obstacles: [0, 14].flatMap((x, component) => [
      ...[-0.8, 0.8].map((y, row) => ({
        componentId: `package_${component}`,
        shape: "circle" as const,
        center: { x, y },
        width: 0.3,
        height: 0.3,
        layers: [nativeLayer],
        connectedTo: [`rail_${row ? 0 : 1}`],
      })),
      ...[-1.6, 1.6].map((y) => ({
        componentId: `package_${component}`,
        shape: "circle" as const,
        center: { x: x + (component ? -2.8 : 2.8), y },
        width: 0.3,
        height: 0.3,
        layers: [nativeLayer],
        connectedTo: ["native_NC"],
      })),
    ]),
    differentialPairs: [
      {
        connectionNames: ["rail_0", "rail_1"],
        traceGap: 0.12,
        lengthTolerance: 0.127,
      },
    ],
    buses: [
      {
        busId: "pair_bus",
        connectionNames: ["rail_0", "rail_1"],
        maxLengthSkew: 0.635,
      },
    ],
  }
  return { input, joined, escapes }
}

function proposals(
  search: Generator<void | PairedBodyLengthExtensionProposal, void>,
) {
  const found: PairedBodyLengthExtensionProposal[] = []
  let result = search.next(),
    steps = 0
  while (!result.done && steps++ < 10000) {
    if (result.value) found.push(result.value)
    result = search.next()
  }
  if (!result.done)
    throw Error("Paired fixture exceeded its explicit candidate bound")
  return found
}

for (const carrier of ["top", "bottom"])
  test(`joint ${carrier} extension preserves curved fixed PTH fanouts and avoids real foreign copper`, () => {
    const { input, joined, escapes } = fixture(carrier)
    const before = structuredClone({ input, joined, escapes })
    const baseline = physicalRoutingAcceptance(input, joined, { escapes })
    expect(baseline.physicalRoutingAccepted).toBe(true)
    const rejected: string[] = []
    let foreignCopperRejected = false
    const found = proposals(
      enumeratePairedBodyLengthExtensions(input, joined, {
        connectionNames: ["rail_0", "rail_1"],
        minimumLength: 23,
        maximumLength: 23.635,
        fixedEscapes: escapes,
        maximumCandidates: 1,
        maximumAttempts: 48,
        allowPartialProgress: false,
        onAttempt: (row) => {
          if (!row.accepted) rejected.push(row.reason)
          if (row.physicalGates?.foreignCopperClear === false)
            foreignCopperRejected = true
        },
      }),
    )
    expect(found).toHaveLength(1)
    const proposal = found[0],
      replacement = [...proposal.traces, joined[2]]
    expect(proposal.withinTargetBand).toBe(true)
    expect(
      proposal.fullOwnedLengths.every(
        (value) => value >= 23 && value <= 23.635,
      ),
    ).toBe(true)
    expect(
      Math.abs(proposal.fullOwnedLengths[0] - proposal.fullOwnedLengths[1]),
    ).toBeLessThan(0.127)
    expect(proposal.addedVias).toBe(0)
    const accepted = physicalRoutingAcceptance(input, replacement, { escapes })
    expect(accepted.physicalRoutingAccepted).toBe(true)
    expect(accepted.nativeDrc.issues).toEqual([])
    expect(accepted.gates.escapesPreserved).toBe(true)
    expect(accepted.gates.exteriorPairCouplingValid).toBe(true)
    expect(accepted.gates.sharedPairSpacingValid).toBe(true)
    expect(replacement[2]).toBe(joined[2])
    for (const trace of proposal.traces) {
      const original = joined.find(
        (item) => item.connection_name === trace.connection_name,
      )!
      expect(trace.route[0]).toEqual(original.route[0])
      expect(trace.route.at(-1)).toEqual(original.route.at(-1))
      expect(findFixedPathRanges(trace, escapes)).not.toBeNull()
      expect(trace.route.filter((point) => point.route_type === "via")).toEqual(
        original.route.filter((point) => point.route_type === "via"),
      )
    }
    expect(rejected).toContain("physical")
    expect(foreignCopperRejected).toBe(true)
    expect({ input, joined, escapes }).toEqual(before)
  })

test("a small attempt budget reaches a later clear span after the first span is blocked", () => {
  const { input, joined, escapes } = fixture()
  for (const rail of joined.slice(0, 2)) {
    const [start, end] = rail.coupledSection!
    const a = rail.route[start] as Wire
    rail.route.splice(start + 1, 0, { ...a, x: 7 })
    rail.coupledSection = [start, end + 1]
    rail.curvedSegments = rail.curvedSegments?.map((index) =>
      index > start ? index + 1 : index,
    )
  }
  joined[2].route = [
    { route_type: "wire", x: 3.1, y: 1, layer: "bottom", width: 0.1 },
    { route_type: "wire", x: 6.9, y: 1, layer: "bottom", width: 0.1 },
  ]
  input.connections[2].pointsToConnect = joined[2].route.map((point) => ({
    x: point.x,
    y: point.y,
    layer: "bottom",
  }))
  const initial = Math.max(
    ...joined.slice(0, 2).map((trace) => length(trace.route)),
  )
  expect(
    physicalRoutingAcceptance(input, joined, { escapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  const attempts: Array<{
    indices: readonly [number, number]
    accepted: boolean
    foreign?: boolean
  }> = []
  const found = proposals(
    enumeratePairedBodyLengthExtensions(input, joined, {
      connectionNames: ["rail_0", "rail_1"],
      minimumLength: initial + 3,
      maximumLength: initial + 3.635,
      fixedEscapes: escapes,
      maximumAttempts: 2,
      maximumCandidates: 1,
      allowPartialProgress: false,
      onAttempt: (row) =>
        attempts.push({
          indices: row.sharedEdgeEndingIndices,
          accepted: row.accepted,
          foreign: row.physicalGates?.foreignCopperClear,
        }),
    }),
  )
  expect(attempts).toHaveLength(2)
  expect(attempts[0].foreign).toBe(false)
  expect(attempts[1].indices[0]).toBe(attempts[0].indices[0] + 1)
  expect(found).toHaveLength(1)
  expect(found[0].attempt).toBe(2)
  expect(found[0].sharedEdgeEndingIndices).toEqual(attempts[1].indices)
  expect(
    physicalRoutingAcceptance(input, [...found[0].traces, joined[2]], {
      escapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
})

test("foreign prefilter preserves clear native shared intervals and rejects a crossed foreign full-stack via", () => {
  const { input, joined, escapes } = fixture()
  const rails = joined.slice(0, 2) as [Trace, Trace]
  const paths = rails.map((rail) =>
    rail.route.slice(rail.coupledSection![0], rail.coupledSection![1] + 1),
  ) as [Wire[], Wire[]]
  expect(
    physicalRoutingAcceptance(input, joined, { escapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  expect(
    createPairedBodyForeignPrefilter(input, joined, ["rail_0", "rail_1"])(
      rails,
      paths,
    ),
  ).toBe(true)
  // A foreign PTH remains full-depth copper even though its wire approach is
  // on the opposite surface and its explicit via size/layers use native defaults.
  joined[2].route = [
    { route_type: "wire", x: 7, y: 0.11, layer: "top", width: 0.1 },
    { route_type: "via", x: 7, y: 0.11, from_layer: "top", to_layer: "bottom" },
  ]
  expect(
    createPairedBodyForeignPrefilter(input, joined, ["rail_0", "rail_1"])(
      rails,
      paths,
    ),
  ).toBe(false)
})

test("monotonic deadlines accept future work, stop expired work, and reject invalid clocks", () => {
  const { input, joined, escapes } = fixture()
  const future = proposals(
    enumeratePairedBodyLengthExtensions(input, joined, {
      connectionNames: ["rail_0", "rail_1"],
      minimumLength: 23,
      maximumLength: 23.635,
      fixedEscapes: escapes,
      maximumCandidates: 1,
      maximumAttempts: 8,
      deadlineMs: performance.now() + 60_000,
    }),
  )
  expect(future).toHaveLength(1)
  expect(future[0].withinTargetBand).toBe(true)
  expect(
    proposals(
      enumeratePairedBodyLengthExtensions(input, joined, {
        connectionNames: ["rail_0", "rail_1"],
        minimumLength: 23,
        maximumLength: 23.635,
        fixedEscapes: escapes,
        deadlineMs: performance.now() - 1,
      }),
    ),
  ).toEqual([])
  expect(() =>
    proposals(
      enumeratePairedBodyLengthExtensions(input, joined, {
        connectionNames: ["rail_0", "rail_1"],
        minimumLength: 23,
        maximumLength: 23.635,
        fixedEscapes: escapes,
        deadlineMs: NaN,
      }),
    ),
  ).toThrow("Invalid paired")
})

test("native pad ownership aliases do not falsely prune a clear shared interval", () => {
  const { input, joined, escapes } = fixture()
  input.obstacles
    .find((obstacle) => obstacle.connectedTo.includes("rail_0"))!
    .connectedTo.push("alias_0")
  input.obstacles.push({
    shape: "circle",
    center: { x: 7, y: 0.11 },
    width: 0.1,
    height: 0.1,
    layers: ["bottom"],
    connectedTo: ["alias_0"],
  })
  const rails = joined.slice(0, 2) as [Trace, Trace]
  const paths = rails.map((rail) =>
    rail.route.slice(rail.coupledSection![0], rail.coupledSection![1] + 1),
  ) as [Wire[], Wire[]]
  const before = structuredClone({ input, joined, escapes })
  expect(
    physicalRoutingAcceptance(input, joined, { escapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  expect(
    createPairedBodyForeignPrefilter(input, joined, ["rail_0", "rail_1"])(
      rails,
      paths,
    ),
  ).toBe(true)
  expect({ input, joined, escapes }).toEqual(before)
})

test("physical partial progress is explicitly labelled and remains outside the full target", () => {
  const { input, joined, escapes } = fixture()
  input.bounds.minY = -2.2
  input.bounds.maxY = 2.2
  const initial = Math.min(
    ...joined.slice(0, 2).map((trace) => length(trace.route)),
  )
  const found = proposals(
    enumeratePairedBodyLengthExtensions(input, joined, {
      connectionNames: ["rail_0", "rail_1"],
      minimumLength: initial + 60,
      maximumLength: initial + 60.635,
      fixedEscapes: escapes,
      maximumCandidates: 2,
      maximumAttempts: 256,
      allowPartialProgress: true,
    }),
  )
  expect(found.length).toBeGreaterThan(0)
  expect(
    found.every(
      (candidate) =>
        candidate.distanceToTargetBand < candidate.previousDistanceToTargetBand,
    ),
  ).toBe(true)
  expect(found.some((candidate) => !candidate.withinTargetBand)).toBe(true)
  for (const candidate of found)
    expect(
      physicalRoutingAcceptance(input, [...candidate.traces, joined[2]], {
        escapes,
      }).physicalRoutingAccepted,
    ).toBe(true)
})

test("fully immutable shared spans produce no mutation or candidate", () => {
  const { input, joined, escapes } = fixture()
  const before = structuredClone(joined)
  const found = proposals(
    enumeratePairedBodyLengthExtensions(input, joined, {
      connectionNames: ["rail_0", "rail_1"],
      minimumLength: 23,
      maximumLength: 23.635,
      fixedEscapes: [...escapes, ...joined.slice(0, 2)],
      maximumCandidates: 1,
      maximumAttempts: 16,
    }),
  )
  expect(found).toEqual([])
  expect(joined).toEqual(before)
})

test("a broken native physical incumbent never becomes a tuning seed", () => {
  const { input, joined, escapes } = fixture()
  joined[2].route = [
    { route_type: "wire", x: 5, y: -3, layer: "bottom", width: 0.1 },
    { route_type: "wire", x: 5, y: 3, layer: "bottom", width: 0.1 },
  ]
  input.connections[2].pointsToConnect = joined[2].route.map((point) => ({
    x: point.x,
    y: point.y,
    layer: "bottom",
  }))
  expect(() =>
    proposals(
      enumeratePairedBodyLengthExtensions(input, joined, {
        connectionNames: ["rail_0", "rail_1"],
        minimumLength: 23,
        maximumLength: 23.635,
        fixedEscapes: escapes,
      }),
    ),
  ).toThrow("physically accepted incumbent")
})

test("zero proposal budget and invalid targets cannot alter any complete route", () => {
  const { input, joined, escapes } = fixture(),
    before = structuredClone(joined)
  expect(
    proposals(
      enumeratePairedBodyLengthExtensions(input, joined, {
        connectionNames: ["rail_0", "rail_1"],
        minimumLength: 23,
        maximumLength: 23.635,
        fixedEscapes: escapes,
        maximumAttempts: 0,
      }),
    ),
  ).toEqual([])
  expect(() =>
    proposals(
      enumeratePairedBodyLengthExtensions(input, joined, {
        connectionNames: ["rail_0", "rail_1"],
        minimumLength: 24,
        maximumLength: 23,
        fixedEscapes: escapes,
      }),
    ),
  ).toThrow()
  expect(joined).toEqual(before)
})

test("oppositely traversed paired routes retain exact reversed fixed paths", () => {
  const { input, joined, escapes } = fixture()
  const rail = joined[1],
    count = rail.route.length
  joined[1] = {
    ...rail,
    route: rail.route
      .toReversed()
      .map((point) =>
        point.route_type === "via"
          ? { ...point, from_layer: point.to_layer, to_layer: point.from_layer }
          : point,
      ),
    curvedSegments: rail.curvedSegments?.map((ending) => count - ending),
    coupledSection: [
      count - 1 - rail.coupledSection![1],
      count - 1 - rail.coupledSection![0],
    ],
  }
  const before = structuredClone(joined)
  const found = proposals(
    enumeratePairedBodyLengthExtensions(input, joined, {
      connectionNames: ["rail_0", "rail_1"],
      minimumLength: 23,
      maximumLength: 23.635,
      fixedEscapes: escapes,
      maximumCandidates: 1,
      maximumAttempts: 48,
    }),
  )
  expect(found).toHaveLength(1)
  expect(found[0].withinTargetBand).toBe(true)
  expect(findFixedPathRanges(found[0].traces[1], escapes)).not.toBeNull()
  expect(
    physicalRoutingAcceptance(input, [...found[0].traces, joined[2]], {
      escapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  expect(joined).toEqual(before)
})

test("full-owned target measurements add native fixed copper once", () => {
  const { input, joined, escapes } = fixture()
  input.bounds.minX = -2
  input.traces = input.connections.slice(0, 2).map((connection) => {
    const point = connection.pointsToConnect[0]
    return {
      type: "pcb_trace",
      pcb_trace_id: `native_${connection.name}`,
      connection_name: connection.name,
      route: [-1, 0].map((x) => ({
        route_type: "wire",
        x,
        y: point.y,
        layer: point.layer,
        width: 0.1,
      })),
    }
  })
  const found = proposals(
    enumeratePairedBodyLengthExtensions(input, joined, {
      connectionNames: ["rail_0", "rail_1"],
      minimumLength: 23,
      maximumLength: 23.635,
      fixedEscapes: escapes,
      maximumCandidates: 1,
      maximumAttempts: 48,
    }),
  )
  expect(found).toHaveLength(1)
  for (const [index, rail] of found[0].traces.entries())
    expect(found[0].fullOwnedLengths[index]).toBeCloseTo(
      length(rail.route) + 1,
      8,
    )
  expect(found[0].withinTargetBand).toBe(true)
})

test("equal shared extension retains a native 0.127 skew in a 0.127-wide target band", () => {
  const { input, joined, escapes } = fixture()
  const point = input.connections[0].pointsToConnect[0]
  input.traces = [
    {
      type: "pcb_trace",
      pcb_trace_id: "native_rail_0_length",
      connection_name: "rail_0",
      route: [-0.127, 0].map((x) => ({
        route_type: "wire",
        x,
        y: point.y,
        layer: point.layer,
        width: 0.1,
      })),
    },
  ]
  expect(
    physicalRoutingAcceptance(input, joined, { escapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  const found = proposals(
    enumeratePairedBodyLengthExtensions(input, joined, {
      connectionNames: ["rail_0", "rail_1"],
      minimumLength: 23,
      maximumLength: 23.127,
      fixedEscapes: escapes,
      maximumCandidates: 1,
      maximumAttempts: 48,
      allowPartialProgress: false,
    }),
  )
  expect(found).toHaveLength(1)
  expect(found[0].withinTargetBand).toBe(true)
  expect(
    Math.abs(found[0].fullOwnedLengths[0] - found[0].fullOwnedLengths[1]),
  ).toBeCloseTo(0.127, 7)
  expect(Math.min(...found[0].fullOwnedLengths)).toBeCloseTo(23, 7)
  expect(Math.max(...found[0].fullOwnedLengths)).toBeCloseTo(23.127, 7)
  expect(
    physicalRoutingAcceptance(input, [...found[0].traces, joined[2]], {
      escapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
})

test("diagonal shared segments and swapped pair order preserve exact curved fixed prefixes", () => {
  const { input, joined, escapes } = fixture()
  const rotate = <T extends { x: number; y: number }>(point: T): T => ({
    ...point,
    x: 4 + (point.x - point.y) / Math.SQRT2,
    y: 3 + (point.x + point.y) / Math.SQRT2,
  })
  for (const connection of input.connections)
    connection.pointsToConnect = connection.pointsToConnect.map(rotate)
  for (const obstacle of input.obstacles)
    obstacle.center = rotate(obstacle.center)
  for (const trace of [...joined, ...escapes])
    trace.route = trace.route.map(rotate)
  input.bounds = { minX: -10, maxX: 30, minY: -10, maxY: 30 }
  const before = structuredClone({ input, joined, escapes })
  expect(
    physicalRoutingAcceptance(input, joined, { escapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  const found = proposals(
    enumeratePairedBodyLengthExtensions(input, joined, {
      connectionNames: ["rail_1", "rail_0"],
      minimumLength: 23,
      maximumLength: 23.635,
      fixedEscapes: escapes,
      maximumCandidates: 1,
      maximumAttempts: 48,
      allowPartialProgress: false,
    }),
  )
  expect(found).toHaveLength(1)
  expect(found[0].traces.map((trace) => trace.connection_name)).toEqual([
    "rail_1",
    "rail_0",
  ])
  for (const trace of found[0].traces)
    expect(findFixedPathRanges(trace, escapes)).not.toBeNull()
  expect(
    physicalRoutingAcceptance(input, [...found[0].traces, joined[2]], {
      escapes,
    }).physicalRoutingAccepted,
  ).toBe(true)
  expect({ input, joined, escapes }).toEqual(before)
})

test("an unreachable requested tuning bay emits no unchecked replacement", () => {
  const { input, joined, escapes } = fixture(),
    before = structuredClone(joined)
  expect(
    proposals(
      enumeratePairedBodyLengthExtensions(input, joined, {
        connectionNames: ["rail_0", "rail_1"],
        minimumLength: 23,
        maximumLength: 23.635,
        fixedEscapes: escapes,
        maximumCandidates: 1,
        maximumAttempts: 8,
        tuningBays: [{ minX: 100, maxX: 101, minY: 100, maxY: 101 }],
      }),
    ),
  ).toEqual([])
  expect(joined).toEqual(before)
})

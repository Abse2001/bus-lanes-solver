import { expect, test } from "bun:test"
import { findFixedPathRanges } from "../lib/fixed-route-paths"
import { length } from "../lib/geometry"
import { physicalRoutingAcceptance } from "../lib/physical-routing-acceptance"
import { fixedRouteLength } from "../lib/route-lengths"
import {
  shortenJoinedRouteFreeBody,
  type FreeBodyShorteningProposal,
} from "../lib/shorten-joined-route-free-body"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"

const wire = (x: number, y: number): Wire => ({
  route_type: "wire",
  x,
  y,
  layer: "top",
  width: 0.1,
})

function fixture() {
  const signal: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "joined-signal",
    connection_name: "signal",
    source_trace_id: "source_signal",
    // A clear same-layer body with no internal vias and only 45-degree turns.
    route: [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 1],
      [3, 5],
      [4, 6],
      [8, 6],
      [9, 5],
      [9, 1],
      [10, 0],
      [11, 0],
      [12, 0],
    ].map(([x, y]) => wire(x, y)),
  }
  const neighbor: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "joined-neighbor",
    connection_name: "neighbor",
    source_trace_id: "source_neighbor",
    route: [wire(4, -1.5), wire(4, 3.5)],
  }
  const native: SimpleRouteJson = {
    layerCount: 2,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.05,
    minViaPadDiameter: 0.3,
    minViaHoleDiameter: 0.15,
    allowBlindAndBuriedVias: false,
    bounds: { minX: -2, maxX: 14, minY: -3, maxY: 8 },
    connections: [signal, neighbor].map((trace) => ({
      name: trace.connection_name!,
      source_trace_id: trace.source_trace_id,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!].map((point) => ({
        x: point.x,
        y: point.y,
        layer: "top",
      })),
    })),
    obstacles: [
      {
        type: "rect",
        center: { x: 6, y: 1.5 },
        width: 2,
        height: 3,
        layers: ["top", "bottom"],
        connectedTo: ["foreign-pad"],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed-signal",
        connection_name: "signal",
        source_trace_id: "source_signal",
        route: [wire(-0.5, 0), wire(0, 0)],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "fixed-power",
        connection_name: "power",
        source_trace_id: "source_power",
        route: [wire(2, 7), wire(10, 7)],
      },
    ],
    buses: [
      {
        busId: "signal-bus",
        connectionNames: ["signal"],
        maxLengthSkew: 0,
        maxLength: 8,
      },
    ],
  }
  const fixedEscapes: Trace[] = [
    {
      ...signal,
      pcb_trace_id: "signal-prefix",
      route: signal.route.slice(0, 2),
    },
    {
      ...signal,
      pcb_trace_id: "signal-suffix",
      route: signal.route.slice(-2).toReversed(),
    },
    {
      ...neighbor,
      pcb_trace_id: "neighbor-prefix",
      route: neighbor.route.slice(0, 1),
    },
    {
      ...neighbor,
      pcb_trace_id: "neighbor-suffix",
      route: neighbor.route.slice(-1),
    },
  ]
  return { native, traces: [signal, neighbor], fixedEscapes }
}

function options(fixedEscapes: readonly Trace[]) {
  return {
    connectionName: "signal",
    minimumLength: 12,
    maximumLength: 20,
    fixedEscapes,
    maxExpansions: 100000,
    maxCandidates: 32,
  }
}

function collect(search: Generator<void | FreeBodyShorteningProposal>) {
  const proposals: FreeBodyShorteningProposal[] = []
  let steps = 0
  for (const proposal of search) {
    if (++steps > 100000)
      throw Error("Free-body proposal search exceeded its bound")
    if (proposal) proposals.push(proposal)
  }
  return proposals
}

function assertProposal(
  native: SimpleRouteJson,
  before: readonly Trace[],
  fixedEscapes: readonly Trace[],
  proposal: FreeBodyShorteningProposal,
) {
  const report = physicalRoutingAcceptance(native, proposal.traces, {
    escapes: fixedEscapes,
  })
  expect(report.physicalRoutingAccepted).toBe(true)
  expect(Object.values(report.gates).every(Boolean)).toBe(true)
  expect(report.nativeDrc.issues).toEqual([])
  expect(report.output.traces!.slice(0, native.traces!.length)).toEqual(
    native.traces!,
  )
  expect(
    proposal.traces.find((trace) => trace.connection_name === "neighbor"),
  ).toEqual(before[1])
  expect(proposal.trace.connection_name).toBe(before[0].connection_name)
  expect(proposal.trace.source_trace_id).toBe(before[0].source_trace_id)
  expect(proposal.trace.pcb_trace_id).toBe(before[0].pcb_trace_id)
  expect(proposal.trace.route[0]).toEqual(before[0].route[0])
  expect(proposal.trace.route.at(-1)).toEqual(before[0].route.at(-1))
  expect(findFixedPathRanges(proposal.trace, fixedEscapes)).not.toBeNull()
  expect(proposal.fullOwnedLength).toBeCloseTo(
    length(proposal.trace.route) + fixedRouteLength(native, "signal"),
    8,
  )
  expect(proposal.previousFullOwnedLength).toBeCloseTo(
    length(before[0].route) + fixedRouteLength(native, "signal"),
    8,
  )
  expect(proposal.fullOwnedLength).toBeLessThan(
    proposal.previousFullOwnedLength,
  )
}

test("a same-layer free body shortens around hard foreign copper while exact endpoint paths stay fixed", () => {
  const { native, traces, fixedEscapes } = fixture()
  const before = structuredClone({ native, traces, fixedEscapes })
  const baseline = physicalRoutingAcceptance(native, traces, {
    escapes: fixedEscapes,
  })
  expect(baseline.physicalRoutingAccepted).toBe(true)
  expect(traces[0].route.every((point) => point.route_type === "wire")).toBe(
    true,
  )
  const proposals = collect(
    shortenJoinedRouteFreeBody(native, traces, options(fixedEscapes)),
  )
  expect(proposals.length).toBeGreaterThan(0)
  for (const proposal of proposals) {
    assertProposal(native, traces, fixedEscapes, proposal)
    expect(proposal.withinTargetBand).toBe(true)
    expect(proposal.distanceToTargetBand).toBe(0)
    expect(proposal.fullOwnedLength).toBeGreaterThanOrEqual(12 - 1e-7)
    expect(proposal.fullOwnedLength).toBeLessThanOrEqual(20 + 1e-7)
    expect(proposal.removedVias).toBe(0)
    expect(proposal.freeInterval.start).toBeGreaterThanOrEqual(1)
    expect(proposal.freeInterval.end).toBeLessThanOrEqual(
      traces[0].route.length - 2,
    )
  }
  expect({ native, traces, fixedEscapes }).toEqual(before)
})

test("partial progress must be explicitly enabled and truthfully reports remaining band error", () => {
  const { native, traces, fixedEscapes } = fixture()
  expect(
    physicalRoutingAcceptance(native, traces, { escapes: fixedEscapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  const settings = {
    ...options(fixedEscapes),
    minimumLength: 0,
    maximumLength: 8,
  }
  expect(collect(shortenJoinedRouteFreeBody(native, traces, settings))).toEqual(
    [],
  )
  const proposals = collect(
    shortenJoinedRouteFreeBody(native, traces, {
      ...settings,
      allowPartialProgress: true,
    }),
  )
  expect(proposals.length).toBeGreaterThan(0)
  for (const proposal of proposals) {
    assertProposal(native, traces, fixedEscapes, proposal)
    expect(proposal.withinTargetBand).toBe(false)
    expect(proposal.fullOwnedLength).toBeGreaterThan(8)
    expect(proposal.distanceToTargetBand).toBeCloseTo(
      proposal.fullOwnedLength - 8,
      8,
    )
    expect(proposal.previousDistanceToTargetBand).toBeCloseTo(
      proposal.previousFullOwnedLength - 8,
      8,
    )
    expect(proposal.distanceToTargetBand).toBeLessThan(
      proposal.previousDistanceToTargetBand,
    )
  }
})

test("fixed handoff values and prefix/suffix curve permissions survive a vertex-count change", () => {
  const { native, traces, fixedEscapes } = fixture()
  const signal = traces[0]
  signal.route[1].x += 1e-12
  signal.route.at(-2)!.x -= 1e-12
  signal.curvedSegments = [1, signal.route.length - 1]
  fixedEscapes[0] = {
    ...fixedEscapes[0],
    route: structuredClone(signal.route.slice(0, 2)),
    curvedSegments: [1],
  }
  fixedEscapes[1] = {
    ...fixedEscapes[1],
    route: structuredClone(signal.route.slice(-2).toReversed()),
    curvedSegments: [1],
  }
  const before = structuredClone({ native, traces, fixedEscapes })
  expect(
    physicalRoutingAcceptance(native, traces, { escapes: fixedEscapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  const proposals = collect(
    shortenJoinedRouteFreeBody(native, traces, options(fixedEscapes)),
  )
  expect(proposals.length).toBeGreaterThan(0)
  expect(
    proposals.some(
      (proposal) => proposal.trace.route.length !== signal.route.length,
    ),
  ).toBe(true)
  for (const proposal of proposals) {
    assertProposal(native, traces, fixedEscapes, proposal)
    expect(proposal.trace.route[1]).toEqual(signal.route[1])
    expect(proposal.trace.route.at(-2)).toEqual(signal.route.at(-2))
    expect(proposal.trace.curvedSegments).toEqual([
      1,
      proposal.trace.route.length - 1,
    ])
  }
  expect({ native, traces, fixedEscapes }).toEqual(before)
})

test("old internal vias may disappear while same-layer immutable endpoint paths stay exact", () => {
  const { native, traces, fixedEscapes } = fixture()
  const signal = traces[0]
  const from = signal.route[5],
    to = signal.route[6]
  const via = (
    x: number,
    y: number,
    from_layer: string,
    to_layer: string,
  ): Trace["route"][number] => ({
    route_type: "via",
    x,
    y,
    from_layer,
    to_layer,
    layers: ["top", "bottom"],
    via_diameter: 0.3,
    via_hole_diameter: 0.15,
  })
  signal.route.splice(
    6,
    1,
    via(from.x, from.y, "top", "bottom"),
    { ...wire(from.x, from.y), layer: "bottom" },
    { ...wire(to.x, to.y), layer: "bottom" },
    via(to.x, to.y, "bottom", "top"),
    to,
  )
  expect(
    signal.route.filter((point) => point.route_type === "via"),
  ).toHaveLength(2)
  expect(
    physicalRoutingAcceptance(native, traces, { escapes: fixedEscapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  const proposals = collect(
    shortenJoinedRouteFreeBody(native, traces, options(fixedEscapes)),
  )
  expect(proposals.length).toBeGreaterThan(0)
  for (const proposal of proposals) {
    assertProposal(native, traces, fixedEscapes, proposal)
    expect(proposal.removedVias).toBe(2)
    expect(
      proposal.trace.route.every((point) => point.route_type === "wire"),
    ).toBe(true)
  }
})

test("a closed physical barrier cannot yield an accepted proposal", () => {
  const { native, traces, fixedEscapes } = fixture()
  native.obstacles.push({
    type: "rect",
    center: { x: 6, y: 2.5 },
    width: 0.5,
    height: 11,
    layers: ["top", "bottom"],
    connectedTo: ["closed-wall"],
  })
  expect(
    collect(
      shortenJoinedRouteFreeBody(native, traces, {
        ...options(fixedEscapes),
        allowPartialProgress: true,
      }),
    ),
  ).toEqual([])
})

test("changed fixed paths and incomplete joined input reject", () => {
  const { native, traces, fixedEscapes } = fixture()
  const changed = structuredClone(fixedEscapes)
  changed[0].route[1].x += 1e-12
  expect(
    collect(shortenJoinedRouteFreeBody(native, traces, options(changed))),
  ).toEqual([])
  expect(
    collect(
      shortenJoinedRouteFreeBody(
        native,
        traces.slice(0, 1),
        options(fixedEscapes),
      ),
    ),
  ).toEqual([])
})

test("differential-pair owners remain outside ordinary free-body shortening", () => {
  const { native, traces, fixedEscapes } = fixture()
  native.differentialPairs = [
    { connectionNames: ["signal", "neighbor"], lengthTolerance: 100 },
  ]
  expect(
    physicalRoutingAcceptance(native, traces, { escapes: fixedEscapes })
      .physicalRoutingAccepted,
  ).toBe(true)
  expect(
    collect(shortenJoinedRouteFreeBody(native, traces, options(fixedEscapes))),
  ).toEqual([])
})

test("expired deadlines and zero search budgets yield no proposals", () => {
  const { native, traces, fixedEscapes } = fixture()
  for (const budget of [
    { deadlineMs: performance.now() - 1 },
    { maxExpansions: 0 },
    { maxCandidates: 0 },
  ]) {
    expect(
      collect(
        shortenJoinedRouteFreeBody(native, traces, {
          ...options(fixedEscapes),
          ...budget,
        }),
      ),
    ).toEqual([])
  }
})

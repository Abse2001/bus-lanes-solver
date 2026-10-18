import { describe, expect, test } from "bun:test"
import { length } from "../lib/geometry"
import { findFixedPathRanges } from "../lib/fixed-route-paths"
import { physicalRoutingAcceptance } from "../lib/physical-routing-acceptance"
import {
  enumerateOrdinaryTwoViaLengthExcursions,
  type OrdinaryLengthExcursionOptions,
  type OrdinaryLengthExcursionProposal,
} from "../lib/post-route-ordinary-length-excursions"
import {
  IncompleteLengthTuningError,
  tuneSmoothLengths,
} from "../lib/smooth-length-tuning"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"
const w = (x: number, y: number, layer = "top", extra: object = {}): Wire => ({
  x,
  y,
  layer,
  width: 0.1016,
  route_type: "wire",
  ...extra,
})
function fixture() {
  const original: Trace = {
      type: "pcb_trace",
      pcb_trace_id: "original",
      connection_name: "signal",
      source_trace_id: "source_signal",
      route: [
        w(-3, 0, "top", { pcb_port_id: "a" }),
        w(-2.5, 0, "top", { pointId: "fixed-a" }),
        w(2.5, 0, "top", { pointId: "fixed-b" }),
        w(3, 0, "top", { pcb_port_id: "b" }),
      ],
    },
    foreign: Trace = {
      type: "pcb_trace",
      pcb_trace_id: "foreign",
      connection_name: "other",
      route: [w(0, 0.4, "bottom"), w(0, 2.2, "bottom")],
    },
    input: SimpleRouteJson = {
      layerCount: 4,
      allowBlindAndBuriedVias: false,
      minTraceWidth: 0.1016,
      minTraceToPadEdgeClearance: 0.1016,
      minViaPadDiameter: 0.4572,
      minViaHoleDiameter: 0.254,
      minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
      allowedLayers: ["top", "bottom"],
      bounds: { minX: -6, maxX: 6, minY: -6, maxY: 6 },
      connections: [
        {
          name: "signal",
          source_trace_id: "source_signal",
          pointsToConnect: [
            original.route[0] as Wire,
            original.route.at(-1) as Wire,
          ],
        },
        {
          name: "other",
          pointsToConnect: [
            foreign.route[0] as Wire,
            foreign.route.at(-1) as Wire,
          ],
        },
      ],
      obstacles: [
        {
          type: "rect",
          center: { x: 0, y: 3.175 },
          width: 12,
          height: 5.65,
          layers: ["top"],
          connectedTo: ["wall"],
        },
        {
          type: "rect",
          center: { x: 0, y: -3.175 },
          width: 12,
          height: 5.65,
          layers: ["top"],
          connectedTo: ["wall"],
        },
      ],
      traces: [],
      differentialPairs: [],
    },
    fixedEscapes = [
      {
        ...original,
        pcb_trace_id: "prefix",
        route: original.route.slice(0, 2),
      },
      { ...original, pcb_trace_id: "suffix", route: original.route.slice(2) },
    ]
  return { input, original, foreign, fixedEscapes }
}
function proposals(
  input: SimpleRouteJson,
  routes: Trace[],
  fixedEscapes: Trace[],
  overrides: Partial<OrdinaryLengthExcursionOptions> = {},
) {
  const result: OrdinaryLengthExcursionProposal[] = []
  for (const proposal of enumerateOrdinaryTwoViaLengthExcursions(
    input,
    routes,
    {
      connectionName: "signal",
      minimumLength: 11.5,
      maximumLength: 11.55,
      fixedEscapes,
      tuningBays: [{ minX: -2, maxX: 2, minY: 2.6, maxY: 5.5, side: "north" }],
      maximumCandidates: 1,
      maximumAttachmentPairs: 4,
      maximumAttempts: 128,
      maximumExpansions: 1000,
      maximumPortalOffset: 0.2,
      deadlineMs: performance.now() + 5000,
      ...overrides,
    },
  ))
    if (proposal) result.push(proposal)
  return result
}
describe("post-route ordinary opposite-plane length excursions", () => {
  test("a blocked local surface bank is replaced by a real opposite-plane remote bay", () => {
    const { input, original, foreign, fixedEscapes } = fixture(),
      routes = [original, foreign],
      before = JSON.stringify({ input, routes, fixedEscapes })
    expect(
      physicalRoutingAcceptance(input, routes, { escapes: fixedEscapes })
        .physicalRoutingAccepted,
    ).toBe(true)
    let localSucceeded = false
    try {
      const local = tuneSmoothLengths(
        { ...input, traces: [foreign] },
        [original],
        new Map([["signal", 11.5]]),
        { maxCandidates: 64, packMeanders: true },
      )
      localSucceeded = length(local[0].route) >= 11.5 - 1e-7
    } catch (error) {
      expect(
        error instanceof IncompleteLengthTuningError ||
          String(error).includes("candidate budget"),
      ).toBe(true)
    }
    expect(localSucceeded).toBe(false)
    const result = proposals(input, routes, fixedEscapes)
    expect(result.length).toBe(1)
    const p = result[0]
    expect(p.withinTargetBand).toBe(true)
    expect(p.fullOwnedLength).toBeGreaterThanOrEqual(11.5 - 1e-7)
    expect(p.fullOwnedLength).toBeLessThanOrEqual(11.55 + 1e-7)
    expect(p.trace.route.filter((p) => p.route_type === "via")).toHaveLength(2)
    expect(
      p.trace.route
        .filter((p) => p.route_type === "via")
        .every(
          (p) =>
            p.route_type === "via" &&
            p.via_diameter === 0.4572 &&
            p.via_hole_diameter === 0.254 &&
            JSON.stringify(p.layers) ===
              JSON.stringify(["top", "inner1", "inner2", "bottom"]),
        ),
    ).toBe(true)
    expect(findFixedPathRanges(p.trace, fixedEscapes)?.length).toBe(2)
    expect(
      physicalRoutingAcceptance(input, [p.trace, foreign], {
        escapes: fixedEscapes,
      }).physicalRoutingAccepted,
    ).toBe(true)
    expect(p.trace.pcb_trace_id).toBe(original.pcb_trace_id)
    expect(p.trace.source_trace_id).toBe(original.source_trace_id)
    expect(JSON.stringify({ input, routes, fixedEscapes })).toBe(before)
  })
  test("supplied same-owner native copper contributes exactly once to target length", () => {
    const { input, original, foreign, fixedEscapes } = fixture()
    input.traces = [
      {
        type: "pcb_trace",
        pcb_trace_id: "supplied",
        connection_name: "signal",
        source_trace_id: "source_signal",
        route: [w(-5, -5), w(-4.5, -5)],
      },
    ]
    // Keep that supplied trace outside the top-surface corridor walls.
    input.obstacles = input.obstacles.map((o) => ({ ...o, width: 8 }))
    const result = proposals(input, [original, foreign], fixedEscapes, {
      minimumLength: 12,
      maximumLength: 12.05,
    })
    expect(result.length).toBe(1)
    expect(result[0].fullOwnedLength).toBeCloseTo(
      length(result[0].trace.route) + 0.5,
      8,
    )
    expect(result[0].fullOwnedLength).toBeGreaterThanOrEqual(12 - 1e-7)
  })
  test("full-stack barrels cannot pass an inner-only native obstacle", () => {
    const { input, original, foreign, fixedEscapes } = fixture()
    input.obstacles.push({
      type: "rect",
      center: { x: 0, y: 0 },
      width: 5.2,
      height: 0.8,
      layers: ["inner1"],
      connectedTo: ["inner-copper"],
    })
    expect(
      physicalRoutingAcceptance(input, [original, foreign], {
        escapes: fixedEscapes,
      }).physicalRoutingAccepted,
    ).toBe(true)
    expect(proposals(input, [original, foreign], fixedEscapes)).toHaveLength(0)
  })
  test("foreign opposite-surface copper makes a requested remote bay unavailable", () => {
    const { input, original, foreign, fixedEscapes } = fixture()
    input.obstacles.push({
      type: "rect",
      center: { x: 0, y: 4 },
      width: 5,
      height: 3,
      layers: ["bottom"],
      connectedTo: ["remote-blocker"],
    })
    expect(
      physicalRoutingAcceptance(input, [original, foreign], {
        escapes: fixedEscapes,
      }).physicalRoutingAccepted,
    ).toBe(true)
    expect(proposals(input, [original, foreign], fixedEscapes)).toHaveLength(0)
  })
  test("missing or modified immutable paths reject the invocation without geometry edits", () => {
    const { input, original, foreign, fixedEscapes } = fixture(),
      before = JSON.stringify({ input, original, foreign })
    fixedEscapes[0].route = [...fixedEscapes[0].route.slice(0, 1), w(-2.4, 0)]
    expect(proposals(input, [original, foreign], fixedEscapes)).toHaveLength(0)
    expect(JSON.stringify({ input, original, foreign })).toBe(before)
  })
  test("partial proposals remain fully physical, strictly closer and explicitly outside the band", () => {
    const { input, original, foreign, fixedEscapes } = fixture(),
      result = proposals(input, [original, foreign], fixedEscapes, {
        minimumLength: 40,
        maximumLength: 40.05,
        allowPartialProgress: true,
      })
    expect(result.length).toBe(1)
    expect(result[0].withinTargetBand).toBe(false)
    expect(result[0].distanceToTargetBand).toBeLessThan(
      result[0].previousDistanceToTargetBand,
    )
    expect(
      physicalRoutingAcceptance(input, [result[0].trace, foreign], {
        escapes: fixedEscapes,
      }).physicalRoutingAccepted,
    ).toBe(true)
  })
  test("kept same-owner opposite-plane copper remains a self-contact guard", () => {
    const { input, foreign } = fixture()
    const via = (x: number, from_layer: string, to_layer: string) => ({
      route_type: "via" as const,
      x,
      y: 0,
      from_layer,
      to_layer,
      layers: ["top", "inner1", "inner2", "bottom"],
      via_diameter: 0.4572,
      via_hole_diameter: 0.254,
    })
    const prefix = [
      w(-4, 0),
      w(-3, 0),
      via(-3, "top", "bottom"),
      w(-3, 0, "bottom"),
      w(-3, 3.8, "bottom"),
      w(-2.8, 4, "bottom"),
      w(2.8, 4, "bottom"),
      w(3, 3.8, "bottom"),
      w(3, 3.2, "bottom"),
      w(2.8, 3, "bottom"),
      w(-1.8, 3, "bottom"),
      w(-2, 2.8, "bottom"),
      w(-2, 0, "bottom"),
      via(-2, "bottom", "top"),
      w(-2, 0),
      w(-1.9, 0),
    ]
    const original: Trace = {
        type: "pcb_trace",
        pcb_trace_id: "own-loop",
        connection_name: "signal",
        source_trace_id: "source_signal",
        route: [...prefix, w(3.5, 0), w(4, 0)],
      },
      fixedEscapes = [
        { ...original, pcb_trace_id: "kept-loop", route: prefix },
        {
          ...original,
          pcb_trace_id: "suffix",
          route: original.route.slice(-2),
        },
      ]
    input.connections[0].pointsToConnect = [
      original.route[0] as Wire,
      original.route.at(-1) as Wire,
    ]
    expect(
      physicalRoutingAcceptance(input, [original, foreign], {
        escapes: fixedEscapes,
      }).physicalRoutingAccepted,
    ).toBe(true)
    expect(
      proposals(input, [original, foreign], fixedEscapes, {
        minimumLength: length(original.route) + 3,
        maximumLength: length(original.route) + 3.1,
        allowPartialProgress: true,
      }),
    ).toHaveLength(0)
  })

  test("existing four-via fanouts do not impose an artificial added-via cap", () => {
    const { input, foreign } = fixture()
    const via = (x: number, from_layer: string, to_layer: string) => ({
      route_type: "via" as const,
      x,
      y: 0,
      from_layer,
      to_layer,
      layers: ["top", "inner1", "inner2", "bottom"],
      via_diameter: 0.4572,
      via_hole_diameter: 0.254,
    })
    const prefix = [
        w(-4.7, 0),
        w(-4.2, 0),
        via(-4.2, "top", "bottom"),
        w(-4.2, 0, "bottom"),
        w(-3.4, 0, "bottom"),
        via(-3.4, "bottom", "top"),
        w(-3.4, 0),
      ],
      suffix = [
        w(3.4, 0),
        via(3.4, "top", "bottom"),
        w(3.4, 0, "bottom"),
        w(4.2, 0, "bottom"),
        via(4.2, "bottom", "top"),
        w(4.2, 0),
        w(4.7, 0),
      ]
    const original: Trace = {
        type: "pcb_trace",
        pcb_trace_id: "four-via",
        connection_name: "signal",
        source_trace_id: "source_signal",
        route: [...prefix, ...suffix],
      },
      fixedEscapes = [
        { ...original, pcb_trace_id: "four-via-prefix", route: prefix },
        { ...original, pcb_trace_id: "four-via-suffix", route: suffix },
      ]
    input.connections[0].pointsToConnect = [
      original.route[0] as Wire,
      original.route.at(-1) as Wire,
    ]
    expect(
      physicalRoutingAcceptance(input, [original, foreign], {
        escapes: fixedEscapes,
      }).physicalRoutingAccepted,
    ).toBe(true)
    const result = proposals(input, [original, foreign], fixedEscapes, {
      minimumLength: 15,
      maximumLength: 15.05,
    })
    expect(result.length).toBe(1)
    expect(
      result[0].trace.route.filter((p) => p.route_type === "via"),
    ).toHaveLength(6)
    expect(findFixedPathRanges(result[0].trace, fixedEscapes)?.length).toBe(2)
    expect(
      physicalRoutingAcceptance(input, [result[0].trace, foreign], {
        escapes: fixedEscapes,
      }).physicalRoutingAccepted,
    ).toBe(true)
  })

  test("untouched fixed curve permissions survive exact suffix-index remapping", () => {
    const { input, original, foreign, fixedEscapes } = fixture()
    original.curvedSegments = [1, 3]
    fixedEscapes[0].curvedSegments = [1]
    fixedEscapes[1].curvedSegments = [1]
    const result = proposals(input, [original, foreign], fixedEscapes)
    expect(result.length).toBe(1)
    expect(result[0].trace.curvedSegments).toContain(1)
    expect(result[0].trace.curvedSegments).toContain(
      result[0].trace.route.length - 1,
    )
    expect(findFixedPathRanges(result[0].trace, fixedEscapes)?.length).toBe(2)
  })
  test("a caller cannot request a band beyond configured native absolute limits", () => {
    const { input, original, foreign, fixedEscapes } = fixture()
    input.buses = [
      { busId: "absolute", connectionNames: ["signal"], maxLength: 10 },
    ]
    expect(
      proposals(input, [original, foreign], fixedEscapes, {
        minimumLength: 11.5,
        maximumLength: 12,
      }),
    ).toHaveLength(0)
  })

  test("a one-surface native signal policy cannot be silently expanded", () => {
    const { input, original, foreign, fixedEscapes } = fixture()
    input.allowedLayers = ["top"]
    // This deliberately makes the supplied complete scene invalid too.
    expect(proposals(input, [original, foreign], fixedEscapes)).toHaveLength(0)
  })
})

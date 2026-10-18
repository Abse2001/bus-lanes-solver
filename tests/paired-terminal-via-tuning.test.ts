import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { loadG350Am3352RepairedSample } from "../scripts/g350-am3352-repaired-sample"
import { checkSignalSelfShorts } from "../scripts/check-signal-self-shorts"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { length } from "../lib/geometry"
import { pairLengthReports } from "../lib/route-lengths"
import { sharedPairSpacingReports } from "../lib/shared-pair-spacing"
import { tuneSmoothLengths } from "../lib/smooth-length-tuning"
import type { Trace, Wire } from "../lib/types"

const wire = (x: number, y: number, layer = "bottom"): Wire => ({
  route_type: "wire",
  x,
  y,
  layer,
  width: 0.1016,
})
const carrier = (
  name: string,
  points: Array<[number, number]>,
  coupledSection: [number, number],
): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: `pair_${name}`,
  source_trace_id: name,
  connection_name: name,
  route: points.map(([x, y]) => wire(x, y)),
  coupledSection,
})

test("paired DQS correction leaves its generated via land before starting a rounded bank", () => {
  // The untuned DQS0 approach that exposed the issue: a short 45-degree via
  // departure precedes a vertical tuning run. A near-end rounded lobe can
  // remain in the via land after the native check's along-route allowance.
  const native = loadG350Am3352RepairedSample()
  const pair = native.differentialPairs!.find((pair) =>
    pair.connectionNames.includes("source_trace_15"),
  )!
  const traces = [
    carrier(
      "source_trace_15",
      [
        [4, 13.6],
        [4.1108, 13.4892],
        [4.1108, 12.5752],
        [4.1108, 11.788905137289062],
        [2.078347431355469, 9.756452568644532],
        [2.078347431355469, 8.32165256864453],
        [2.4, 8],
      ],
      [2, 4],
    ),
    carrier(
      "source_trace_16",
      [
        [4, 14.4],
        [3.5844, 13.9844],
        [3.5844, 12.88],
        [3.8892, 12.5752],
        [3.8892, 11.880694862710941],
        [1.9216525686445303, 9.91314743135547],
        [1.854, 9.84549486271094],
        [1.854, 8.254],
        [1.6, 8],
      ],
      [3, 5],
    ),
  ]
  const escapes = traces.flatMap((trace) => {
    const connection = native.connections.find(
      (connection) => connection.name === trace.connection_name,
    )!
    return [trace.route[0], trace.route.at(-1)!].map(
      (end, index): Trace => ({
        ...trace,
        pcb_trace_id: `${trace.pcb_trace_id}_escape_${index}`,
        coupledSection: undefined,
        route: [
          {
            ...connection.pointsToConnect[index],
            route_type: "wire",
            width: 0.1016,
          },
          wire(end.x, end.y, "top"),
          {
            route_type: "via",
            x: end.x,
            y: end.y,
            from_layer: "top",
            to_layer: "bottom",
            layers: ["top", "inner1", "inner2", "bottom"],
            via_diameter: 0.4572,
            via_hole_diameter: 0.254,
          },
          wire(end.x, end.y),
        ],
      }),
    )
  })
  const input = {
    ...native,
    buses: [],
    differentialPairs: [pair],
    traces: escapes,
    connections: traces.map((trace) => ({
      ...native.connections.find(
        (connection) => connection.name === trace.connection_name,
      )!,
      pointsToConnect: [trace.route[0], trace.route.at(-1)!] as Wire[],
    })),
  }
  const fixedBefore = JSON.stringify(escapes)
  const target = 7.519617137318069
  const targets = new Map(
    traces.map((trace) => [
      trace.connection_name!,
      (trace.connection_name === "source_trace_15"
        ? target
        : length(trace.route)) +
        escapes
          .filter((escape) => escape.connection_name === trace.connection_name)
          .reduce((sum, escape) => sum + length(escape.route), 0),
    ]),
  )
  const tuned = tuneSmoothLengths(input, traces, targets, {
    maxCandidates: 512,
  })
  const joined = tuned.map((trace) =>
    joinSignalEscapes(
      trace,
      escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
  expect(tuned[0].curvedSegments?.length).toBeGreaterThan(0)
  expect(length(tuned[0].route)).toBeCloseTo(target, 6)
  expect(checkSignalSelfShorts(native, joined)).toEqual([])
  expect(
    pairLengthReports(input, tuned).every((report) => report.matched),
  ).toBe(true)
  expect(
    sharedPairSpacingReports(input, tuned).every((report) => report.matched),
  ).toBe(true)
  expect(
    validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: { ...native, traces: joined },
      clearance: 0.1016,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0]).valid,
  ).toBe(true)
  expect(JSON.stringify(escapes)).toBe(fixedBefore)
})

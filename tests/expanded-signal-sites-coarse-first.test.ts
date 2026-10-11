import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  expandedSignalSites,
  expandedSignalSiteChoices,
} from "../lib/expanded-signal-sites"
import { negotiateSignalSites } from "../lib/negotiate-signal-sites"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import type { SimpleRouteJson, Trace } from "../lib/types"
import { loadG350Am3352Sample } from "../scripts/g350-am3352-sample"

// Actual A7 pad fields with immutable checked clock approaches. The CPU
// endpoint has no accepted coarse site; the RAM endpoint already has 29.
function narrowNativeApproach(): SimpleRouteJson {
  const input = loadG350Am3352Sample()
  const approaches = [
    {
      name: "source_trace_33",
      points: [
        [-4.4, 14],
        [-4, 14.4],
        [-3.46045257, 14.4],
        [-3.238, 14.17754743],
        [-3.238, 13.014],
        [-3.54457103, 12.70742897],
        [-3.54457103, 12.59966589],
      ],
    },
    {
      name: "source_trace_34",
      points: [
        [-4.4, 13.2],
        [-4, 13.6],
        [-4, 12.74170514],
        [-3.75514743, 12.49685257],
      ],
    },
  ]
  input.traces = approaches.map(
    ({ name, points }): Trace => ({
      type: "pcb_trace",
      pcb_trace_id: `fixed_approach_${name}`,
      connection_name: name,
      source_trace_id: name,
      route: points.map(([x, y]) => ({
        x,
        y,
        route_type: "wire",
        layer: "top",
        width: 0.1016,
      })),
    }),
  )
  return input
}

function complete<T>(work: Generator<void, T>): T {
  let next = work.next()
  try {
    for (let steps = 0; !next.done && steps < 100_000; steps++)
      next = work.next()
    expect(next.done).toBe(true)
    if (!next.done) throw new Error("expanded site search did not complete")
    return next.value
  } finally {
    if (!next.done) work.return(undefined as T)
  }
}

test("fine recovery leaves a healthy opposite endpoint byte-identical to the frozen coarse baseline", () => {
  const input = narrowNativeApproach()
  const before = structuredClone(input)
  const connection = input.connections.find((c) => c.name === "source_trace_9")!
  let deferred = 0
  const coarseEnds = complete(
    expandedSignalSites(input, connection, "bottom", {
      onDeferredFineNativeApproachRetry: () => {
        deferred++
      },
    }),
  )
  expect(coarseEnds[0]).toEqual([])
  expect(coarseEnds[1]).toHaveLength(29)
  expect(deferred).toBe(1)
  const ends = complete(
    expandedSignalSites(input, connection, "bottom", {
      allowFineNativeApproachRetry: true,
    }),
  )
  expect(ends[1]).toEqual(coarseEnds[1])
  // Frozen f7428d538bc3f71b0f408eb2fca354f2787e8c87 returned CPU=[], RAM=29.
  // This digest includes ordered terminal coordinates, full escape geometry,
  // widths, manufactured via dimensions/span, route identifiers and lengths.
  expect(ends[1]).toHaveLength(29)
  expect(
    createHash("sha256").update(JSON.stringify(ends[1])).digest("hex"),
  ).toBe("857eae0486708a0f8c3d6c56f2bf3c75842dc46ce4563f6d8064f34db6611fb1")
  expect(ends[0]).toHaveLength(3)

  const choices = complete(
    expandedSignalSiteChoices(input, connection, "bottom", 1, {
      allowFineNativeApproachRetry: true,
    }),
  )
  expect(choices).toHaveLength(1)
  const choice = choices[0]
  const carrier: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "coarse_first_recovered_a7",
    connection_name: connection.name,
    source_trace_id: connection.name,
    route: choice.route,
  }
  const joined = joinSignalEscapes(carrier, choice.escapes)
  expect(joined.route[0]).toMatchObject(connection.pointsToConnect[0])
  expect(joined.route.at(-1)).toMatchObject(connection.pointsToConnect[1])
  const report = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: [...input.traces!, joined] },
    clearance: 0.1016,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(report.valid).toBe(true)
  expect(report.issues).toEqual([])
  expect(input.obstacles).toHaveLength(854)
  expect(input).toEqual(before)
}, 30_000)

test("an actual A7 coarse failure reports precision once and the explicit fine replay manufactures a connection", () => {
  const input = narrowNativeApproach()
  const before = structuredClone(input)
  const connection = input.connections.find(
    (candidate) => candidate.name === "source_trace_9",
  )!
  const state: FlexibleSignalState = {
    native: input,
    pending: input,
    escapes: [],
    traces: [],
    retained: [],
  }
  let deferred = 0
  const coarse = complete(
    negotiateSignalSites(state, new Set([connection.name]), false, false, {
      allowExpandedSites: true,
      expandOnlyWhenBlocked: true,
      onDeferredFineNativeApproachRetry: () => {
        deferred++
      },
    }),
  )
  expect(coarse).toBeNull()
  expect(deferred).toBe(1)
  const fine = complete(
    negotiateSignalSites(state, new Set([connection.name]), false, false, {
      allowExpandedSites: true,
      expandOnlyWhenBlocked: true,
      allowFineNativeApproachRetry: true,
      onDeferredFineNativeApproachRetry: () => {
        deferred++
      },
    }),
  )
  expect(fine).toBeTruthy()
  expect(fine!.traces).toHaveLength(1)
  const joined = joinSignalEscapes(fine!.traces[0], fine!.escapes)
  const checked = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces: [...input.traces!, joined] },
    clearance: 0.1016,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(checked).toMatchObject({ valid: true, issues: [] })
  expect(deferred).toBe(1)
  expect(input).toEqual(before)
}, 30000)

test("denying expansion and canceling native coarse generation emit no precision deferral", () => {
  const input = narrowNativeApproach()
  const connection = input.connections.find(
    (candidate) => candidate.name === "source_trace_9",
  )!
  const state: FlexibleSignalState = {
    native: input,
    pending: input,
    escapes: [],
    traces: [],
    retained: [],
  }
  let deferred = 0
  expect(
    complete(
      negotiateSignalSites(state, new Set([connection.name]), false, false, {
        allowExpandedSites: false,
        onDeferredFineNativeApproachRetry: () => {
          deferred++
        },
      }),
    ),
  ).toBeNull()
  expect(deferred).toBe(0)
  const work = expandedSignalSites(input, connection, "bottom", {
    onDeferredFineNativeApproachRetry: () => {
      deferred++
    },
  })
  expect(work.next().done).toBe(false)
  work.return([[], []])
  expect(deferred).toBe(0)
}, 30000)

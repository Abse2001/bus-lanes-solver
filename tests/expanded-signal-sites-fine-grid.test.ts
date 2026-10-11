import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { expandedSignalSiteChoices } from "../lib/expanded-signal-sites"
import { distance, length } from "../lib/geometry"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import type { SimpleRouteJson, Trace, Wire } from "../lib/types"
import { fixedCopper, VectorScene } from "../lib/vector-scene"
import { loadG350Am3352Sample } from "../scripts/g350-am3352-sample"

/** The actual A7 pad field and checked clock approaches leave a native
 * centerline channel narrower than the coarse raster. Retain every real pad;
 * these supplied approach fragments are immutable routing obstacles. */
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

function choicesForA7(input: SimpleRouteJson) {
  const connection = input.connections.find((c) => c.name === "source_trace_9")!
  const work = expandedSignalSiteChoices(input, connection, "bottom", 4)
  let step = work.next()
  for (let i = 0; !step.done && i < 20_000; i++) step = work.next()
  expect(step.done).toBe(true)
  return step.done ? step.value : []
}

test("a bounded fine native approach recovers a real pad channel missed by the coarse raster", () => {
  const input = narrowNativeApproach()
  const before = structuredClone(input)
  const connection = input.connections.find((c) => c.name === "source_trace_9")!
  const pad = connection.pointsToConnect[0]
  const site = { x: -4.8, y: 13.6, layer: "top" }
  const local = { ...connection, pointsToConnect: [pad, site] }
  const coarse = new GridVisibilitySearch(
    new VectorScene(input, local, input.minTraceWidth, fixedCopper(input)),
    pad,
    site,
    [],
    0,
    undefined,
    { checkReachability: true, allTerminalAttachments: true, maxLength: 2 },
  )
  try {
    for (let i = 0; !coarse.solved && !coarse.failed && i < 4000; i++)
      coarse.step()
    expect(coarse.solved).toBe(false)
  } finally {
    coarse.cancel()
  }

  const choices = choicesForA7(input)
  expect(choices.length).toBeGreaterThan(0)
  for (const choice of choices) {
    for (const [end, escape] of choice.escapes.entries()) {
      const approach = escape.route.filter(
        (p): p is Wire => p.route_type === "wire" && p.layer === "top",
      )
      // Fine-grid retry cannot relax the existing 2 mm native approach bound.
      expect(length(approach)).toBeLessThanOrEqual(2 + 1e-8)
      const via = escape.route.find((p) => p.route_type === "via")!
      expect(
        distance(via, connection.pointsToConnect[end]),
      ).toBeLessThanOrEqual(2 + 1e-8)
      expect(via.layers).toEqual(["top", "inner1", "inner2", "bottom"])
      expect(via.via_diameter).toBe(0.4572)
      expect(via.via_hole_diameter).toBe(0.254)
    }
    const carrier: Trace = {
      type: "pcb_trace",
      pcb_trace_id: "recovered_a7",
      connection_name: connection.name,
      route: choice.route,
    }
    const output = {
      ...input,
      traces: [...input.traces!, joinSignalEscapes(carrier, choice.escapes)],
    }
    const report = validateRoutedCopperDrc({
      inputSrj: input,
      routedSrj: output,
      clearance: 0.1016,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
    expect(report.valid).toBe(true)
    expect(report.issues).toEqual([])
    expect(output.traces.slice(0, input.traces!.length)).toEqual(
      input.traces ?? [],
    )
  }
  expect(input.obstacles).toHaveLength(854)
  expect(input).toEqual(before)
}, 30_000)

test("fine-grid retries cannot pass through copper covering the native pad", () => {
  const input = narrowNativeApproach()
  const pad = input.connections.find((c) => c.name === "source_trace_9")!
    .pointsToConnect[0]
  input.obstacles.push({
    shape: "circle",
    center: { x: pad.x, y: pad.y },
    width: 0.6,
    height: 0.6,
    layers: ["top"],
    connectedTo: ["blocking_copper"],
  })
  const before = structuredClone(input)
  expect(choicesForA7(input)).toEqual([])
  expect(input).toEqual(before)
}, 30_000)

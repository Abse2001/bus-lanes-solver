import { expect, test } from "bun:test"
import type { SimpleRouteJson, Trace, Via } from "../lib"
import { validateG350Am3352Sample } from "../scripts/validate-g350-am3352-sample"
import {
  g350LayerWireSignalCounts,
  g350SnapshotTraces,
} from "../scripts/snapshot-g350-am3352"
import {
  routedGraphics,
  type Am3352SnapshotCandidate,
} from "../scripts/snapshot-routed-am3352"

/** Small physical paths isolate the strict copper/graphics guards. These are
 * unit fixtures, never accepted G350 routing or exported review images. */
function fixture(viaCount: 2 | 6 = 2) {
  const input: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    allowBlindAndBuriedVias: false,
    minTraceWidth: 0.1016,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minTraceToPadEdgeClearance: 0.1016,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.254,
    bounds: { minX: -5, maxX: 5, minY: -2, maxY: 2 },
    outline: [
      { x: -5, y: -2 },
      { x: 5, y: -2 },
      { x: 5, y: 2 },
      { x: -5, y: 2 },
    ],
    obstacles: [],
    connections: [
      {
        name: "D",
        pointsToConnect: [
          { x: -4, y: 0, layer: "top" },
          { x: 3, y: 0, layer: "top" },
        ],
      },
    ],
    traces: [],
  }
  const trace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "unit_D",
    connection_name: "D",
    route: [{ route_type: "wire", x: -4, y: 0, layer: "top", width: 0.1016 }],
  }
  let layer = "top"
  for (const x of viaCount === 6 ? [-3, -2, -1, 0, 1, 2] : [-2, 2]) {
    const next = layer === "top" ? "bottom" : "top"
    trace.route.push(
      { route_type: "wire", x, y: 0, layer, width: 0.1016 },
      { route_type: "via", x, y: 0, from_layer: layer, to_layer: next },
      { route_type: "wire", x, y: 0, layer: next, width: 0.1016 },
    )
    layer = next
  }
  trace.route.push({ route_type: "wire", x: 3, y: 0, layer, width: 0.1016 })
  return { input, trace, output: { ...input, traces: [trace] } }
}

test("strict copper acceptance checks the declared width at every wire point", () => {
  const base = fixture()
  expect(validateG350Am3352Sample(base.input, base.output).valid).toBe(true)
  for (const index of [0, 3, base.trace.route.length - 1]) {
    const { input, trace, output } = fixture()
    const point = trace.route[index]
    if (point.route_type !== "wire") throw Error("Expected a wire fixture")
    point.width = 0.05
    const report = validateG350Am3352Sample(input, output)
    expect(report.geometryPreserved).toBe(true)
    expect(report.wireWidthsValid).toBe(false)
    expect(report.valid).toBe(false)
  }
})

test("width serialization tolerance preserves pinned copper without accepting wider or thinner substitutes", () => {
  const { input, trace, output } = fixture()
  for (const point of trace.route)
    if (point.route_type === "wire") point.width += 1e-9
  expect(validateG350Am3352Sample(input, output).wireWidthsValid).toBe(true)
  for (const width of [0.101599, 0.101601]) {
    const point = trace.route[0]
    if (point.route_type !== "wire") throw Error("Expected a wire fixture")
    point.width = width
    expect(validateG350Am3352Sample(input, output).wireWidthsValid).toBe(false)
  }
})

test("optional via fields use legal pinned defaults while explicit wrong dimensions or spans reject", () => {
  const base = fixture()
  expect(validateG350Am3352Sample(base.input, base.output).allowedLayers).toBe(
    true,
  )
  const damage: Array<(via: Via) => void> = [
    (via) => {
      via.via_diameter = 0.3
    },
    (via) => {
      via.via_hole_diameter = 0.15
    },
    (via) => {
      via.layers = ["top", "bottom"]
    },
    (via) => {
      Reflect.set(via, "via_diameter", null)
    },
    (via) => {
      Reflect.set(via, "via_hole_diameter", null)
    },
  ]
  for (const change of damage) {
    const { input, trace, output } = fixture()
    const via = trace.route.find(
      (point): point is Via => point.route_type === "via",
    )!
    change(via)
    const report = validateG350Am3352Sample(input, output)
    expect(report.allowedLayers).toBe(false)
    expect(report.valid).toBe(false)
  }
})

test("G350 graphics copies resolve full-stack lands and drills without changing saved optional fields", () => {
  const { input, trace, output } = fixture(6)
  const before = structuredClone({ input, output })
  expect(validateG350Am3352Sample(input, output).valid).toBe(true)
  const traces = g350SnapshotTraces(input, [trace])
  const counts = g350LayerWireSignalCounts(input, traces)
  expect(counts).toEqual({ top: 1, inner1: 0, inner2: 0, bottom: 1 })
  for (const point of traces[0].route)
    if (point.route_type === "via")
      expect(point).toMatchObject({
        via_diameter: 0.4572,
        via_hole_diameter: 0.254,
        layers: ["top", "inner1", "inner2", "bottom"],
      })
  const candidate = {
    metadata: { name: "unit-g350", fixedFanoutTraces: [] },
    solver: { input, traces },
  } as unknown as Am3352SnapshotCandidate
  const { graphics } = routedGraphics(candidate, {
    title: "unit geometry",
    status: "unit geometry",
    skew: "unit geometry",
    layerWireSignalCounts: counts,
  })
  // Six legal transitions have lands and drills on every physical panel.
  expect(graphics.circles).toHaveLength(48)
  for (const color of ["#e56b6f", "#f1b75d", "#b586ed", "#8cd391"])
    expect(
      graphics.circles!.filter((circle) => circle.fill === color),
    ).toHaveLength(6)
  expect(
    graphics
      .circles!.filter((circle) => circle.fill !== "#10151b")
      .every((circle) => circle.radius === 0.4572 / 2),
  ).toBe(true)
  expect(
    graphics
      .circles!.filter((circle) => circle.fill === "#10151b")
      .every((circle) => circle.radius === 0.254 / 2),
  ).toBe(true)
  expect({ input, output }).toEqual(before)
  expect(
    trace.route
      .filter((point) => point.route_type === "via")
      .every(
        (via) =>
          via.layers === undefined &&
          via.via_diameter === undefined &&
          via.via_hole_diameter === undefined,
      ),
  ).toBe(true)
})

test("graphics normalization never repairs explicit dimensions or physical spans", () => {
  const { input, trace } = fixture()
  const via = trace.route.find(
    (point): point is Via => point.route_type === "via",
  )!
  via.via_diameter = 0.3
  via.via_hole_diameter = 0.15
  via.layers = ["top", "bottom"]
  const normalized = g350SnapshotTraces(input, [trace])
  expect(
    normalized[0].route.find((point) => point.route_type === "via"),
  ).toMatchObject({
    via_diameter: 0.3,
    via_hole_diameter: 0.15,
    layers: ["top", "bottom"],
  })
  const normalizedVia = normalized[0].route.find(
    (point): point is Via => point.route_type === "via",
  )!
  normalizedVia.layers![0] = "changed graphics copy"
  expect(via.layers).toEqual(["top", "bottom"])
})

test("generic AM3352 panel counts retain their single-carrier policy without a G350 override", () => {
  const { input, trace } = fixture()
  const candidate = {
    metadata: { name: "unit-am3352", fixedFanoutTraces: [] },
    solver: { input, traces: g350SnapshotTraces(input, [trace]) },
  } as unknown as Am3352SnapshotCandidate
  const labels = {
    title: "unit geometry",
    status: "unit geometry",
    skew: "unit geometry",
  }
  const { graphics } = routedGraphics(candidate, labels)
  expect(graphics.texts!.slice(0, 4).map((text) => text.text)).toEqual([
    "top · 0 carriers",
    "inner1 · 0 carriers",
    "inner2 · 0 carriers",
    "bottom · 1 carriers",
  ])
  candidate.solver.traces = g350SnapshotTraces(input, [fixture(6).trace])
  expect(() => routedGraphics(candidate, labels)).toThrow(
    "Snapshot signal is missing its validated carrier layer",
  )
})

test("strict acceptance cannot report matching for a DRC-passing retraced path", () => {
  const { input } = fixture()
  input.bounds.maxX = 6
  input.outline = input.outline!.map((point) => ({
    ...point,
    x: point.x === 5 ? 6 : point.x,
  }))
  input.connections = [
    {
      name: "A",
      pointsToConnect: [
        { x: -4, y: 0, layer: "top" },
        { x: 3, y: 0, layer: "top" },
      ],
    },
    {
      name: "B",
      pointsToConnect: [
        { x: -4, y: 1, layer: "top" },
        { x: 5, y: 1, layer: "top" },
      ],
    },
  ]
  input.buses = [
    { busId: "data", connectionNames: ["A", "B"], maxLengthSkew: 0.635 },
  ]
  const traces: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "unit_A",
      connection_name: "A",
      route: [-4, 2, 1, 3].map((x) => ({
        route_type: "wire",
        x,
        y: 0,
        layer: "top",
        width: 0.1016,
      })),
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "unit_B",
      connection_name: "B",
      route: [-4, 5].map((x) => ({
        route_type: "wire",
        x,
        y: 1,
        layer: "top",
        width: 0.1016,
      })),
    },
  ]
  const output = { ...input, traces }
  const before = structuredClone({ input, output })
  const report = validateG350Am3352Sample(input, output)
  expect(report.complete).toBe(true)
  expect(report.drc.valid).toBe(true)
  expect(report.buses[0].matched).toBe(true)
  expect(report.pathIntegrity.valid).toBe(false)
  expect(report.matched).toBe(false)
  expect(report.valid).toBe(false)
  expect({ input, output }).toEqual(before)
})

test("malformed serialized points reject before unsafe geometric audit loops", () => {
  const { input, trace, output } = fixture()
  Reflect.set(trace.route, 0, null)
  const before = structuredClone({ input, output })
  const report = validateG350Am3352Sample(input, output)
  expect(report.pathIntegrity.structurallyValid).toBe(false)
  expect(report.complete).toBe(false)
  expect(report.drc.valid).toBe(false)
  expect(report.outline.valid).toBe(false)
  expect(report.valid).toBe(false)
  expect({ input, output }).toEqual(before)
})

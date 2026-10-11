import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import {
  busLengthReports,
  type SimpleRouteJson,
  type Trace,
  type Via,
  type Wire,
} from "../lib"
import { checkSignalSelfShorts } from "../scripts/check-signal-self-shorts"
import { validateG350PathIntegrity } from "../scripts/g350-path-integrity"

const wire = (x: number, y: number, layer = "top"): Wire => ({
  route_type: "wire",
  x,
  y,
  layer,
  width: 0.1016,
})
const via = (
  x: number,
  y: number,
  from_layer: string,
  to_layer: string,
): Via => ({
  route_type: "via",
  x,
  y,
  from_layer,
  to_layer,
  layers: ["top", "inner1", "inner2", "bottom"],
  via_diameter: 0.4572,
  via_hole_diameter: 0.254,
})
const trace = (route: Trace["route"], name = "D"): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: `unit_${name}`,
  connection_name: name,
  source_trace_id: name,
  route,
})
function inputFor(traces: Trace[]): SimpleRouteJson {
  return {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: 0.1016,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minTraceToPadEdgeClearance: 0.1016,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1016,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    obstacles: [],
    connections: traces.map((t) => ({
      name: t.connection_name!,
      pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => {
        if (p.route_type !== "wire") throw Error("Fixture needs wire ends")
        return { x: p.x, y: p.y, layer: p.layer }
      }),
    })),
    traces: [],
  }
}
function drc(input: SimpleRouteJson, traces: Trace[]) {
  return validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: { ...input, traces },
    clearance: 0.1016,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
}
const codes = (input: SimpleRouteJson, traces: Trace[]) =>
  validateG350PathIntegrity(input, traces).issues.map((issue) => issue.code)

test("six full-stack transitions are continuous without an arbitrary via-count limit", () => {
  const route: Trace["route"] = [wire(0, 0)]
  let layer = "top"
  for (let x = 1; x <= 6; x++) {
    const next = layer === "top" ? "bottom" : "top"
    route.push(wire(x, 0, layer), via(x, 0, layer, next), wire(x, 0, next))
    layer = next
  }
  route.push(wire(7, 0, layer))
  const t = trace(route),
    input = inputFor([t])
  const before = structuredClone({ input, t })
  expect(drc(input, [t]).valid).toBe(true)
  expect(validateG350PathIntegrity(input, [t])).toEqual({
    valid: true,
    structurallyValid: true,
    issues: [],
  })
  const omitted = structuredClone(t)
  for (const p of omitted.route)
    if (p.route_type === "via") {
      delete p.layers
      delete p.via_diameter
      delete p.via_hole_diameter
    }
  expect(validateG350PathIntegrity(input, [omitted]).valid).toBe(true)
  expect({ input, t }).toEqual(before)
})

test("fine raster chords and sampled smooth curves remain valid physical wire bodies", () => {
  const fine = trace(
    Array.from({ length: 201 }, (_, i) => wire(i * 0.01016, 0)),
  )
  const curved = trace(
    Array.from({ length: 101 }, (_, i) =>
      wire(Math.cos((i * Math.PI) / 200), Math.sin((i * Math.PI) / 200)),
    ),
    "CURVE",
  )
  curved.curvedSegments = Array.from({ length: 100 }, (_, i) => i + 1)
  for (const t of [fine, curved])
    expect(validateG350PathIntegrity(inputFor([t]), [t]).valid).toBe(true)
})

test("22-plus fine approach points inside a via landing are genuine contiguous copper", () => {
  const route: Trace["route"] = [
    wire(-1, 0),
    ...Array.from({ length: 26 }, (_, i) => wire((i - 25) * 0.01016, 0)),
    via(0, 0, "top", "bottom"),
    wire(0, 0, "bottom"),
    wire(1, 0, "bottom"),
    via(1, 0, "bottom", "top"),
    wire(1, 0),
    wire(2, 0),
  ]
  const t = trace(route),
    input = inputFor([t])
  expect(drc(input, [t]).valid).toBe(true)
  expect(validateG350PathIntegrity(input, [t]).valid).toBe(true)
})

test("projected top/bottom crossings are not same-layer shortcuts", () => {
  const t = trace([
    wire(0, 0),
    wire(3, 0),
    via(3, 0, "top", "bottom"),
    wire(3, 0, "bottom"),
    wire(3, 2, "bottom"),
    wire(1, 2, "bottom"),
    wire(1, -2, "bottom"),
    wire(4, -2, "bottom"),
    via(4, -2, "bottom", "top"),
    wire(4, -2),
    wire(5, -2),
  ])
  const input = inputFor([t])
  expect(drc(input, [t]).valid).toBe(true)
  expect(validateG350PathIntegrity(input, [t]).valid).toBe(true)
})

test("same-net backtracking can spoof matching despite the ordinary native DRC passing", () => {
  const a = trace([wire(0, 0), wire(2, 0), wire(1, 0), wire(4, 0)], "A")
  const b = trace([wire(0, 2), wire(6, 2)], "B")
  const input = inputFor([a, b])
  input.buses = [
    { busId: "DATA", connectionNames: ["A", "B"], maxLengthSkew: 0.635 },
  ]
  expect(busLengthReports(input, [a, b])[0].matched).toBe(true)
  expect(drc(input, [a, b]).valid).toBe(true)
  expect(codes(input, [a, b])).toContain("same-net-wire-shortcut")
})

test("curve metadata does not conceal crossing chords or returning wire arms", () => {
  const t = trace([wire(0, 0), wire(1, 1), wire(0, 1), wire(1, 0)])
  t.curvedSegments = [1, 2, 3]
  expect(codes(inputFor([t]), [t])).toContain("same-net-wire-shortcut")
  const returning = trace([
    wire(0, 0),
    wire(2, 0),
    wire(2, 0.05),
    wire(0, 0.05),
  ])
  expect(codes(inputFor([returning]), [returning])).toContain(
    "same-net-wire-shortcut",
  )
})

test("separate same-layer runs cannot bypass their intervening layer route", () => {
  const t = trace([
    wire(0, 0),
    wire(2, 0),
    via(2, 0, "top", "bottom"),
    wire(2, 0, "bottom"),
    wire(2, 2, "bottom"),
    wire(1, 2, "bottom"),
    via(1, 2, "bottom", "top"),
    wire(1, 2),
    wire(1, -1),
  ])
  expect(codes(inputFor([t]), [t])).toContain("same-net-cross-run-shortcut")
})

test("omitted via dimensions still expose a landing bypass without altering saved fields", () => {
  const t = trace([
    wire(0, 0),
    wire(1, 0),
    wire(1, 1),
    via(1, 1, "top", "bottom"),
    wire(1, 1, "bottom"),
    wire(0, 1, "bottom"),
    wire(0, 0.14, "bottom"),
    via(0, 0.14, "bottom", "top"),
    wire(0, 0.14),
    wire(-1, 0.14),
  ])
  for (const p of t.route)
    if (p.route_type === "via") {
      delete p.layers
      delete p.via_diameter
      delete p.via_hole_diameter
    }
  const input = inputFor([t]),
    before = structuredClone({ input, t })
  expect(checkSignalSelfShorts(input, [t])).toHaveLength(0)
  expect(drc(input, [t]).valid).toBe(true)
  expect(codes(input, [t])).toContain("same-net-via-wire-shortcut")
  expect({ input, t }).toEqual(before)
})

test("nonlocal overlapping via lands cannot bypass a long carrier detour", () => {
  const t = trace([
    wire(-1, 0),
    wire(0, 0),
    via(0, 0, "top", "bottom"),
    wire(0, 0, "bottom"),
    wire(0, 2, "bottom"),
    wire(0.4, 2, "bottom"),
    wire(0.4, 0, "bottom"),
    via(0.4, 0, "bottom", "top"),
    wire(0.4, 0),
    wire(1.4, 0),
  ])
  const input = inputFor([t])
  expect(drc(input, [t]).valid).toBe(true)
  expect(checkSignalSelfShorts(input, [t])).toHaveLength(0)
  expect(codes(input, [t])).toContain("same-net-via-shortcut")
  const local = trace([
    wire(-1, 0),
    wire(0, 0),
    via(0, 0, "top", "bottom"),
    wire(0, 0, "bottom"),
    wire(0.4, 0, "bottom"),
    via(0.4, 0, "bottom", "top"),
    wire(0.4, 0),
    wire(1.4, 0),
  ])
  expect(drc(inputFor([local]), [local]).valid).toBe(true)
  expect(validateG350PathIntegrity(inputFor([local]), [local]).valid).toBe(true)
  const canonical = inputFor([local])
  canonical.minViaHoleEdgeToViaHoleEdgeClearance = 0.254
  expect(codes(canonical, [local])).toContain("same-net-via-hole-clearance")
  const alias = inputFor([local])
  Reflect.set(alias, "minPlatedHoleDrillEdgeToDrillEdgeClearance", 0.254)
  expect(codes(alias, [local])).toContain("same-net-via-hole-clearance")
})

test("layer changes and malformed via handoffs reject independently of endpoint count", () => {
  const good = trace([
    wire(0, 0),
    wire(1, 0),
    via(1, 0, "top", "bottom"),
    wire(1, 0, "bottom"),
    wire(2, 0, "bottom"),
  ])
  const input = inputFor([good])
  const cases = [
    trace([wire(0, 0), wire(2, 0, "bottom")]),
    trace([
      wire(0, 0),
      wire(1, 0),
      via(1.05, 0, "top", "bottom"),
      wire(1, 0, "bottom"),
      wire(2, 0, "bottom"),
    ]),
    trace([
      wire(0, 0),
      wire(1, 0),
      via(1, 0, "bottom", "top"),
      wire(1, 0, "bottom"),
      wire(2, 0, "bottom"),
    ]),
    trace([
      wire(0, 0),
      via(0, 0, "top", "bottom"),
      via(0, 0, "bottom", "top"),
      wire(0, 0),
    ]),
    trace([via(0, 0, "top", "bottom")]),
  ]
  for (const t of cases) {
    const result = validateG350PathIntegrity(input, [t])
    expect(result.structurallyValid).toBe(true)
    expect(result.valid).toBe(false)
  }
})

test("unknown primitive kinds, nonfinite points and malformed dimensions are unsafe to parse", () => {
  const good = trace([wire(0, 0), wire(1, 0)])
  const input = inputFor([good])
  const damage: Array<(t: Trace) => void> = [
    (t) => Reflect.set(t.route[0], "route_type", "arc"),
    (t) => Reflect.set(t.route[0], "x", Number.NaN),
    (t) => Reflect.set(t.route[0], "width", 0),
    (t) => Reflect.set(t.route[0], "layer", "unknown"),
    (t) => Reflect.set(t.route, 0, null),
    (t) =>
      t.route.splice(1, 0, {
        ...via(0, 0, "top", "bottom"),
        layers: ["unknown"],
      }),
    (t) =>
      t.route.splice(1, 0, {
        ...via(0, 0, "top", "bottom"),
        via_diameter: Number.NaN,
      }),
  ]
  for (const mutate of damage) {
    const t = structuredClone(good)
    mutate(t)
    const result = validateG350PathIntegrity(input, [t])
    expect(result.valid).toBe(false)
    expect(result.structurallyValid).toBe(false)
  }
})

test("joined trace identifiers cannot collide with each other or immutable supplied copper", () => {
  const t = trace([wire(0, 0), wire(1, 0)]),
    input = inputFor([t])
  expect(codes(input, [t, structuredClone(t)])).toContain("duplicate-trace-id")
  input.traces = [structuredClone(t)]
  const before = structuredClone(input)
  expect(codes(input, [t])).toContain("duplicate-trace-id")
  expect(input).toEqual(before)
})

test("curve ending indices must identify real unique same-layer chords", () => {
  const good = trace([
    wire(0, 0),
    wire(1, 0),
    via(1, 0, "top", "bottom"),
    wire(1, 0, "bottom"),
    wire(2, 0, "bottom"),
  ])
  for (const indices of [[0], [5], [1, 1], [2], [3], [1.5]]) {
    const t = structuredClone(good)
    t.curvedSegments = indices
    expect(codes(inputFor([t]), [t])).toContain("invalid-curve-metadata")
  }
})

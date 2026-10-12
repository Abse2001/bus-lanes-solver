import { expect, test } from "bun:test"
import {
  countRouteViaTransitions,
  createViaCountConstraintChecker,
} from "../lib/via-count-constraints"
import type { SimpleRouteJson, Trace, Wire, Via } from "../lib/types"

// Pure accounting fixtures only. These are not routing or physical-DRC proofs.
const wire = (x: number, layer = "top", y = 0): Wire => ({
  route_type: "wire",
  x,
  y,
  layer,
  width: 0.1,
})
const barrel = (x: number, from = "top", to = "bottom"): Via => ({
  route_type: "via",
  x,
  y: 0,
  from_layer: from,
  to_layer: to,
  layers: ["top", "inner1", "inner2", "bottom"],
  via_diameter: 0.4572,
  via_hole_diameter: 0.254,
})
const path = (name: string, count: number, id = name, offset = 0): Trace => {
  const route: Trace["route"] = [wire(offset)]
  let layer = "top"
  for (let index = 0; index < count; index++) {
    const x = offset + index + 1,
      next = layer === "top" ? "bottom" : "top"
    route.push(wire(x, layer), barrel(x, layer, next), wire(x, next))
    layer = next
  }
  route.push(wire(offset + count + 2, layer))
  return { type: "pcb_trace", pcb_trace_id: id, connection_name: name, route }
}
const input = (names = ["A", "B"]): SimpleRouteJson => ({
  layerCount: 4,
  minTraceWidth: 0.1,
  obstacles: [],
  bounds: { minX: -10, maxX: 100, minY: -10, maxY: 10 },
  connections: names.map((name, y) => ({
    name,
    pointsToConnect: [wire(0, "top", y), wire(5, "top", y)],
  })),
  buses: [{ busId: "bus", connectionNames: names }],
})
const checker = (value: SimpleRouteJson = input(), bus = 0, pair?: number) => {
  const result = createViaCountConstraintChecker(value, {
    maxBusViaCountSkew: bus,
    maxPairViaCountSkew: pair,
  })
  expect(result).toBeDefined()
  return result!
}

test("omitted and explicit undefined constraints bypass all input accounting", () => {
  const invalid = input()
  invalid.connections[1].source_trace_id = "shared"
  invalid.connections[0].source_trace_id = "shared"
  expect(createViaCountConstraintChecker(invalid, {})).toBeUndefined()
  expect(
    createViaCountConstraintChecker(invalid, {
      maxBusViaCountSkew: undefined,
      maxPairViaCountSkew: undefined,
    }),
  ).toBeUndefined()
  const unreadable = Object.defineProperty({}, "connections", {
    get() {
      throw Error("disabled policy read input")
    },
  }) as SimpleRouteJson
  expect(createViaCountConstraintChecker(unreadable, {})).toBeUndefined()
})

test("zero is enabled and malformed count bounds reject before accounting", () => {
  expect(checker().policy).toEqual({ maxBusViaCountSkew: 0 })
  for (const value of [-1, 0.5, NaN, Infinity, -Infinity, null, "0", true])
    for (const field of ["maxBusViaCountSkew", "maxPairViaCountSkew"] as const)
      expect(() =>
        createViaCountConstraintChecker(input(), {
          [field]: value,
        } as unknown as Parameters<typeof createViaCountConstraintChecker>[1]),
      ).toThrow("nonnegative integer")
  expect(checker(input(), 1).policy).toEqual({ maxBusViaCountSkew: 1 })
})

test("generic N0 N1 N2 N3 records count independently of full physical span", () => {
  for (const count of [0, 1, 2, 3])
    expect(countRouteViaTransitions(path("A", count), input())).toBe(count)
  const reverse = path("A", 1)
  reverse.route = [
    wire(0, "bottom"),
    wire(1, "bottom"),
    barrel(1, "bottom", "top"),
    wire(1),
    wire(3),
  ]
  expect(countRouteViaTransitions(reverse, input())).toBe(1)
})

test("omitted source IDs resolve unique connection names", () => {
  const value = checker()
  expect(value.total("A", [path("A", 3)])).toBe(3)
  expect(value.total("B", [path("B", 1)])).toBe(1)
  expect(() => value.total("missing", [])).toThrow(
    "Unknown via-count connection",
  )
  expect(() => value.total("A", [path("B", 1)])).toThrow(
    "owned fragment mismatch",
  )
})

test("unique source-only fixed fragments contribute alongside owned carrier", () => {
  const value = input()
  value.connections[0].source_trace_id = "sourceA"
  const first = {
    ...path("A", 1, "fixed-cpu", 10),
    connection_name: undefined,
    source_trace_id: "sourceA",
  }
  const second = {
    ...path("A", 1, "fixed-ram", 20),
    connection_name: undefined,
    source_trace_id: "sourceA",
  }
  value.traces = [first, second, path("VCC", 1, "power", 40)]
  const before = structuredClone(value),
    counts = checker(value)
  expect(counts.total("A", [path("A", 1, "carrier", 30)])).toBe(3)
  expect(counts.total("B", [path("B", 0)])).toBe(0)
  expect(value).toEqual(before)
})

test("aliased sources and conflicting direct/source ownership reject explicitly", () => {
  const alias = input()
  for (const connection of alias.connections)
    connection.source_trace_id = "shared"
  expect(() => checker(alias)).toThrow("aliased source owner")
  const conflict = input()
  conflict.connections[0].source_trace_id = "sourceA"
  conflict.connections[1].source_trace_id = "sourceB"
  conflict.traces = [{ ...path("A", 1), source_trace_id: "sourceB" }]
  expect(() => checker(conflict)).toThrow("contradictory trace owner")
  const duplicate = input()
  duplicate.connections[1].name = "A"
  expect(() => checker(duplicate)).toThrow("duplicate connection name")
})

test("an unknown explicit owner cannot be silently replaced by a known source alias", () => {
  const value = input()
  value.connections[0].source_trace_id = "sourceA"
  value.traces = [
    {
      ...path("A", 1),
      connection_name: "wrong-owner",
      source_trace_id: "sourceA",
    },
  ]
  expect(() => checker(value)).toThrow(/owner|ambiguous|unsupported/i)
})

test("fixed N2 plus generated N0 is N2, while generated N2 produces N4", () => {
  const value = input()
  value.traces = [path("A", 2, "fixedA", 10)]
  const counts = checker(value),
    known = new Map([["B", 2]])
  const native = path("A", 0, "top-carrier", 30)
  const dogboned = path("A", 2, "bottom-approaches", 40)
  expect(counts.total("A", [native])).toBe(2)
  expect(counts.total("A", [dogboned])).toBe(4)
  expect(counts.acceptsKnown("A", counts.total("A", [native]), known)).toBe(
    true,
  )
  expect(counts.acceptsKnown("A", counts.total("A", [dogboned]), known)).toBe(
    false,
  )
  expect(counts.matches([native, path("B", 2, "retainedB", 60)])).toBe(true)
  expect(counts.matches([dogboned, path("B", 2, "retainedB", 60)])).toBe(false)
})

test("known anchors enforce both N0 and N2 without inventing missing counts", () => {
  const counts = checker()
  expect(counts.acceptsKnown("A", 2, new Map([["B", 0]]))).toBe(false)
  expect(counts.acceptsKnown("A", 0, new Map([["B", 2]]))).toBe(false)
  expect(counts.acceptsKnown("A", 2, new Map([["B", 2]]))).toBe(true)
  expect(counts.acceptsKnown("A", 0, new Map())).toBe(true)
})

test("duplicate fixed identities and repeated or overlapping Via records reject", () => {
  const value = input(),
    fixed = path("A", 1, "fixedA", 10)
  value.traces = [fixed, { ...path("A", 1, "fixedA", 20) }]
  expect(() => checker(value)).toThrow("duplicate trace fragment")
  value.traces = [
    fixed,
    { ...structuredClone(fixed), pcb_trace_id: "other-id" },
  ]
  expect(() => checker(value)).toThrow("overlapping via fragments")
  value.traces = [fixed]
  expect(() => checker(value).total("A", [structuredClone(fixed)])).toThrow(
    "duplicate trace fragment",
  )
  const repeated = path("A", 1)
  repeated.route.splice(4, 0, barrel(1), wire(1, "bottom"))
  expect(() => countRouteViaTransitions(repeated, input())).toThrow(
    "repeated via record",
  )
})

test("ambiguous positive-length wire overlap between attached fragments rejects", () => {
  const value = input()
  value.traces = [path("A", 0, "fixed-wire")]
  const owned = path("A", 0, "duplicate-wire-other-id")
  expect(() => checker(value).total("A", [owned])).toThrow(
    /overlap|ambiguous|unsupported/i,
  )
})

test("different span metadata cannot disguise a repeated physical barrel", () => {
  const value = input()
  const left: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "left",
    connection_name: "A",
    route: [
      wire(-1),
      wire(0),
      { ...barrel(0), layers: undefined },
      wire(0, "bottom"),
      wire(-1, "bottom"),
    ],
  }
  const right: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "right",
    connection_name: "A",
    route: [wire(1), wire(0), barrel(0), wire(0, "bottom"), wire(1, "bottom")],
  }
  value.traces = [left]
  expect(() => checker(value).total("A", [right])).toThrow(
    /overlap|ambiguous|unsupported/i,
  )
})

test("incomplete via fragments and malformed transition records do not count as zero", () => {
  const incomplete = path("A", 1)
  incomplete.route.pop()
  incomplete.route.pop()
  expect(() => countRouteViaTransitions(incomplete, input())).toThrow(
    "incomplete via fragment",
  )
  for (const changed of [
    { from_layer: "top", to_layer: "top" },
    { x: NaN },
    { layers: ["top"] },
    { layers: ["top", "bottom", "bottom"] },
  ]) {
    const malformed = path("A", 1)
    malformed.route[2] = { ...malformed.route[2], ...changed } as Via
    expect(() => countRouteViaTransitions(malformed, input())).toThrow(
      "invalid transition record",
    )
  }
  const unknown = path("A", 0)
  unknown.route.splice(1, 0, {
    x: 1,
    y: 0,
    route_type: "arc",
  } as unknown as Via)
  expect(() => countRouteViaTransitions(unknown, input())).toThrow(
    "unknown route primitive",
  )
})

test("unattributed vias reject and groups validate membership", () => {
  const value = input()
  value.traces = [{ ...path("A", 1), connection_name: undefined }]
  expect(() => checker(value)).toThrow("unattributed via fragment")
  const missing = input()
  missing.buses![0].connectionNames = ["A", "missing"]
  expect(() => checker(missing)).toThrow("invalid constraint membership")
  const repeated = input()
  repeated.buses![0].connectionNames = ["A", "A"]
  expect(() => checker(repeated)).toThrow("invalid constraint membership")
})

test("overlapping bus and pair bounds are independent, not cohort equality", () => {
  const value = input(["A", "B", "C"])
  value.differentialPairs = [
    { connectionNames: ["B", "C"], lengthTolerance: 0.127 },
  ]
  const counts = checker(value, 1, 0)
  expect(counts.matches([path("A", 1), path("B", 2), path("C", 2)])).toBe(true)
  expect(counts.matches([path("A", 0), path("B", 2), path("C", 2)])).toBe(false)
  expect(counts.matches([path("A", 1), path("B", 2), path("C", 1)])).toBe(false)
  const pairOnly = createViaCountConstraintChecker(value, {
    maxPairViaCountSkew: 0,
  })!
  expect(pairOnly.compatible("A", 0, "B", 3)).toBe(true)
  expect(pairOnly.compatible("B", 0, "C", 3)).toBe(false)
})

test("matches requires complete constrained members and preserves input fragments", () => {
  const value = input(),
    counts = checker(value)
  const complete = [path("A", 1), path("B", 1)],
    before = structuredClone(complete)
  expect(counts.matches(complete)).toBe(true)
  expect(counts.matches([complete[0]])).toBe(false)
  expect(counts.matches([])).toBe(false)
  expect(complete).toEqual(before)
})

test("inherited and nonenumerable count bounds cannot evade validation", () => {
  for (const field of ["maxBusViaCountSkew", "maxPairViaCountSkew"] as const) {
    for (const value of [Infinity, NaN, -1, 0.5]) {
      const inherited = Object.create({ [field]: value })
      const hidden = Object.defineProperty({}, field, { value })
      expect(() => createViaCountConstraintChecker(input(), inherited)).toThrow(
        "nonnegative integer",
      )
      expect(() => createViaCountConstraintChecker(input(), hidden)).toThrow(
        "nonnegative integer",
      )
    }
  }
  const enabled = Object.defineProperty({}, "maxBusViaCountSkew", { value: 0 })
  expect(createViaCountConstraintChecker(input(), enabled)?.policy).toEqual({
    maxBusViaCountSkew: 0,
  })
})

test("invalid stack and manufacturing context reject enabled accounting", () => {
  for (const patch of [
    { layerCount: 0 },
    { layerCount: 1.5 },
    { layerCount: Infinity },
    { minTraceWidth: 0 },
    { minTraceWidth: NaN },
    { minViaPadDiameter: -1 },
    { minViaHoleDiameter: Infinity },
  ])
    expect(() => checker({ ...input(), ...patch })).toThrow(
      "invalid manufacturing context",
    )
})

test("unknown layers, incomplete spans and invalid manufactured via dimensions reject", () => {
  for (const changed of [
    { to_layer: "banana" },
    { from_layer: "inner9" },
    { layers: ["top", "bottom"] },
    { via_diameter: 0 },
    { via_diameter: -1 },
    { via_diameter: NaN },
    { via_hole_diameter: 0 },
    { via_hole_diameter: Infinity },
    { via_hole_diameter: 0.5 },
  ]) {
    const malformed = path("A", 1)
    malformed.route[2] = { ...malformed.route[2], ...changed } as Via
    expect(() => countRouteViaTransitions(malformed, input())).toThrow(
      "invalid transition record",
    )
  }
  const minimums = {
    ...input(),
    minViaPadDiameter: 0.5,
    minViaHoleDiameter: 0.3,
  }
  expect(() => countRouteViaTransitions(path("A", 1), minimums)).toThrow(
    "invalid transition record",
  )
  const defaulted = path("A", 1)
  defaulted.route[2] = {
    ...defaulted.route[2],
    layers: undefined,
    via_diameter: undefined,
    via_hole_diameter: undefined,
  } as Via
  expect(countRouteViaTransitions(defaulted, minimums)).toBe(1)
})

test("immediate manufactured handoffs require colocated wires on the correct layers", () => {
  for (const [index, changed] of [
    [1, { x: 0.9 }],
    [3, { x: 1.1 }],
    [1, { layer: "bottom" }],
    [3, { layer: "top" }],
    [3, { width: 0.01 }],
    [3, { layer: "banana" }],
    [3, { y: NaN }],
  ] as const) {
    const malformed = path("A", 1)
    malformed.route[index] = { ...malformed.route[index], ...changed } as Wire
    expect(() => countRouteViaTransitions(malformed, input())).toThrow(
      /handoff/,
    )
  }
  const jump = path("A", 0)
  jump.route[1] = { ...jump.route[1], layer: "bottom" } as Wire
  expect(() => countRouteViaTransitions(jump, input())).toThrow(
    "invalid wire handoff",
  )
})

test("unknown completed owners reject rather than hiding additional routed copper", () => {
  const counts = checker()
  const owned = [path("A", 1), path("B", 1)]
  expect(() => counts.matches([...owned, path("wrong-owner", 1)])).toThrow(
    /owner|unknown|unsupported/i,
  )
  const sourceOnly = {
    ...path("A", 1, "unknown-source"),
    connection_name: undefined,
    source_trace_id: "not-declared",
  }
  expect(() => counts.matches([...owned, sourceOnly])).toThrow(
    /owner|unknown|unsupported/i,
  )
})

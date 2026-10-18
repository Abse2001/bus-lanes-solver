import { expect, test } from "bun:test"
import {
  findFixedPathRanges,
  fixedPathPointKey,
} from "../lib/fixed-route-paths"
import type { Trace, Wire } from "../lib/types"

const wire = (x: number, y = 0, layer = "top"): Wire => ({
  route_type: "wire",
  x,
  y,
  width: 0.1,
  layer,
})
const trace = (route: Trace["route"], connection_name = "D0"): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: "route",
  connection_name,
  route,
})

test("point keys ignore object key order and retain every exact field value", () => {
  const a = { ...wire(1, 2), metadata: { second: 2, first: 1 } }
  const b = {
    metadata: { first: 1, second: 2 },
    layer: "top",
    width: 0.1,
    y: 2,
    x: 1,
    route_type: "wire" as const,
  }
  expect(fixedPathPointKey(a)).toBe(fixedPathPointKey(b))
  expect(fixedPathPointKey(a)).not.toBe(
    fixedPathPointKey({ ...a, x: 1 + 1e-12 }),
  )
  const changedMetadata = { ...a, metadata: { second: 3, first: 1 } }
  expect(fixedPathPointKey(a)).not.toBe(fixedPathPointKey(changedMetadata))
})

test("prefix and reversed suffix ranges include their handoff vertices", () => {
  const joined = trace([0, 1, 2, 3, 4, 5, 6].map((x) => wire(x)))
  const prefix = trace(joined.route.slice(0, 3))
  const suffix = trace(joined.route.slice(-3).toReversed())
  const before = structuredClone({ joined, prefix, suffix })
  expect(findFixedPathRanges(joined, [prefix, suffix])).toEqual([
    { start: 0, end: 2 },
    { start: 4, end: 6 },
  ])
  expect({ joined, prefix, suffix }).toEqual(before)
})

test("a tiny coordinate mutation or extra point field rejects a fixed path", () => {
  const joined = trace([wire(0), wire(1), wire(2)])
  const escape = structuredClone(joined)
  escape.route[1].y += 1e-12
  expect(findFixedPathRanges(joined, [escape])).toBeNull()
  const extra = { ...wire(1), pcb_port_id: "changed" }
  expect(
    findFixedPathRanges(joined, [trace([wire(0), extra, wire(2)])]),
  ).toBeNull()
})

test("reversed via paths swap logical directions while retaining all other fields", () => {
  const joined = trace([
    wire(0),
    wire(1),
    {
      route_type: "via",
      x: 1,
      y: 0,
      from_layer: "top",
      to_layer: "bottom",
      layers: ["top", "inner1", "inner2", "bottom"],
      via_diameter: 0.3,
      via_hole_diameter: 0.15,
    },
    wire(1, 0, "bottom"),
    wire(2, 0, "bottom"),
  ])
  const reversed = trace(
    joined.route
      .slice(0, 4)
      .toReversed()
      .map((point) =>
        point.route_type === "via"
          ? { ...point, from_layer: point.to_layer, to_layer: point.from_layer }
          : point,
      ),
  )
  expect(findFixedPathRanges(joined, [reversed])).toEqual([
    { start: 0, end: 3 },
  ])
  const wrongDirection = structuredClone(reversed)
  const via = wrongDirection.route[1]
  if (via.route_type !== "via") throw Error("Expected via")
  via.from_layer = "top"
  expect(findFixedPathRanges(joined, [wrongDirection])).toBeNull()
  via.from_layer = "bottom"
  via.via_diameter = 0.300000000001
  expect(findFixedPathRanges(joined, [wrongDirection])).toBeNull()
})

test("curve chord permissions map exactly in both orientations", () => {
  const joined = {
    ...trace([0, 1, 2, 3, 4].map((x) => wire(x))),
    curvedSegments: [1, 4],
  }
  const prefix = { ...trace(joined.route.slice(0, 3)), curvedSegments: [1] }
  const suffix = {
    ...trace(joined.route.slice(-3).toReversed()),
    curvedSegments: [1],
  }
  expect(findFixedPathRanges(joined, [prefix, suffix])).toEqual([
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ])
  expect(
    findFixedPathRanges({ ...joined, curvedSegments: [1, 2, 4] }, [
      prefix,
      suffix,
    ]),
  ).toBeNull()
  expect(
    findFixedPathRanges({ ...joined, curvedSegments: [1] }, [prefix, suffix]),
  ).toBeNull()
})

test("other owners are ignored but every same-owner path must be present", () => {
  const joined = trace([wire(0), wire(1), wire(2)])
  const foreign = trace([wire(100), wire(101)], "D1")
  expect(findFixedPathRanges(joined, [])).toEqual([])
  expect(findFixedPathRanges(joined, [foreign])).toEqual([])
  expect(
    findFixedPathRanges(joined, [trace([wire(0), wire(1)]), foreign]),
  ).toEqual([{ start: 0, end: 1 }])
  expect(
    findFixedPathRanges(joined, [trace([wire(0), wire(1)]), trace([wire(3)])]),
  ).toBeNull()
})

test("all coincident singleton occurrences protect endpoints inclusively", () => {
  const joined = trace([wire(0), wire(1), wire(2), wire(0)])
  expect(findFixedPathRanges(joined, [trace([wire(0)])])).toEqual([
    { start: 0, end: 0 },
    { start: 3, end: 3 },
  ])
  expect(findFixedPathRanges(joined, [trace([])])).toBeNull()
})

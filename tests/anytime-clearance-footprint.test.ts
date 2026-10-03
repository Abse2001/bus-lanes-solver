import { expect, test } from "bun:test"
import { anytimeClearanceFootprint } from "../lib/anytime-clearance-footprint"
import { foldedTuningLobes } from "../lib/folded-tuning"
import { length, pointSegmentDistance } from "../lib/geometry"
import { roundedTuningLobes } from "../lib/smooth-tuning"
import type { Point, SimpleRouteJson, Trace } from "../lib/types"

const trace = (points: Point[], layer = "top"): Trace => ({
  type: "pcb_trace",
  pcb_trace_id: "test",
  route: points.map((p) => ({ ...p, route_type: "wire", layer, width: 0.1 })),
})
const board = (): SimpleRouteJson => ({
  layerCount: 2,
  minTraceWidth: 0.1,
  bounds: { minX: -4, maxX: 4, minY: -4, maxY: 4 },
  obstacles: [],
  connections: [],
})

test("scanline capsules agree with independent cell-center distance queries in every direction", () => {
  const input = board(),
    pitch = 0.1
  const radius = 0.05 + 0.075 + 0.05 + pitch * Math.SQRT1_2
  const vectors: [Point, Point][] = [
    [
      { x: -2, y: -1 },
      { x: 2, y: 2 },
    ],
    [
      { x: 2, y: -1 },
      { x: -1, y: 2 },
    ],
    [
      { x: 0, y: -2 },
      { x: 0, y: 2 },
    ],
    [
      { x: -2, y: 0 },
      { x: 2, y: 0 },
    ],
    [
      { x: 0.012, y: 0.047 },
      { x: 0.012, y: 0.047 },
    ],
  ]
  for (const [a, b] of vectors) {
    let expected = 0
    for (let row = 0; row < 80; row++)
      for (let column = 0; column < 80; column++) {
        const point = {
          x: -4 + (column + 0.5) * pitch,
          y: -4 + (row + 0.5) * pitch,
        }
        if (pointSegmentDistance(point, [a, b]) <= radius) expected++
      }
    const result = anytimeClearanceFootprint(input, [trace([a, b])])
    expect(result.pitchMm).toBe(pitch)
    expect(result.areaMm2).toBeCloseTo(expected * pitch * pitch, 10)
    expect(anytimeClearanceFootprint(input, [trace([b, a])])).toEqual(result)
  }
})

test("generated overlap counts once per layer and immutable native copper is subtracted", () => {
  const input = board(),
    a = trace([
      { x: -2, y: 0 },
      { x: 2, y: 0 },
    ])
  const single = anytimeClearanceFootprint(input, [a])
  expect(anytimeClearanceFootprint(input, [a, structuredClone(a)])).toEqual(
    single,
  )
  const bothLayers = anytimeClearanceFootprint(input, [
    a,
    trace(
      [
        { x: -2, y: 0 },
        { x: 2, y: 0 },
      ],
      "bottom",
    ),
  ])
  expect(bothLayers.areaMm2).toBeCloseTo(single.areaMm2 * 2, 10)
  expect(bothLayers.meanLayerAreaMm2).toBeCloseTo(single.areaMm2, 10)
  const fixedInput = { ...input, traces: [a] }
  expect(
    anytimeClearanceFootprint(fixedInput, [structuredClone(a)]).areaMm2,
  ).toBe(0)
  const padInput = {
    ...input,
    obstacles: [
      {
        center: { x: 0, y: 0 },
        width: 6,
        height: 2,
        layers: ["top"],
        connectedTo: [],
      },
    ],
  }
  expect(anytimeClearanceFootprint(padInput, [a]).areaMm2).toBe(0)
})

test("dense folds reduce actual exclusion union with equal length and unchanged outer envelopes", () => {
  const a = { x: 0, y: 0 },
    b = { x: 10, y: 0 }
  const separated = roundedTuningLobes(a, b, 12, 2, 1, 0.12)!
  const folded = foldedTuningLobes(a, b, 12, 3, 1, 0.12)!
  expect(separated).not.toBeNull()
  expect(folded).not.toBeNull()
  expect(length(separated)).toBeCloseTo(length(folded), 8)
  const height =
    Math.max(...separated.map((p) => p.y), ...folded.map((p) => p.y)) + 1
  const boundaries = [-1, 11].map((x) =>
    trace([
      { x, y: -1 },
      { x, y: height },
    ]),
  )
  const input = {
    ...board(),
    bounds: { minX: -2, maxX: 12, minY: -2, maxY: height + 1 },
  }
  const loose = anytimeClearanceFootprint(input, [
    ...boundaries,
    trace(separated),
  ])
  const dense = anytimeClearanceFootprint(input, [...boundaries, trace(folded)])
  expect(dense.areaMm2).toBeLessThan(loose.areaMm2 - 1)
  const annotated = {
    ...trace(folded),
    curvedSegments: folded.slice(1).map((_, i) => i + 1),
  }
  expect(anytimeClearanceFootprint(input, [...boundaries, annotated])).toEqual(
    dense,
  )
  const before = structuredClone({ input, traces: [...boundaries, annotated] })
  anytimeClearanceFootprint(input, [...boundaries, annotated])
  expect({ input, traces: [...boundaries, annotated] }).toEqual(before)
})

test("through-via pads occupy every intervening physical layer with native diameter fallback", () => {
  const input = { ...board(), layerCount: 4, minViaPadDiameter: 0.4 }
  const via: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "via",
    route: [
      { route_type: "via", x: 0, y: 0, from_layer: "top", to_layer: "bottom" },
    ],
  }
  const topOnly = {
    ...via,
    route: [{ ...via.route[0], to_layer: "top" }],
  } as Trace
  const one = anytimeClearanceFootprint(input, [topOnly])
  const all = anytimeClearanceFootprint(input, [via])
  expect(all.areaMm2).toBeCloseTo(one.areaMm2 * 4, 10)
  expect(all.meanLayerAreaMm2).toBeCloseTo(one.areaMm2, 10)
})

test("rectangular board-edge domain is subtracted and oversized grids adapt deterministically", () => {
  const input = { ...board(), minBoardEdgeClearance: 1 }
  const edge = trace([
    { x: -2, y: -3.5 },
    { x: 2, y: -3.5 },
  ])
  expect(anytimeClearanceFootprint(input, [edge]).areaMm2).toBe(0)
  expect(anytimeClearanceFootprint(board(), [edge]).areaMm2).toBeGreaterThan(0)
  const large = {
    ...board(),
    bounds: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
  }
  const result = anytimeClearanceFootprint(large, [])
  expect(result.pitchMm).toBeGreaterThan(0.1)
  expect(Math.ceil(1000 / result.pitchMm) ** 2).toBeLessThanOrEqual(1_000_000)
  expect(anytimeClearanceFootprint(large, [])).toEqual(result)
})

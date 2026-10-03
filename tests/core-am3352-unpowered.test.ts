import { expect, test } from "bun:test"
import {
  BusLanesPipelineSolver,
  type SimpleRouteJson,
  type Trace,
  type Wire,
} from "../lib"
import { distance, pointSegmentDistanceToPoints } from "../lib/geometry"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import fixture from "./fixtures/am3352-ram/native-input.json"

const planarLength = (trace: Trace) =>
  trace.route.slice(1).reduce((sum, point, index) => {
    const previous = trace.route[index]
    return (
      sum +
      (point.route_type === "wire" &&
      previous.route_type === "wire" &&
      point.layer === previous.layer
        ? distance(previous, point)
        : 0)
    )
  }, 0)

// The core reference audits the shared carrier after each 6.2 mm terminal
// approach, independently of the solver's coupledSection annotations.
const carrier = (trace: Trace) => {
  const vias = trace.route.flatMap((point, index) =>
    point.route_type === "via" ? [index] : [],
  )
  expect(vias).toHaveLength(2)
  return trace.route.slice(vias[0] + 1, vias[1]) as Wire[]
}
const interiorGaps = (first: Trace, second: Trace) => {
  const paths = [carrier(first), carrier(second)]
  let minimum = Infinity,
    maximum = -Infinity
  for (const side of [0, 1]) {
    const path = paths[side],
      mate = paths[1 - side]
    expect(path[0].layer).toBe(mate[0].layer)
    const total = path
      .slice(1)
      .reduce((sum, point, index) => sum + distance(path[index], point), 0)
    let traveled = 0
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1],
        b = path[index],
        span = distance(a, b)
      const steps = Math.max(1, Math.ceil(span / 0.01))
      for (let sample = 0; sample < steps; sample++) {
        const at = traveled + (span * sample) / steps
        if (at < 6.2 || at > total - 6.2) continue
        const point = {
          x: a.x + ((b.x - a.x) * sample) / steps,
          y: a.y + ((b.y - a.y) * sample) / steps,
        }
        const gap =
          Math.min(
            ...mate
              .slice(1)
              .map((end, index) =>
                pointSegmentDistanceToPoints(point, mate[index], end),
              ),
          ) -
          (a.width + mate[0].width) / 2
        minimum = Math.min(minimum, gap)
        maximum = Math.max(maximum, gap)
      }
      traveled += span
    }
  }
  return { minimum, maximum }
}

test("the original core AM3352 phase keeps compact, coupled routes without supplied power fanouts", () => {
  const input = structuredClone(fixture) as unknown as SimpleRouteJson
  const before = structuredClone(input),
    solver = new BusLanesPipelineSolver(input)
  solver.solve()
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toHaveLength(47)
  expect(input).toEqual(before)
  expect(routeAnglesAreConventional(solver.traces)).toBe(true)
  expect(
    busLengthReports(input, solver.traces).every((report) => report.matched),
  ).toBe(true)
  expect(
    pairLengthReports(input, solver.traces).every((report) => report.matched),
  ).toBe(true)
  const lengths = solver.traces.map(planarLength)
  expect(lengths.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(
    1550,
  )
  const detours = solver.traces.map(
    (trace, index) =>
      lengths[index] / distance(trace.route[0], trace.route.at(-1)!),
  )
  expect(Math.max(...detours)).toBeLessThanOrEqual(2.05)
  expect(
    detours.reduce((sum, value) => sum + value, 0) / detours.length,
  ).toBeLessThanOrEqual(1.55)
  for (const pair of input.differentialPairs!) {
    const rails = pair.connectionNames.map(
      (name) => solver.traces.find((trace) => trace.connection_name === name)!,
    )
    const gaps = interiorGaps(rails[0], rails[1])
    expect(gaps.minimum).toBeGreaterThanOrEqual(0.0999)
    expect(gaps.maximum).toBeLessThanOrEqual(0.155)
  }
}, 120_000)

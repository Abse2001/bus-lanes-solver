import { distance } from "./geometry"
import type { SimpleRouteJson, Trace, Wire } from "./types"

function alignStarts(traces: Trace[]): Trace[] {
  if (traces.some((trace) => !trace.coupledSection)) return traces
  const starts = traces.map((trace) => trace.coupledSection![0])
  const points = traces.map(
    (trace, side) => trace.route[starts[side]],
  ) as Wire[]
  const next = traces.map(
    (trace, side) => trace.route[starts[side] + 1],
  ) as Wire[]
  if (
    points.some((point) => point?.route_type !== "wire") ||
    next.some((point) => point?.route_type !== "wire") ||
    points.some((point) => point.layer !== points[0].layer) ||
    next.some((point) => point.layer !== points[0].layer) ||
    traces.some((trace, side) =>
      trace.curvedSegments?.includes(starts[side] + 1),
    )
  )
    return traces
  const runs = points.map((point, side) => {
    const span = distance(point, next[side])
    return {
      span,
      x: (next[side].x - point.x) / span,
      y: (next[side].y - point.y) / span,
    }
  })
  if (runs.some((run) => run.span < 1e-8) || distance(runs[0], runs[1]) > 1e-7)
    return traces
  const direction = runs[0]
  const project = (point: (typeof points)[number]) =>
    point.x * direction.x + point.y * direction.y
  const common = Math.max(...points.map(project))
  // Only trim a straight boundary leg. Moving past its next corner would need
  // actual paired-corridor geometry, rather than a metadata adjustment.
  if (
    points.some(
      (point, side) => common - project(point) > runs[side].span + 1e-8,
    )
  )
    return traces
  return traces.map((trace, side): Trace => {
    const index = starts[side]
    const advance = common - project(points[side])
    if (advance < 1e-8) return trace
    if (Math.abs(advance - runs[side].span) < 1e-8) {
      if (index + 1 >= trace.coupledSection![1]) return trace
      return { ...trace, coupledSection: [index + 1, trace.coupledSection![1]] }
    }
    const point = {
      ...points[side],
      x: points[side].x + direction.x * advance,
      y: points[side].y + direction.y * advance,
    }
    return {
      ...trace,
      route: [
        ...trace.route.slice(0, index + 1),
        point,
        ...trace.route.slice(index + 1),
      ],
      coupledSection: [index + 1, trace.coupledSection![1] + 1],
      curvedSegments: trace.curvedSegments?.map((curve) =>
        curve > index ? curve + 1 : curve,
      ),
    }
  })
}

function reverse(trace: Trace): Trace {
  const count = trace.route.length
  return {
    ...trace,
    route: trace.route.toReversed(),
    coupledSection: trace.coupledSection && [
      count - 1 - trace.coupledSection[1],
      count - 1 - trace.coupledSection[0],
    ],
    curvedSegments: trace.curvedSegments
      ?.map((curve) => count - curve)
      .sort((a, b) => a - b),
  }
}

/** Restrict shared-section labels to the common straight boundary intervals
 * after a handoff bevel. Collinear splits preserve all copper, lengths, layers,
 * endpoints and curve chords; every corner remains subject to the angle audit. */
export function alignCoupledSectionBoundaries(
  input: SimpleRouteJson,
  traces: Trace[],
): Trace[] {
  const result = [...traces]
  for (const pair of input.differentialPairs ?? []) {
    const indices = pair.connectionNames.map((name) =>
      result.findIndex((trace) => trace.connection_name === name),
    )
    const rails = indices.map((index) => result[index])
    if (rails.some((trace) => !trace?.coupledSection)) continue
    const aligned = alignStarts(alignStarts(rails).map(reverse)).map(reverse)
    indices.forEach((index, side) => {
      result[index] = aligned[side]
    })
  }
  return result
}

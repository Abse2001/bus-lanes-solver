import { distance } from "./geometry"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Work on the longest continuous carrier run of each completed connection.
 * The surrounding local escapes, including every via, become fixed copper.
 * Reassembly preserves route indices and annotations because compaction only
 * translates vertices; it never inserts or removes them. */
export function carrierCompactionView(input: SimpleRouteJson, traces: Trace[]) {
  const runs = traces.map((trace) => {
    let best = { start: 0, end: 0, length: 0 }
    let start = 0,
      span = 0
    for (let i = 1; i < trace.route.length; i++) {
      const a = trace.route[i - 1],
        b = trace.route[i]
      if (
        a.route_type !== "wire" ||
        b.route_type !== "wire" ||
        a.layer !== b.layer
      ) {
        start = i
        span = 0
        continue
      }
      span += distance(a, b)
      if (span > best.length) best = { start, end: i, length: span }
    }
    return best
  })
  if (runs.some((run) => run.end <= run.start)) return null
  const carriers = traces.map((trace, i) => {
    const { start, end } = runs[i]
    return {
      ...trace,
      route: trace.route.slice(start, end + 1),
      curvedSegments: trace.curvedSegments
        ?.filter((k) => k > start && k <= end)
        .map((k) => k - start),
      coupledSection: trace.coupledSection?.map((k) => k - start) as
        | [number, number]
        | undefined,
    }
  })
  const byName = new Map(
    carriers.map((trace) => [trace.connection_name, trace]),
  )
  if (input.connections.some((c) => !byName.has(c.name))) return null
  const local: SimpleRouteJson = {
    ...input,
    connections: input.connections.map((c) => {
      const carrier = byName.get(c.name)!
      return {
        ...c,
        pointsToConnect: [
          carrier.route[0] as Wire,
          carrier.route.at(-1)! as Wire,
        ],
      }
    }),
    traces: [
      ...(input.traces ?? []),
      ...traces.flatMap((trace, i) => {
        const { start, end } = runs[i]
        return [
          ...(start
            ? [{ ...trace, route: trace.route.slice(0, start + 1) }]
            : []),
          ...(end < trace.route.length - 1
            ? [{ ...trace, route: trace.route.slice(end) }]
            : []),
        ]
      }),
    ],
  }
  return {
    input: local,
    carriers,
    join: (result: Trace[]) =>
      traces.map((trace, i) => ({
        ...trace,
        route: [
          ...trace.route.slice(0, runs[i].start),
          ...result[i].route,
          ...trace.route.slice(runs[i].end + 1),
        ],
      })),
  }
}

export function signalEnvelope(traces: Trace[]) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  for (const trace of traces)
    for (const p of trace.route) {
      const radius =
        p.route_type === "wire" ? p.width / 2 : (p.via_diameter ?? 0.3) / 2
      minX = Math.min(minX, p.x - radius)
      maxX = Math.max(maxX, p.x + radius)
      minY = Math.min(minY, p.y - radius)
      maxY = Math.max(maxY, p.y + radius)
    }
  return {
    minX,
    maxX,
    minY,
    maxY,
    areaMm2: traces.length ? (maxX - minX) * (maxY - minY) : 0,
  }
}

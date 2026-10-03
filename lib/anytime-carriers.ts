import { length } from "./geometry"
import { isUnroutedComponentPad } from "./is-unrouted-component-pad"
import type { SimpleRouteJson, Trace, Wire } from "./types"

type CarrierRange = { start: number; end: number }

function carrierRange(input: SimpleRouteJson, trace: Trace): CarrierRange {
  const runs: CarrierRange[] = []
  for (let i = 0; i < trace.route.length; i++) {
    const first = trace.route[i]
    if (first.route_type !== "wire") continue
    const start = i
    while (i + 1 < trace.route.length) {
      const next = trace.route[i + 1]
      if (
        next.route_type !== "wire" ||
        next.layer !== first.layer ||
        next.width !== first.width
      )
        break
      i++
    }
    if (i > start) runs.push({ start, end: i })
  }
  if (!runs.length)
    throw Error("A validated route must have a contiguous wire carrier")
  const vias = trace.route.flatMap((p, i) =>
    p.route_type === "via" ? [i] : [],
  )
  // The normal two-ended dogbone places its entire carrier between its vias.
  if (vias.length === 2) {
    const middle = runs.find(
      (r) => r.start === vias[0] + 1 && r.end === vias[1] - 1,
    )
    if (middle) return middle
  }
  const connection = input.connections.find(
    (c) => c.name === trace.connection_name,
  )
  if (vias.length === 1 && connection) {
    const padEnds = connection.pointsToConnect.map((p) =>
      isUnroutedComponentPad(input, connection, p),
    )
    // A supplied handoff may share a lane with just one new pad escape. Keep
    // that escape fixed even when it is longer than the interconnect itself.
    if (padEnds[0] !== padEnds[1]) {
      const carrier = runs.find((r) =>
        padEnds[0] ? r.end === trace.route.length - 1 : r.start === 0,
      )
      if (carrier) return carrier
    }
  }
  const bus = input.buses?.find((b) =>
    b.connectionNames.includes(trace.connection_name!),
  )
  const allowed = runs.filter((r) => {
    const layer = (trace.route[r.start] as Wire).layer
    return (
      (!input.allowedLayers || input.allowedLayers.includes(layer)) &&
      (!bus?.allowedLayers || bus.allowedLayers.includes(layer))
    )
  })
  const applicable = allowed.length ? allowed : runs
  return applicable.reduce((best, next) =>
    length(trace.route.slice(next.start, next.end + 1)) >
    length(trace.route.slice(best.start, best.end + 1))
      ? next
      : best,
  )
}

/** Keep local signal escapes immutable during optimization, just like supplied
 * power fanouts. The strict lane validator operates on the fixed carrier layer. */
export function separateAnytimeCarriers(
  input: SimpleRouteJson,
  traces: Trace[],
) {
  const ranges = traces.map((t) => carrierRange(input, t))
  const escapes: Trace[] = []
  const carriers = traces.map((t, i) => {
    const { start, end } = ranges[i]
    if (start > 0)
      escapes.push({
        ...t,
        pcb_trace_id: `${t.pcb_trace_id}_fixed_prefix`,
        route: t.route.slice(0, start + 1),
        curvedSegments: t.curvedSegments?.filter((k) => k <= start),
        coupledSection: undefined,
      })
    if (end < t.route.length - 1)
      escapes.push({
        ...t,
        pcb_trace_id: `${t.pcb_trace_id}_fixed_suffix`,
        route: t.route.slice(end),
        curvedSegments: t.curvedSegments
          ?.filter((k) => k > end)
          .map((k) => k - end),
        coupledSection: undefined,
      })
    return {
      ...t,
      route: t.route.slice(start, end + 1),
      curvedSegments: t.curvedSegments
        ?.filter((k) => k > start && k <= end)
        .map((k) => k - start),
      coupledSection: t.coupledSection
        ? ([t.coupledSection[0] - start, t.coupledSection[1] - start] as [
            number,
            number,
          ])
        : undefined,
    }
  })
  const carrierInput: SimpleRouteJson = {
    ...input,
    traces: [...(input.traces ?? []), ...escapes],
    connections: input.connections.map((c) => {
      const t = carriers.find((t) => t.connection_name === c.name)!
      return {
        ...c,
        pointsToConnect: [t.route[0], t.route.at(-1)!].map((p) => ({
          x: p.x,
          y: p.y,
          layer: (p as Wire).layer,
        })),
      }
    }),
  }
  return {
    input: carrierInput,
    traces: carriers,
    compose: (candidate: Trace[]): Trace[] =>
      candidate.map((t) => {
        const index = traces.findIndex(
          (old) => old.connection_name === t.connection_name,
        )
        const old = traces[index],
          { start, end } = ranges[index]
        const delta = t.route.length - (end - start + 1)
        const curvedSegments =
          old.curvedSegments || t.curvedSegments
            ? [
                ...(old.curvedSegments ?? []).filter((k) => k <= start),
                ...(t.curvedSegments ?? []).map((k) => k + start),
                ...(old.curvedSegments ?? [])
                  .filter((k) => k > end)
                  .map((k) => k + delta),
              ].sort((a, b) => a - b)
            : undefined
        return {
          ...t,
          route: [
            ...old.route.slice(0, start),
            ...t.route,
            ...old.route.slice(end + 1),
          ],
          curvedSegments,
          coupledSection: t.coupledSection?.map((k) => k + start) as
            | [number, number]
            | undefined,
        }
      }),
  }
}

import { bevelCoupledCorners } from "./bevel-coupled-corners"
import { roundCoupledReturnBends } from "./round-coupled-return-bends"
import { ejectBlockingLanes } from "./eject-blocking-lanes"
import { repairGridJogs } from "./repair-grid-jogs"
import { reduceOrdinaryTurns } from "./reduce-ordinary-turns"
import { tuningPathIsSelfClear } from "./length-tuning"
import { length } from "./geometry"
import { fixedRouteLength } from "./route-lengths"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import type { PairedNetwork } from "./paired-network"
import type { Trace, Wire } from "./types"

/** Repair package approaches, then restore any original matched approach that
 * reduces skew. Unrelated movable lanes are displaced around the final pair. */
export function* finishPairedNetwork(
  network: PairedNetwork,
  raw: Trace[],
): Generator<void, Trace[] | null> {
  const { input, layers, transforms } = network,
    fixed = fixedCopper(input)
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const traces = structuredClone(raw),
    rejected = new Set<Trace>()
  const widths = new Map(
    input.connections.map((c) => [
      c.name,
      input.buses?.find((b) => b.connectionNames.includes(c.name))
        ?.traceWidth ??
        c.nominalTraceWidth ??
        c.width ??
        input.minTraceWidth,
    ]),
  )
  for (const trace of traces) {
    if (trace.coupledSection) continue
    const repaired = yield* repairGridJogs(
      input,
      [trace],
      [...fixed, ...traces.filter((t) => t !== trace).flatMap(routeCopper)],
    )
    if (!repaired) rejected.add(trace)
  }
  for (const trace of traces) {
    if (!trace.coupledSection) continue
    for (const end of [0, 1]) {
      const [s, e]: [number, number] = trace.coupledSection
      const path: Trace["route"] = end
        ? trace.route.slice(e)
        : trace.route.slice(0, s + 1)
      const rest: Trace["route"] = end
        ? trace.route.slice(0, e)
        : trace.route.slice(s + 1)
      const part: Trace = {
        ...trace,
        coupledSection: undefined,
        curvedSegments: undefined,
        route: path,
      }
      const connection = {
        ...input.connections.find((c) => c.name === trace.connection_name)!,
        pointsToConnect: [path[0], path.at(-1)!] as Wire[],
      }
      const partInput = { ...input, connections: [connection] }
      const copper = [
        ...fixed,
        ...traces.filter((t) => t !== trace).flatMap(routeCopper),
        ...routeCopper({
          ...trace,
          connection_name: "reserved_other_approach",
          source_trace_id: undefined,
          route: rest,
        }),
      ]
      const repaired = yield* repairGridJogs(partInput, [part], copper)
      if (repaired) {
        if (part.route !== path) {
          const delta = part.route.length - path.length
          trace.curvedSegments = trace.curvedSegments?.flatMap((k) =>
            end ? (k <= e ? [k] : []) : k > s ? [k + delta] : [],
          )
        }
        trace.route = end
          ? [...trace.route.slice(0, e), ...part.route]
          : [...part.route, ...trace.route.slice(s + 1)]
        if (!end)
          trace.coupledSection = [
            part.route.length - 1,
            e + part.route.length - path.length,
          ]
      }
    }
    const [s, e] = trace.coupledSection,
      width = (trace.route[0] as Wire).width
    const scene = new VectorScene(
      input,
      input.connections.find((c) => c.name === trace.connection_name)!,
      width,
      [...fixed, ...traces.flatMap(routeCopper)],
    )
    const prefix = trace.curvedSegments?.some((k) => k <= s)
      ? trace.route.slice(0, s + 1)
      : reduceOrdinaryTurns(trace.route.slice(0, s + 1), scene)
    const suffix = trace.curvedSegments?.some((k) => k > e)
      ? trace.route.slice(e)
      : reduceOrdinaryTurns(trace.route.slice(e), scene)
    trace.curvedSegments = trace.curvedSegments?.map((k) =>
      k > s ? k + prefix.length - (s + 1) : k,
    )
    trace.route = [
      ...prefix.slice(0, -1),
      ...trace.route.slice(s, e + 1),
      ...suffix.slice(1),
    ].map((p) => ({
      ...p,
      route_type: "wire",
      width,
      layer: (trace.route[0] as Wire).layer,
    }))
    trace.coupledSection = [prefix.length - 1, prefix.length + e - s - 1]
  }
  const firstRepair: Trace[] | null = yield* ejectBlockingLanes(
    input,
    traces.filter((t) => !rejected.has(t)),
    fixed,
    widths,
    layers,
    { requireSelfClear: true, maxSearches: 1000 },
  )
  if (!firstRepair) return null
  let repaired: Trace[] = roundCoupledReturnBends(
    input,
    bevelCoupledCorners(input, firstRepair),
    fixed,
  )
  const total = (t: Trace) =>
    length(t.route) + fixedRouteLength(input, t.connection_name!)
  for (const transform of transforms) {
    const rails = transform.pair.connectionNames.map(
      (n) => repaired!.find((t) => t.connection_name === n)!,
    )
    const restored = rails.map((t) => {
      const old = transform.rails.find(
          (r) => r.connection_name === t.connection_name,
        )!,
        [s, e] = old.coupledSection!,
        [a, b] = t.coupledSection!
      const mid = t.route.slice(a, b + 1),
        delta = mid.length - (e - s + 1)
      return {
        ...t,
        route: [...old.route.slice(0, s), ...mid, ...old.route.slice(e + 1)],
        coupledSection: [s, s + mid.length - 1] as [number, number],
        curvedSegments: [
          ...(old.curvedSegments ?? []).flatMap((k) =>
            k <= s ? [k] : k > e ? [k + delta] : [],
          ),
          ...(t.curvedSegments ?? [])
            .filter((k) => k > a && k <= b)
            .map((k) => k + s - a),
        ],
      }
    })
    if (
      Math.abs(total(restored[0]) - total(restored[1])) >=
      Math.abs(total(rails[0]) - total(rails[1])) - 1e-8
    )
      continue
    const immutable = [
      ...fixed,
      ...repaired
        .filter((t) => t.coupledSection && !rails.includes(t))
        .flatMap(routeCopper),
      ...restored.flatMap(routeCopper),
    ]
    if (
      restored.some(
        (t) =>
          !tuningPathIsSelfClear(
            t.route,
            (t.route[0] as Wire).width + clearance,
          ) ||
          !new VectorScene(
            input,
            input.connections.find((c) => c.name === t.connection_name)!,
            (t.route[0] as Wire).width,
            immutable,
          ).pathVisible(t.route),
      )
    )
      continue
    const candidate: Trace[] = repaired.map(
      (t) => restored.find((r) => r.connection_name === t.connection_name) ?? t,
    )
    const retained: Trace[] = candidate.filter(
      (t) =>
        t.coupledSection ||
        restored.every((r) =>
          new VectorScene(
            input,
            input.connections.find((c) => c.name === r.connection_name)!,
            (r.route[0] as Wire).width,
            routeCopper(t),
          ).pathVisible(r.route),
        ),
    )
    const repairedCandidate: Trace[] | null = yield* ejectBlockingLanes(
      input,
      retained,
      fixed,
      widths,
      layers,
      { requireSelfClear: true, maxSearches: 200 },
    )
    if (repairedCandidate) repaired = repairedCandidate
  }
  const rails = repaired.filter((t) => t.coupledSection)
  const retained = repaired.filter(
    (t) =>
      t.coupledSection ||
      rails.every((r) =>
        new VectorScene(
          input,
          input.connections.find((c) => c.name === r.connection_name)!,
          (r.route[0] as Wire).width,
          routeCopper(t),
        ).pathVisible(r.route),
      ),
  )
  const firstComplete: Trace[] | null = yield* ejectBlockingLanes(
    input,
    retained,
    fixed,
    widths,
    layers,
    { requireSelfClear: true, maxSearches: 1000 },
  )
  if (!firstComplete) return null
  let complete: Trace[] = firstComplete
  for (const transform of transforms.filter((t) => !t.approaches.length)) {
    const restored: Trace[] = complete.map(
      (t) =>
        transform.rails.find((r) => r.connection_name === t.connection_name) ??
        t,
    )
    const retained: Trace[] = restored.filter(
      (t) =>
        t.coupledSection ||
        transform.rails.every((r) =>
          new VectorScene(
            input,
            input.connections.find((c) => c.name === r.connection_name)!,
            (r.route[0] as Wire).width,
            routeCopper(t),
          ).pathVisible(r.route),
        ),
    )
    const nextComplete: Trace[] | null = yield* ejectBlockingLanes(
      input,
      retained,
      fixed,
      widths,
      layers,
      { requireSelfClear: true, maxSearches: 1000 },
    )
    if (!nextComplete) return null
    complete = nextComplete
  }
  for (const c of input.connections)
    for (const p of c.pointsToConnect)
      p.layer = (
        complete.find((t) => t.connection_name === c.name)!.route[0] as Wire
      ).layer
  return complete
}

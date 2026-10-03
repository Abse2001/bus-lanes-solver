import { chamferOrdinaryCorners } from "./chamfer-ordinary-corners"
import { offsetPath } from "./coupled-pair-routing"
import { distance, length, simplify } from "./geometry"
import { GridVisibilitySearch } from "./grid-visibility"
import { tuningPathIsSelfClear } from "./length-tuning"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { sharedPairSpacingReports } from "./shared-pair-spacing"
import { connectors } from "./vector-visibility"
import {
  fixedCopper,
  routeCopper,
  VectorScene,
  type Copper,
} from "./vector-scene"
import type { Connection, Point, SimpleRouteJson, Trace, Wire } from "./types"

export interface PairTopologyOptions {
  /** Yielded work chunks across all pair searches, including rejected trials. */
  maxCandidates?: number
  maxShortcutWindows?: number
  maxGridWindows?: number
  maxSearchExpansions?: number
  searchStepsPerYield?: number
  gridSteps?: number[]
  /** Skip still-dense sampled banks until the caller strips them. */
  maxCenterlineVertices?: number
  validateSelfClear?: boolean
}

interface PairModel {
  pair: NonNullable<SimpleRouteJson["differentialPairs"]>[number]
  indices: number[]
  rails: Trace[]
  center: Point[]
  offsets: number[]
  width: number
  envelope: number
  virtual: Connection
  background: Copper[]
  scene: VectorScene
}

function modelFor(
  input: SimpleRouteJson,
  traces: Trace[],
  pair: PairModel["pair"],
  fixed: Copper[],
  maxCenterlineVertices: number,
): PairModel | null {
  const indices = pair.connectionNames.map((name) =>
    traces.findIndex((t) => t.connection_name === name),
  )
  if (indices.some((i) => i < 0)) return null
  const rails = indices.map((i) => traces[i])
  if (
    rails.some(
      (t) =>
        !t.coupledSection ||
        !t.coupledSection.every(Number.isInteger) ||
        t.coupledSection[0] < 0 ||
        t.coupledSection[0] >= t.coupledSection[1] ||
        t.coupledSection[1] >= t.route.length ||
        t.route.some((p) => p.route_type !== "wire"),
    )
  )
    return null
  const sections = rails.map(
    (t) =>
      simplify(
        t.route.slice(t.coupledSection![0], t.coupledSection![1] + 1),
      ) as Wire[],
  )
  if (
    sections[0].length < 2 ||
    sections[0].length > maxCenterlineVertices ||
    sections[0].length !== sections[1].length
  )
    return null
  const width = sections[0][0].width,
    layer = sections[0][0].layer
  if (
    sections
      .flat()
      .some((p) => p.layer !== layer || Math.abs(p.width - width) > 1e-8)
  )
    return null
  const gap =
    pair.traceGap ??
    input.minTraceToPadEdgeClearance ??
    input.defaultObstacleMargin ??
    0.075
  const spacing = width + gap,
    envelope = width + spacing
  const center = sections[0].map((p, i) => ({
    x: (p.x + sections[1][i].x) / 2,
    y: (p.y + sections[1][i].y) / 2,
  }))
  if (center.some((p, i) => i > 0 && distance(p, center[i - 1]) < 1e-8))
    return null
  let offsets: number[]
  try {
    offsets = [-spacing / 2, spacing / 2].sort(
      (a, b) =>
        distance(offsetPath(center, a)[0], sections[0][0]) -
        distance(offsetPath(center, b)[0], sections[0][0]),
    )
    if (
      rails.some((_, k) => {
        const points = offsetPath(center, offsets[k])
        return (
          distance(points[0], sections[k][0]) > 1e-7 ||
          distance(points.at(-1)!, sections[k].at(-1)!) > 1e-7
        )
      })
    )
      return null
  } catch {
    return null
  }
  const owners = pair.connectionNames.map((name) =>
    input.connections.find((c) => c.name === name),
  )
  const aliases = [
    ...new Set(
      owners
        .flatMap((c) => [
          c?.name,
          c?.source_trace_id,
          ...(c?.pointsToConnect.flatMap((p) => [p.pointId, p.pcb_port_id]) ??
            []),
        ])
        .filter((alias): alias is string => Boolean(alias)),
    ),
  ]
  // The wide scene excludes both rails and both aliases. Actual conductor
  // scenes below restore the other rail as hard copper before accepting a form.
  const virtual: Connection = {
    name: pair.connectionNames[0],
    source_trace_id: pair.connectionNames[1],
    nominalTraceWidth: envelope,
    // Extra coincident terminals carry ownership aliases only; the search's
    // actual source and target are the two explicit centerline handoffs.
    pointsToConnect: [center[0], center.at(-1)!]
      .map((p) => ({ ...p, layer }))
      .concat(
        aliases.flatMap((alias, i) =>
          i % 2 === 0
            ? [
                {
                  ...center[0],
                  layer,
                  pointId: alias,
                  pcb_port_id: aliases[i + 1],
                },
              ]
            : [],
        ),
      ),
  }
  const background = [
    ...fixed,
    ...traces.filter((_, i) => !indices.includes(i)).flatMap(routeCopper),
  ]
  return {
    pair,
    indices,
    rails,
    center,
    offsets,
    width,
    envelope,
    virtual,
    background,
    scene: new VectorScene(input, virtual, envelope, background),
  }
}

function rebuild(
  input: SimpleRouteJson,
  traces: Trace[],
  model: PairModel,
  points: Point[],
  options: PairTopologyOptions,
): Trace[] | undefined {
  const clean = simplify(points)
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  let changed: Trace[]
  try {
    changed = model.rails.map((trace, side): Trace => {
      const [start, end] = trace.coupledSection!,
        a = trace.route[start] as Wire,
        b = trace.route[end] as Wire
      const middle = offsetPath(clean, model.offsets[side])
      if (distance(middle[0], a) > 1e-7 || distance(middle.at(-1)!, b) > 1e-7)
        throw Error("Changed shared handoff")
      const route = middle.map(
        (p, i): Wire =>
          i === 0
            ? { ...a }
            : i === middle.length - 1
              ? { ...b }
              : { ...p, route_type: "wire", layer: a.layer, width: a.width },
      )
      const added = route.length - (end - start + 1)
      return {
        ...trace,
        route: [
          ...trace.route.slice(0, start),
          ...route,
          ...trace.route.slice(end + 1),
        ],
        coupledSection: [start, start + route.length - 1],
        curvedSegments: trace.curvedSegments
          ?.filter((i) => i <= start || i > end)
          .map((i) => (i > end ? i + added : i)),
      }
    })
  } catch {
    return undefined
  }
  if (!routeAnglesAreConventional(changed)) return undefined
  const copper = [...model.background, ...changed.flatMap(routeCopper)]
  if (
    changed.some((t) => {
      const connection = input.connections.find(
        (c) => c.name === t.connection_name,
      )
      return (
        !connection ||
        !new VectorScene(input, connection, model.width, copper).pathVisible(
          t.route,
        ) ||
        (options.validateSelfClear !== false &&
          !tuningPathIsSelfClear(t.route, model.width + clearance))
      )
    })
  )
    return undefined
  if (
    !sharedPairSpacingReports(
      { ...input, differentialPairs: [model.pair] },
      changed,
    ).every((p) => p.matched)
  )
    return undefined
  if (
    changed.every(
      (t, k) =>
        t.route.length === model.rails[k].route.length &&
        t.route.every((p, i) => distance(p, model.rails[k].route[i]) < 1e-8),
    )
  )
    return undefined
  const result = [...traces]
  model.indices.forEach((index, side) => {
    result[index] = changed[side]
  })
  return result
}

interface Window {
  start: number
  end: number
  saving: number
}

function windows(center: Point[]): Window[] {
  const prefix = [0]
  for (let i = 1; i < center.length; i++)
    prefix.push(prefix.at(-1)! + distance(center[i - 1], center[i]))
  const result: Window[] = []
  for (let start = 0; start + 2 < center.length; start++)
    for (let end = center.length - 1; end >= start + 2; end--) {
      const saving =
        prefix[end] - prefix[start] - distance(center[start], center[end])
      if (saving > 1e-7) result.push({ start, end, saving })
    }
  return result.sort(
    (a, b) => b.saving - a.saving || a.start - b.start || b.end - a.end,
  )
}

function beveled(
  input: SimpleRouteJson,
  model: PairModel,
  path: Point[],
  trim: number,
) {
  const centerTrace: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "anytime_pair_center",
    connection_name: model.virtual.name,
    route: path.map((p) => ({
      ...p,
      route_type: "wire",
      layer: model.virtual.pointsToConnect[0].layer,
      width: model.envelope,
    })),
  }
  return chamferOrdinaryCorners(
    { ...input, connections: [model.virtual] },
    [centerTrace],
    model.background,
    trim,
  )[0].route
}

function* pairStream(
  input: SimpleRouteJson,
  traces: Trace[],
  model: PairModel,
  options: PairTopologyOptions,
): Generator<Trace[] | undefined> {
  const sameDirection = (a: Point, b: Point, c: Point, d: Point) => {
    const first = distance(a, b),
      second = distance(c, d)
    return (
      first > 1e-8 &&
      second > 1e-8 &&
      Math.hypot(
        (b.x - a.x) / first - (d.x - c.x) / second,
        (b.y - a.y) / first - (d.y - c.y) / second,
      ) < 1e-8
    )
  }
  // Endpoint-normal changes can never keep the four shared handoffs. Remove
  // those windows before applying the finite shortcut budget, so useful inner
  // windows are reached even when the full corridor has different end tangents.
  const candidates = windows(model.center).filter(({ start, end }) =>
    connectors(model.center[start], model.center[end]).some(
      (segment) =>
        segment.length >= 2 &&
        (start > 0 ||
          sameDirection(
            model.center[0],
            model.center[1],
            segment[0],
            segment[1],
          )) &&
        (end < model.center.length - 1 ||
          sameDirection(
            model.center.at(-2)!,
            model.center.at(-1)!,
            segment.at(-2)!,
            segment.at(-1)!,
          )),
    ),
  )
  const seen = new Set<string>()
  const emit = (path: Point[]) => {
    if (length(path) > length(model.center) + 1e-7) return undefined
    const key = path.map((p) => `${p.x.toFixed(8)},${p.y.toFixed(8)}`).join(";")
    if (seen.has(key)) return undefined
    seen.add(key)
    return rebuild(input, traces, model, path, options)
  }
  function* local(): Generator<Trace[] | undefined> {
    for (const { start, end } of candidates.slice(
      0,
      options.maxShortcutWindows ?? 16,
    )) {
      for (const segment of connectors(
        model.center[start],
        model.center[end],
      )) {
        const path = simplify([
          ...model.center.slice(0, start),
          ...segment,
          ...model.center.slice(end + 1),
        ])
        yield emit(path)
        if (
          !routeAnglesAreConventional([
            {
              type: "pcb_trace",
              pcb_trace_id: "center",
              route: path.map((p) => ({
                ...p,
                route_type: "wire",
                layer: model.virtual.pointsToConnect[0].layer,
                width: model.envelope,
              })),
            },
          ])
        )
          for (const trim of [1.5, 0.75])
            yield emit(beveled(input, model, path, trim))
      }
    }
  }
  function* grid(): Generator<Trace[] | undefined> {
    const guarded = candidates
      .filter((w) => w.start > 0 && w.end < model.center.length - 1)
      .slice(0, options.maxGridWindows ?? 2)
    for (const { start, end } of guarded) {
      const a = model.center[start],
        b = model.center[end]
      // Clear analytic middle paths are already covered by local shortcuts.
      if (connectors(a, b).some((path) => model.scene.pathVisible(path))) {
        yield undefined
        continue
      }
      for (const step of options.gridSteps ?? [0.2, 0.1, 0.05]) {
        const margin = Math.max(2, model.envelope * 8)
        const mid = model.center.slice(start, end + 1)
        const bounds = {
          minX: Math.max(
            input.bounds.minX,
            Math.min(...mid.map((p) => p.x)) - margin,
          ),
          maxX: Math.min(
            input.bounds.maxX,
            Math.max(...mid.map((p) => p.x)) + margin,
          ),
          minY: Math.max(
            input.bounds.minY,
            Math.min(...mid.map((p) => p.y)) - margin,
          ),
          maxY: Math.min(
            input.bounds.maxY,
            Math.max(...mid.map((p) => p.y)) + margin,
          ),
        }
        const search = new GridVisibilitySearch(
          model.scene,
          a,
          b,
          [],
          0,
          undefined,
          {
            step,
            bounds,
            maxLength: length(mid) * 1.05,
            allTerminalAttachments: true,
          },
        )
        try {
          while (
            !search.solved &&
            !search.failed &&
            search.expanded < (options.maxSearchExpansions ?? 8000)
          ) {
            for (
              let i = 0;
              i < Math.max(1, options.searchStepsPerYield ?? 1) &&
              !search.solved &&
              !search.failed &&
              search.expanded < (options.maxSearchExpansions ?? 8000);
              i++
            )
              search.step()
            yield undefined
          }
          if (search.solved) {
            const path = simplify([
              ...model.center.slice(0, start),
              ...search.result,
              ...model.center.slice(end + 1),
            ])
            yield emit(path)
            for (const trim of [1.5, 0.75])
              yield emit(beveled(input, model, path, trim))
          }
        } finally {
          search.cancel()
        }
      }
    }
  }
  const active = [local(), grid()]
  try {
    while (active.length)
      for (let i = 0; i < active.length; ) {
        const next = active[i].next()
        if (next.done) active.splice(i, 1)
        else {
          i++
          yield next.value
        }
      }
  } finally {
    active.forEach((g) => g.return(undefined))
  }
}

/** Reroute already-coupled rails as one wide centerline, preserving all four
 * shared handoffs and every package approach. Scratch outputs may be unmatched;
 * the caller retunes the complete bus/pair cohort before publishing anything.
 * offsetPath is only a geometric kernel; no legacy pair-routing solve is run. */
export function* pairTopologyCandidates(
  input: SimpleRouteJson,
  traces: Trace[],
  options: PairTopologyOptions = {},
): Generator<Trace[] | undefined> {
  const max = options.maxCandidates ?? 128
  if (max < 1) return
  const fixed = fixedCopper(input),
    streams: Generator<Trace[] | undefined>[] = []
  let attempted = 0
  for (const pair of input.differentialPairs ?? []) {
    const model = modelFor(
      input,
      traces,
      pair,
      fixed,
      options.maxCenterlineVertices ?? 96,
    )
    if (model) streams.push(pairStream(input, traces, model, options))
    yield undefined
    if (++attempted >= max) return
  }
  try {
    while (streams.length)
      for (let i = 0; i < streams.length; ) {
        if (attempted >= max) return
        const next = streams[i].next()
        if (next.done) streams.splice(i, 1)
        else {
          i++
          attempted++
          yield next.value
        }
      }
  } finally {
    streams.forEach((g) => g.return(undefined))
  }
}

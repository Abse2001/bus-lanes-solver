import { offsetPath } from "./coupled-pair-routing"
import { distance, simplify } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import { fixedCopper, routeCopper, VectorScene } from "./vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

type Channel = { traces: Trace[]; path: Point[]; width: number }

function cut(path: Point[], u: number) {
  const crossings: { before: Point[]; after: Point[]; point: Point }[] = []
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i]
    if (!(a.x <= u && b.x > u)) continue
    const point = { x: u, y: a.y + ((b.y - a.y) * (u - a.x)) / (b.x - a.x) }
    crossings.push({
      before: [...path.slice(0, i), point],
      after: [point, ...path.slice(i)],
      point,
    })
  }
  return crossings.length === 1 ? crossings[0] : undefined
}

function bevel(
  path: Point[],
  size: number,
  lo: number,
  hi: number,
): Point[] | null {
  const points = simplify(
      path.filter((p, i) => i === 0 || distance(p, path[i - 1]) > 1e-8),
    ),
    result = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i].x < lo - 1e-8 || points[i].x > hi + 1e-8) {
      result.push(points[i])
      continue
    }
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1]
    const da = distance(a, b),
      db = distance(b, c)
    const u = { x: (b.x - a.x) / da, y: (b.y - a.y) / da },
      v = { x: (c.x - b.x) / db, y: (c.y - b.y) / db }
    const dot = u.x * v.x + u.y * v.y
    if (dot < -1e-6) return null
    if (dot < 0.7) {
      const d = Math.min(size, da * 0.4, db * 0.4)
      result.push(
        { x: b.x - u.x * d, y: b.y - u.y * d },
        { x: b.x + v.x * d, y: b.y + v.y * d },
      )
    } else result.push(b)
  }
  return [...result, points.at(-1)!]
}

/** Port of the reference's compact-bays/bays.py. Open ordered tuning banks
 * between the package approaches. Pairs occupy one wider channel and are
 * reconstructed as offsets of its centerline, preserving both escape paths. */
export function spreadCoupledTuningLanes(
  input: SimpleRouteJson,
  traces: Trace[],
  pitch: number,
): Trace[] | null {
  let result = structuredClone(traces)
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  for (const bus of input.buses ?? []) {
    const members = result.filter((t) =>
      bus.connectionNames.includes(t.connection_name!),
    )
    if (members.length < 3) continue
    const first = members[0].route[0],
      last = members[0].route.at(-1)!
    const vertical = Math.abs(last.y - first.y) >= Math.abs(last.x - first.x)
    const sign = Math.sign(vertical ? last.y - first.y : last.x - first.x) || 1
    const uv = (p: Point) =>
      vertical
        ? { x: p.y * sign, y: -p.x * sign }
        : { x: p.x * sign, y: p.y * sign }
    const xy = (p: Point) =>
      vertical
        ? { x: -p.y * sign, y: p.x * sign }
        : { x: p.x * sign, y: p.y * sign }
    const channels: Channel[] = []
    const used = new Set<string>()
    for (const trace of members) {
      if (used.has(trace.connection_name!)) continue
      const pair = input.differentialPairs?.find(
        (p) =>
          p.connectionNames.includes(trace.connection_name!) &&
          p.connectionNames.every((n) => bus.connectionNames.includes(n)),
      )
      const rails = pair?.connectionNames.map(
        (n) => members.find((t) => t.connection_name === n)!,
      )
      if (rails?.every((t) => t.coupledSection)) {
        const sections = rails.map((t) =>
          t.route.slice(t.coupledSection![0], t.coupledSection![1] + 1),
        )
        if (sections[0].length !== sections[1].length) return null
        const path = sections[0].map((p, i) =>
          uv({
            x: (p.x + sections[1][i].x) / 2,
            y: (p.y + sections[1][i].y) / 2,
          }),
        )
        channels.push({
          traces: rails,
          path,
          width:
            2 * (trace.route[0] as Wire).width + (pair!.traceGap ?? clearance),
        })
        rails.forEach((t) => used.add(t.connection_name!))
      } else {
        channels.push({
          traces: [trace],
          path: trace.route.map(uv),
          width: (trace.route[0] as Wire).width,
        })
        used.add(trace.connection_name!)
      }
    }
    const width = Math.max(...members.map((t) => (t.route[0] as Wire).width))
    const start = Math.max(...channels.map((c) => c.path[0].x)) + width * 2
    const end = Math.min(...channels.map((c) => c.path.at(-1)!.x)) - width * 2
    if (end - start < pitch * 2) return null
    let accepted: Trace[] | undefined
    attempts: for (const trim of [0, 0.05, 0.1, 0.2]) {
      const lo = start + (end - start) * trim,
        hi = end - (end - start) * trim
      const cuts = channels.map((c) => ({
        channel: c,
        a: cut(c.path, lo),
        b: cut(c.path, hi),
      }))
      if (cuts.some((c) => !c.a || !c.b)) continue
      cuts.sort((a, b) => a.a!.point.y - b.a!.point.y)
      if (cuts.some((c, i) => i > 0 && c.b!.point.y < cuts[i - 1].b!.point.y))
        continue
      const minV = Math.min(
          ...cuts.flatMap((c) => [c.a!.point.y, c.b!.point.y]),
        ),
        maxV = Math.max(...cuts.flatMap((c) => [c.a!.point.y, c.b!.point.y]))
      const center = (minV + maxV) / 2,
        split = Math.floor(cuts.length / 2)
      for (const extra of [1, 2, 3]) {
        const extent =
          Math.max(
            (maxV - minV) / 2 + pitch,
            Math.ceil(cuts.length / 2) * pitch,
          ) +
          extra * width
        const replacements: Trace[] = []
        for (const [side, group] of [
          [-1, cuts.slice(0, split).toReversed()],
          [1, cuts.slice(split)],
        ] as const) {
          const sideExtent = Math.max(
            extent,
            ...group.map(
              (c, i) =>
                Math.max(
                  side * (c.a!.point.y - center),
                  side * (c.b!.point.y - center),
                ) +
                (group.length - 1 - i) * pitch +
                width * 2,
            ),
          )
          const depths = group.map(() => 0)
          for (let i = group.length - 2; i >= 0; i--)
            depths[i] =
              depths[i + 1] +
              (group[i].channel.width + group[i + 1].channel.width) / 2 +
              clearance +
              width * 1.2
          for (const [i, c] of group.entries()) {
            const top = lo + depths[i],
              bottom = hi - depths[i]
            if (bottom - top < pitch) continue
            const v =
              center + side * (sideExtent - (group.length - 1 - i) * pitch)
            const path = bevel(
              [
                ...c.a!.before,
                { x: top, y: c.a!.point.y },
                { x: top, y: v },
                { x: bottom, y: v },
                { x: bottom, y: c.b!.point.y },
                ...c.b!.after,
              ],
              width * 1.5,
              lo,
              hi,
            )
            if (!path) continue
            const channel = c.channel
            if (channel.traces.length === 1) {
              const trace = channel.traces[0]
              replacements.push({
                ...trace,
                route: path.map((p) => ({
                  ...xy(p),
                  route_type: "wire",
                  layer: (trace.route[0] as Wire).layer,
                  width: (trace.route[0] as Wire).width,
                })),
              })
            } else {
              const centerPath = path.map(xy),
                rails = channel.traces
              const separation =
                channel.width - (rails[0].route[0] as Wire).width
              const offsets = [-separation / 2, separation / 2].sort(
                (a, b) =>
                  distance(
                    offsetPath(centerPath, a)[0],
                    rails[0].route[rails[0].coupledSection![0]],
                  ) -
                  distance(
                    offsetPath(centerPath, b)[0],
                    rails[0].route[rails[0].coupledSection![0]],
                  ),
              )
              for (const [k, trace] of rails.entries()) {
                const [s, e] = trace.coupledSection!,
                  points = offsetPath(centerPath, offsets[k])
                if (
                  distance(points[0], trace.route[s]) > 1e-7 ||
                  distance(points.at(-1)!, trace.route[e]) > 1e-7
                )
                  continue
                replacements.push({
                  ...trace,
                  coupledSection: [s, s + points.length - 1],
                  route: [
                    ...trace.route.slice(0, s),
                    ...points.map((p) => ({
                      ...p,
                      route_type: "wire" as const,
                      layer: (trace.route[0] as Wire).layer,
                      width: (trace.route[0] as Wire).width,
                    })),
                    ...trace.route.slice(e + 1),
                  ],
                })
              }
            }
          }
        }
        if (replacements.length !== members.length) continue
        const combined = result.map(
          (t) =>
            replacements.find((r) => r.connection_name === t.connection_name) ??
            t,
        )
        const copper = [...fixedCopper(input), ...combined.flatMap(routeCopper)]
        const bad = replacements.filter(
          (t) =>
            !new VectorScene(
              input,
              input.connections.find((c) => c.name === t.connection_name)!,
              (t.route[0] as Wire).width,
              copper,
            ).pathVisible(t.route) ||
            !tuningPathIsSelfClear(
              t.route,
              (t.route[0] as Wire).width + clearance,
            ),
        )
        if (bad.length) continue
        accepted = combined
        break attempts
      }
    }
    if (!accepted) return null
    result = accepted
  }
  return result
}

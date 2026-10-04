import { solve, type Constraint } from "yalps"
import { distance, segmentDistance } from "./geometry"
import { fixedCopper, clearanceToCopper, type Copper } from "./vector-scene"
import { CopperIndex } from "./copper-index"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

type Vertex = Point & { group?: number }
const MAX_CUT_PASSES = 24
const MAX_TABLEAU_CELLS = 64_000_000
/** A bounded linear compaction proposal. Ordinary edges keep their directions
 * and positive spans; each curved bank translates rigidly. Matched lengths are
 * equalities, while unconstrained copper may shorten. Paired rails and terminal
 * handoffs stay fixed. The caller must validate the returned proposal.
 *
 * Collision cuts retain the original separating side of each copper obstacle.
 * Generate them lazily instead of allocating a quadratic constraint matrix for
 * every sampled curve chord. Yield between solves so cancellation remains safe. */
export function* compactEnvelopeCandidate(
  input: SimpleRouteJson,
  traces: Trace[],
): Generator<void, Trace[]> {
  const variables: Record<string, Record<string, number>> = {},
    constraints: Record<string, Constraint> = {}
  if (!traces.length) return traces
  let serial = 0,
    groups = 0
  const add = (coeff: Map<string, number>, bound: Constraint) => {
    const key = `c${serial++}`
    if (![...coeff.values()].some((n) => Math.abs(n) > 1e-10)) return
    constraints[key] = bound
    for (const [v, n] of coeff)
      if (Math.abs(n) > 1e-10) (variables[v] ??= {})[key] = n
  }
  const term = (coeff: Map<string, number>, p: Vertex, n: Point, sign = 1) => {
    if (p.group === undefined) return
    for (const d of ["x", "y"] as const)
      for (const s of [-1, 1]) {
        const k = `${p.group}_${d}_${s}`,
          v = sign * n[d] * s
        coeff.set(k, (coeff.get(k) ?? 0) + v)
      }
  }
  // Two millimeters per proposal bounds the local search; the pipeline may
  // make a second proposal after independently accepting the first.
  const motion = 2
  const paired = new Set(
    input.differentialPairs?.flatMap((p) => p.connectionNames),
  )
  const paths: Vertex[][] = traces.map((t) => {
    const first = Math.min(...(t.curvedSegments ?? [])) - 1,
      last = Math.max(...(t.curvedSegments ?? []))
    const block = groups++
    return t.route.map((p, i) => ({
      ...p,
      group:
        i === 0 ||
        i === t.route.length - 1 ||
        paired.has(t.connection_name!) ||
        (i >= first &&
          i <= last &&
          (first === 0 || last === t.route.length - 1))
          ? undefined
          : i >= first && i <= last
            ? block
            : groups++,
    }))
  })
  for (const path of paths)
    for (const p of path)
      if (p.group !== undefined)
        for (const d of ["x", "y"] as const)
          for (const s of [-1, 1]) {
            const v = `${p.group}_${d}_${s}`
            if (variables[v]) continue
            variables[v] = { objective: 0.0001 }
            add(new Map([[v, 1]]), { max: motion })
          }
  for (const [ti, path] of paths.entries()) {
    const lengthTerms = new Map<string, number>()
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1],
        b = path[i],
        span = distance(a, b)
      if (a.group === b.group) continue
      if (span < 1e-8) {
        for (const n of [
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ]) {
          const c = new Map<string, number>()
          term(c, b, n)
          term(c, a, n, -1)
          add(c, { equal: 0 })
        }
        continue
      }
      const u = { x: (b.x - a.x) / span, y: (b.y - a.y) / span },
        n = { x: -u.y, y: u.x }
      const c = new Map<string, number>()
      term(c, b, n)
      term(c, a, n, -1)
      add(c, { equal: 0 })
      const forward = new Map<string, number>()
      term(forward, b, u)
      term(forward, a, u, -1)
      add(forward, { min: Math.min(span, 0.01) - span })
      term(lengthTerms, b, u)
      term(lengthTerms, a, u, -1)
    }
    add(
      lengthTerms,
      input.buses?.some(
        (b) =>
          b.maxLengthSkew !== undefined &&
          b.connectionNames.includes(traces[ti].connection_name!),
      )
        ? { equal: 0 }
        : { max: 0 },
    )
  }
  for (const d of ["x", "y"] as const) {
    const lo = Math.min(...paths.flat().map((p) => p[d])),
      hi = Math.max(...paths.flat().map((p) => p[d]))
    for (const sign of [-1, 1]) {
      const v = `bound_${d}_${sign}`
      variables[v] = { objective: -1 }
      add(new Map([[v, 1]]), { max: hi - lo })
      const seen = new Map<string, number>()
      for (const p of paths.flat()) {
        const k = String(p.group)
        const limit = sign === 1 ? hi - p[d] : p[d] - lo
        seen.set(k, Math.min(seen.get(k) ?? Infinity, limit))
      }
      for (const [g, limit] of seen) {
        const c = new Map<string, number>([[v, 1]])
        term(
          c,
          { x: 0, y: 0, group: g === "undefined" ? undefined : Number(g) },
          d === "x" ? { x: sign, y: 0 } : { x: 0, y: sign },
        )
        add(c, { max: limit })
      }
    }
  }
  const fixed = fixedCopper(input),
    clearance =
      input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const originals: (Copper & { a: Vertex; b: Vertex })[] = paths.flatMap(
    (path, t) =>
      path.slice(1).map((p, i) => ({
        a: path[i],
        b: p,
        radius: (traces[t].route[i] as Wire).width / 2,
        layer: (traces[t].route[i] as Wire).layer,
        owners: [traces[t].connection_name!, traces[t].source_trace_id ?? ""],
      })),
  )
  const projection = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x,
      dy = b.y - a.y,
      v = Math.max(
        0,
        Math.min(
          1,
          ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
        ),
      )
    return { x: a.x + v * dx, y: a.y + v * dy }
  }
  const used = new Set<string>()
  const variableCount = Object.keys(variables).length
  for (let pass = 0; pass < MAX_CUT_PASSES; pass++) {
    // YALPS uses a dense Float64 tableau. Cap both memory and simplex work;
    // an oversized board keeps its already accepted routing.
    const rows = Object.values(constraints).reduce(
      (n, c) =>
        n +
        (c.equal !== undefined || (c.min !== undefined && c.max !== undefined)
          ? 2
          : 1),
      0,
    )
    if ((rows + 1) * (variableCount + 1) > MAX_TABLEAU_CELLS) return traces
    yield
    const solution = solve(
      { direction: "minimize", objective: "objective", variables, constraints },
      { precision: 1e-10, maxPivots: 4096 },
    )
    if (solution.status !== "optimal") return traces
    const values = new Map(solution.variables)
    const at = (p: Vertex) => ({
      ...p,
      x:
        p.x +
        (p.group === undefined
          ? 0
          : (values.get(`${p.group}_x_1`) ?? 0) -
            (values.get(`${p.group}_x_-1`) ?? 0)),
      y:
        p.y +
        (p.group === undefined
          ? 0
          : (values.get(`${p.group}_y_1`) ?? 0) -
            (values.get(`${p.group}_y_-1`) ?? 0)),
    })
    const copper = originals.map((c) => ({ ...c, a: at(c.a), b: at(c.b) }))
    const index = new CopperIndex([...fixed, ...copper]),
      lookup = new Map<Copper, (typeof originals)[number]>(
        copper.map((c, i) => [c, originals[i]]),
      )
    const identities = new Map<Copper, number>(
      [...fixed, ...copper].map((c, i) => [c, i]),
    )
    let added = 0
    const groupPairs = new Map<string, number>()
    for (let ci = 0; ci < copper.length; ci++) {
      const c = copper[ci],
        old = originals[ci]
      const near: Copper[] = []
      const r = c.radius + clearance
      index.some(
        {
          minX: Math.min(c.a.x, c.b.x) - r,
          maxX: Math.max(c.a.x, c.b.x) + r,
          minY: Math.min(c.a.y, c.b.y) - r,
          maxY: Math.max(c.a.y, c.b.y) + r,
        },
        (other) => {
          near.push(other)
          return false
        },
      )
      for (const other of near) {
        if (c.layer !== other.layer) continue
        const moving = lookup.get(other)
        const sameNet = other.owners.some((o) => o && c.owners.includes(o))
        if (sameNet && !moving) continue
        const base: Copper = moving ?? other
        if (
          sameNet &&
          (old.a === base.a ||
            old.a === base.b ||
            old.b === base.a ||
            old.b === base.b ||
            (old.a.group === old.b.group &&
              old.a.group === (base.a as Vertex).group &&
              old.a.group === (base.b as Vertex).group))
        )
          continue
        // Adjacent portions of one bend can already be closer than copper
        // clearance. Never reduce that existing separation; the final route
        // validator still checks returning arms and self-intersections.
        const requiredGap = sameNet
          ? Math.min(
              c.radius + clearance + base.radius,
              segmentDistance([old.a, old.b], [base.a, base.b]),
            )
          : c.radius + clearance + (base.rect ? 0 : base.radius)
        if (
          clearanceToCopper(c.a, c.b, other) >=
          requiredGap - (base.rect ? 0 : base.radius) - 1e-9
        )
          continue
        const key = `${ci}:${identities.get(other)}`
        const groupKey = `${old.a.group}:${old.b.group}:${(base.a as Vertex).group}:${(base.b as Vertex).group}:${lookup.has(other) ? "moving" : "f" + identities.get(other)}`
        if (used.has(key) || (groupPairs.get(groupKey) ?? 0) >= 4) continue
        groupPairs.set(groupKey, (groupPairs.get(groupKey) ?? 0) + 1)
        used.add(key)
        const corners = base.rect
          ? [
              { x: base.rect.minX, y: base.rect.minY },
              { x: base.rect.maxX, y: base.rect.minY },
              { x: base.rect.maxX, y: base.rect.maxY },
              { x: base.rect.minX, y: base.rect.maxY },
            ]
          : [base.a, base.b]
        const directions: Point[] = [
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ]
        for (const a of [old.a, old.b])
          for (let j = 0; j < corners.length; j++) {
            const b = projection(
              a,
              corners[j],
              corners[(j + 1) % corners.length],
            )
            directions.push({ x: a.x - b.x, y: a.y - b.y })
          }
        for (const b of corners) {
          const a = projection(b, old.a, old.b)
          directions.push({ x: a.x - b.x, y: a.y - b.y })
        }
        let best: Point | undefined,
          gap = -Infinity
        for (const u of directions) {
          const size = Math.hypot(u.x, u.y)
          if (size < 1e-10) continue
          for (const sign of [-1, 1]) {
            const n = { x: (u.x / size) * sign, y: (u.y / size) * sign },
              g =
                Math.min(...[old.a, old.b].map((p) => p.x * n.x + p.y * n.y)) -
                Math.max(...corners.map((p) => p.x * n.x + p.y * n.y))
            if (g > gap) {
              gap = g
              best = n
            }
          }
        }
        if (!best || gap < 0) return traces
        const required = Math.min(gap, requiredGap + 1e-6)
        for (const a of [old.a, old.b])
          for (const b of corners) {
            const coeff = new Map<string, number>()
            term(coeff, a, best)
            term(coeff, b, best, -1)
            add(coeff, {
              min: required - ((a.x - b.x) * best.x + (a.y - b.y) * best.y),
            })
          }
        added++
      }
    }
    if (!added || pass === MAX_CUT_PASSES - 1)
      return traces.map((t, i) => ({
        ...t,
        route: t.route.map((p, j) => ({
          ...p,
          x: at(paths[i][j]).x,
          y: at(paths[i][j]).y,
        })),
      }))
  }
  return traces
}

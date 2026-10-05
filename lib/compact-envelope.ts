import { solve, type Constraint } from "yalps"
import { fixedRouteLength, lengthConstraints } from "./route-lengths"
import { compactionMotionGroups } from "./compaction-motion-groups"
import { projectCompactionDirections } from "./project-compaction-directions"
import { CompactionCutSet } from "./compaction-cut-set"
import { length, distance, segmentDistance } from "./geometry"
import { fixedCopper, clearanceToCopper, type Copper } from "./vector-scene"
import { CopperIndex } from "./copper-index"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

type Vertex = Point & { group?: number }
export type CompactionMode =
  | "conservative"
  | "coordinated"
  | "flexible"
  | "guarded"
  | "cohort"
  | "guarded-cohort"
/** A bounded linear compaction proposal. Ordinary edges keep their directions
 * and positive spans. Conservative proposals preserve matched lengths and rigid
 * banks; coordinated proposals may shorten matched lanes within their full-copper
 * bounds and move paired rails together. Flexible proposals also contract the
 * straight legs between rigid arcs. The caller must validate every proposal.
 *
 * Collision cuts retain the original separating side of each copper obstacle.
 * Generate them lazily instead of allocating a quadratic constraint matrix for
 * every sampled curve chord. Yield between solves so cancellation remains safe. */
export function* compactEnvelopeCandidate(
  input: SimpleRouteJson,
  traces: Trace[],
  mode: CompactionMode = "conservative",
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
  // Bound displacement per proposal. Flexible banks need more travel because
  // shrinking opposite legs can otherwise exhaust the local search window.
  const cohort = mode === "cohort" || mode === "guarded-cohort"
  const protectedVias = mode === "guarded" || mode === "guarded-cohort"
  const advanced = mode !== "conservative"
  const flexible = mode === "flexible" || mode === "guarded" || cohort
  const motion = flexible && !cohort ? 4 : 2
  const maxCutPasses = advanced && !cohort ? 12 : 24
  const maxTableauCells = protectedVias ? 96_000_000 : 64_000_000
  const paired = new Set(
    input.differentialPairs?.flatMap((p) => p.connectionNames),
  )
  const paths: Vertex[][] = advanced
    ? compactionMotionGroups(input, traces, flexible, protectedVias, cohort)
    : traces.map((t) => {
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
            variables[v] = { objective: advanced ? 0.000001 : 0.0001 }
            add(new Map([[v, 1]]), { max: motion })
          }
  const lengths = new Map<
    string,
    { terms: Map<string, number>; total: number }
  >()
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
    if (!advanced) {
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
    } else {
      const name = traces[ti].connection_name!
      const total = length(traces[ti].route) + fixedRouteLength(input, name)
      lengths.set(name, { terms: lengthTerms, total })
      add(lengthTerms, { max: 0 })
      for (const bus of input.buses ?? [])
        if (bus.connectionNames.includes(name) && bus.minLength !== undefined)
          add(lengthTerms, { min: bus.minLength - total })
    }
  }
  if (advanced) {
    for (const [index, { names, tolerance }] of lengthConstraints(
      input,
    ).entries()) {
      const members = names
        .map((n) => lengths.get(n))
        .filter((v): v is { terms: Map<string, number>; total: number } => !!v)
      if (!members.length) continue
      // A shared ceiling expresses every pairwise skew bound with O(n) rows.
      // Its nonnegative shrink is sufficient because no signal may lengthen.
      const ceiling = Math.max(...members.map((m) => m.total)),
        v = `bus_shrink_${index}`
      // Cohorts reserve matching slack for simplex rounding and direction
      // projection. Other modes retain the validated boundary solution. The
      // output validator always enforces the original SRJ limits.
      const allowedSkew = cohort
        ? Math.max(0, tolerance - 1e-5)
        : Math.max(
            tolerance + 1e-8,
            ceiling - Math.min(...members.map((m) => m.total)) + 1e-9,
          )
      variables[v] = { objective: 0 }
      add(new Map([[v, 1]]), { max: ceiling })
      for (const member of members) {
        const coeff = new Map(member.terms)
        coeff.set(v, 1)
        add(coeff, {
          max: ceiling - member.total,
          min: ceiling - allowedSkew - member.total,
        })
      }
    }
  }
  for (const d of ["x", "y"] as const) {
    const lo = Math.min(...paths.flat().map((p) => p[d])),
      hi = Math.max(...paths.flat().map((p) => p[d]))
    for (const sign of [-1, 1]) {
      const v = `bound_${d}_${sign}`
      // First-order fractional area decrease; the caller gates actual area.
      const weight = advanced ? 1 / Math.max(hi - lo, 1) : 1
      const outward = v + "_out"
      variables[v] = { objective: -weight }
      if (advanced) {
        variables[outward] = { objective: weight }
        add(new Map([[outward, 1]]), { max: motion })
      }
      add(new Map([[v, 1]]), { max: hi - lo })
      const seen = new Map<string, number>()
      for (const p of paths.flat()) {
        const k = String(p.group)
        const limit = sign === 1 ? hi - p[d] : p[d] - lo
        seen.set(k, Math.min(seen.get(k) ?? Infinity, limit))
      }
      for (const [g, limit] of seen) {
        const c = new Map<string, number>([[v, 1]])
        if (advanced) c.set(outward, -1)
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
  const cuts = new CompactionCutSet(motion)
  const collisionRows: string[] = []
  const materialize = () => {
    for (const key of collisionRows) {
      delete constraints[key]
      for (const v of Object.values(variables)) delete v[key]
    }
    collisionRows.length = 0
    for (const cut of cuts.active()) {
      const coeff = new Map<string, number>()
      term(coeff, cut.a, cut.n)
      term(coeff, cut.b, cut.n, -1)
      const key = `c${serial}`
      add(coeff, { min: cut.min })
      if (constraints[key]) collisionRows.push(key)
    }
  }
  const used = new Set<string>()
  const variableCount = Object.keys(variables).length
  let proposal = traces
  for (let pass = 0; pass < maxCutPasses; pass++) {
    if (advanced) materialize()
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
    if ((rows + 1) * (variableCount + 1) > maxTableauCells) return proposal
    yield
    // Cohort models contain many nearly dependent equalities. Solve them at
    // a stable simplex precision, then restore straight directions before
    // checking actual geometry; this does not relax output tolerances.
    const solution = solve(
      { direction: "minimize", objective: "objective", variables, constraints },
      {
        precision: cohort ? 1e-7 : 1e-10,
        maxPivots: 4096,
        checkCycles: advanced,
      },
    )
    if (solution.status !== "optimal") return proposal
    const values = new Map(solution.variables)
    const shifts = cohort
      ? projectCompactionDirections(paths, values, false)
      : undefined
    if (
      shifts &&
      [...shifts.values()].some(
        (p) =>
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          Math.abs(p.x) > motion + 1e-6 ||
          Math.abs(p.y) > motion + 1e-6,
      )
    )
      return proposal
    const at = (p: Vertex) => ({
      ...p,
      x:
        p.x +
        (p.group === undefined
          ? 0
          : shifts
            ? shifts.get(p.group)!.x
            : (values.get(`${p.group}_x_1`) ?? 0) -
              (values.get(`${p.group}_x_-1`) ?? 0)),
      y:
        p.y +
        (p.group === undefined
          ? 0
          : shifts
            ? shifts.get(p.group)!.y
            : (values.get(`${p.group}_y_1`) ?? 0) -
              (values.get(`${p.group}_y_-1`) ?? 0)),
    })
    // Pin numerical zeroes only in the returned proposal. Keeping those
    // pins out of collision discovery avoids changing separating sides at
    // an existing contact because of a rounded simplex coordinate.
    const publishShifts = cohort
      ? projectCompactionDirections(paths, values)
      : undefined
    const publishAt = (p: Vertex) =>
      publishShifts && p.group !== undefined
        ? {
            x: p.x + publishShifts.get(p.group)!.x,
            y: p.y + publishShifts.get(p.group)!.y,
          }
        : at(p)
    if (advanced)
      proposal = traces.map((t, i) => ({
        ...t,
        route: t.route.map((p, j) => ({
          ...p,
          x: publishAt(paths[i][j]).x,
          y: publishAt(paths[i][j]).y,
        })),
      }))
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
        if (
          used.has(key) ||
          (!advanced && (groupPairs.get(groupKey) ?? 0) >= 4)
        )
          continue
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
            if (advanced) {
              cuts.add({
                a,
                b,
                n: best,
                min: required - ((a.x - b.x) * best.x + (a.y - b.y) * best.y),
              })
              continue
            }
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
    if (!added || pass === maxCutPasses - 1)
      return traces.map((t, i) => ({
        ...t,
        route: t.route.map((p, j) => ({
          ...p,
          x: publishAt(paths[i][j]).x,
          y: publishAt(paths[i][j]).y,
        })),
      }))
  }
  return traces
}

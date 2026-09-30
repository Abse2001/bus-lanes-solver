import { segmentDistance, length } from "./geometry"
import type { Trace, Wire } from "./types"

type Candidate = { traces: Trace[]; key: string; length: number; id: number }

/** Select compatible, freshly computed alternatives. A paired route is one
 * indivisible choice so candidate selection cannot separate its rails. */
export class RouteCandidatePool {
  private pools = new Map<string, Candidate[]>()
  private conflicts = new Map<number, Map<number, boolean>>()
  private nextId = 0
  private additions = 0
  constructor(
    private clearance: number,
    private limit = 120,
  ) {}

  add(unit: string, traces: Trace[]) {
    const pool = this.pools.get(unit) ?? []
    const signature = JSON.stringify(traces.map((t) => t.route))
    if (pool.some((c) => c.key === signature)) return
    const candidate = {
      traces,
      key: signature,
      length: traces.reduce((sum, t) => sum + length(t.route), 0),
      id: this.nextId++,
    }
    pool.push(candidate)
    if (pool.length > this.limit) pool.shift()
    this.pools.set(unit, pool)
    this.additions++
  }

  private collides(a: Candidate, b: Candidate): boolean {
    if (
      !a.traces.some((first) =>
        b.traces.some(
          (second) =>
            (first.route[0] as Wire).layer === (second.route[0] as Wire).layer,
        ),
      )
    )
      return false
    const aid = a.id
    const bid = b.id
    const low = Math.min(aid, bid),
      high = Math.max(aid, bid)
    const row = this.conflicts.get(low) ?? new Map<number, boolean>()
    this.conflicts.set(low, row)
    const cached = row.get(high)
    if (cached !== undefined) return cached
    for (const first of a.traces)
      for (const second of b.traces) {
        if ((first.route[0] as Wire).layer !== (second.route[0] as Wire).layer)
          continue
        const required =
          ((first.route[0] as Wire).width + (second.route[0] as Wire).width) /
            2 +
          this.clearance -
          1e-8
        for (let i = 1; i < first.route.length; i++)
          for (let j = 1; j < second.route.length; j++) {
            const p = first.route[i - 1],
              q = first.route[i],
              r = second.route[j - 1],
              s = second.route[j]
            if (
              Math.max(p.x, q.x) + required < Math.min(r.x, s.x) ||
              Math.max(r.x, s.x) + required < Math.min(p.x, q.x) ||
              Math.max(p.y, q.y) + required < Math.min(r.y, s.y) ||
              Math.max(r.y, s.y) + required < Math.min(p.y, q.y)
            )
              continue
            if (segmentDistance([p, q], [r, s]) < required) {
              row.set(high, true)
              return true
            }
          }
      }
    row.set(high, false)
    return false
  }

  private compatible(
    domains: Candidate[][],
    searchBudget = 50000,
  ): Candidate[] | null {
    if (domains.some((domain) => !domain.length)) return null
    // Separate layer-disjoint domains before backtracking. An unsatisfiable
    // byte bus must not cause enumeration of every solution on another layer.
    const layers = domains.map(
      (domain) =>
        new Set(
          domain.flatMap((candidate) =>
            candidate.traces.map((trace) => (trace.route[0] as Wire).layer),
          ),
        ),
    )
    const pending = new Set(domains.map((_, i) => i))
    const components: number[][] = []
    while (pending.size) {
      const component = [pending.values().next().value!]
      pending.delete(component[0])
      for (let j = 0; j < component.length; j++)
        for (const i of pending) {
          if (![...layers[i]].some((layer) => layers[component[j]].has(layer)))
            continue
          pending.delete(i)
          component.push(i)
        }
      components.push(component)
    }
    if (components.length > 1) {
      const combined: Candidate[] = []
      for (const component of components) {
        const result = this.compatible(
          component.map((i) => domains[i]),
          searchBudget,
        )
        if (!result) return null
        component.forEach((index, i) => {
          combined[index] = result[i]
        })
      }
      return combined
    }
    const selected: Array<Candidate | undefined> = domains.map(() => undefined)
    // Forward-check a finite-domain assignment. Unlike a native SAT backend,
    // this search has an explicit work bound and retains no learned native heap.
    const visit = (remaining: Candidate[][]): Candidate[] | null => {
      if (--searchBudget < 0) return null
      let next = -1
      for (let i = 0; i < remaining.length; i++) {
        if (selected[i]) continue
        if (!remaining[i].length) return null
        if (next < 0 || remaining[i].length < remaining[next].length) next = i
      }
      if (next < 0) return selected as Candidate[]
      for (const candidate of remaining[next]) {
        selected[next] = candidate
        const filtered = remaining.map((domain, i) =>
          selected[i]
            ? domain
            : domain.filter((other) => !this.collides(candidate, other)),
        )
        const result = visit(filtered)
        if (result) return result.slice()
        selected[next] = undefined
        if (searchBudget < 0) break
      }
      return null
    }
    return visit(
      domains.map((domain) => [...domain].sort((a, b) => a.length - b.length)),
    )
  }

  private pruneConflicts() {
    const active = new Set(
      [...this.pools.values()].flat().map((candidate) => candidate.id),
    )
    for (const [a, row] of this.conflicts) {
      if (!active.has(a)) {
        this.conflicts.delete(a)
        continue
      }
      for (const b of row.keys()) if (!active.has(b)) row.delete(b)
    }
    this.additions = 0
  }

  select(units: string[], matchingGroups: string[][] = []): Trace[] | null {
    if (this.additions >= 100) this.pruneConflicts()
    let domains = units.map((unit) => this.pools.get(unit) ?? [])
    let best = this.compatible(domains)
    if (!best) return null
    const peak = (candidate: Candidate) =>
      Math.max(...candidate.traces.map((t) => length(t.route)))
    // First bound the overall detour, then minimize each matching group's
    // target independently. A long bus must not hide another bus's outlier.
    for (const group of [units, ...matchingGroups]) {
      const indices = new Set(
        group.map((name) => units.indexOf(name)).filter((i) => i >= 0),
      )
      if (!indices.size) continue
      let ceiling = Math.max(...best.filter((_, i) => indices.has(i)).map(peak))
      const levels = [
        ...new Set(
          domains.flatMap((domain, i) =>
            indices.has(i) ? domain.map(peak) : [],
          ),
        ),
      ]
        .filter((n) => n < ceiling)
        .sort((a, b) => a - b)
      let lo = 0,
        hi = levels.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const choice = this.compatible(
          domains.map((domain, i) =>
            indices.has(i)
              ? domain.filter((c) => peak(c) <= levels[mid])
              : domain,
          ),
        )
        if (choice) {
          best = choice
          ceiling = levels[mid]
          hi = mid - 1
        } else lo = mid + 1
      }
      domains = domains.map((domain, i) =>
        indices.has(i) ? domain.filter((c) => peak(c) <= ceiling) : domain,
      )
    }
    return best.flatMap((c) => c.traces)
  }
}

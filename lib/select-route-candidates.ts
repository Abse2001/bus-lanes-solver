import { length } from "./geometry"
import { RouteConflictIndex } from "./route-conflict-index"
import type { Trace, Wire } from "./types"

// Dense early candidate ids dominate compatibility checks. Keep that cache
// bounded (4 KiB per candidate); unusually long searches use the sparse map.
class CandidateConflicts {
  private bits = new Uint8Array(0)
  private sparse = new Map<number, boolean>()
  get(id: number): boolean | undefined {
    if (id >= 4096) return this.sparse.get(id)
    const value = this.bits[id]
    return value ? value === 2 : undefined
  }
  set(id: number, value: boolean) {
    if (id >= 4096) {
      this.sparse.set(id, value)
      return
    }
    if (id >= this.bits.length) {
      const next = new Uint8Array(
        Math.max(16, 2 ** Math.ceil(Math.log2(id + 1))),
      )
      next.set(this.bits)
      this.bits = next
    }
    this.bits[id] = value ? 2 : 1
  }
  keys() {
    return this.sparse.keys()
  }
  delete(id: number) {
    this.sparse.delete(id)
  }
}

type Candidate = {
  traces: Trace[]
  key: string
  length: number
  peak: number
  id: number
  layers: string[]
  singleLayer: string | undefined
  conflicts: CandidateConflicts
}

/** Select compatible, freshly computed alternatives. A paired route is one
 * indivisible choice so candidate selection cannot separate its rails. */
export class RouteCandidatePool {
  private pools = new Map<string, Candidate[]>()
  private nextId = 0
  private additions = 0
  private assignments = new Map<string, Candidate[] | null>()
  private routeConflicts = new RouteConflictIndex()
  private signatures = new Map<string, Set<string>>()
  private routeSignatures = new WeakMap<Trace["route"], string>()
  private revision = 0
  private selection?: { revision: number; key: string; result: Trace[] | null }
  constructor(
    private clearance: number,
    private limit = 120,
  ) {}

  add(unit: string, traces: Trace[]) {
    const pool = this.pools.get(unit) ?? []
    let signatures = this.signatures.get(unit)
    if (!signatures) {
      signatures = new Set()
      this.signatures.set(unit, signatures)
    }
    const signature = `[${traces
      .map((trace) => {
        let value = this.routeSignatures.get(trace.route)
        if (value === undefined) {
          value = JSON.stringify(trace.route)
          this.routeSignatures.set(trace.route, value)
        }
        return value
      })
      .join(",")}]`
    if (signatures.has(signature)) return
    const lengths = traces.map((trace) => length(trace.route))
    const candidate = {
      traces,
      key: signature,
      length: lengths.reduce((sum, value) => sum + value, 0),
      peak: Math.max(...lengths),
      layers: [...new Set(traces.map((t) => (t.route[0] as Wire).layer))],
      singleLayer: traces.every(
        (t) =>
          (t.route[0] as Wire).layer === (traces[0].route[0] as Wire).layer,
      )
        ? (traces[0].route[0] as Wire).layer
        : undefined,
      conflicts: new CandidateConflicts(),
      id: this.nextId++,
    }
    pool.push(candidate)
    signatures.add(signature)
    if (pool.length > this.limit) signatures.delete(pool.shift()!.key)
    this.pools.set(unit, pool)
    this.additions++
    this.revision++
  }

  transformUnit(unit: string, transform: (traces: Trace[]) => Trace[] | null) {
    const alternatives = this.pools.get(unit) ?? []
    this.pools.delete(unit)
    this.signatures.delete(unit)
    this.revision++
    for (const candidate of alternatives) {
      const traces = transform(candidate.traces)
      if (traces) this.add(unit, traces)
    }
  }

  hasEveryUnit(units: string[]) {
    return units.every((unit) => !!this.pools.get(unit)?.length)
  }

  /** Small unresolved domain set for generating fresh conditional routes.
   * A bounded search failure is a refinement hint, not an impossibility proof. */
  unresolvedUnits(units: string[]): string[] | null {
    if (
      this.compatible(
        units.map((n) => this.pools.get(n) ?? []),
        500000,
      )
    )
      return null
    let subset = units.slice()
    for (const unit of units) {
      const remaining = subset.filter((n) => n !== unit)
      if (
        !this.compatible(
          remaining.map((n) => this.pools.get(n) ?? []),
          500000,
        )
      )
        subset = remaining
    }
    return subset
  }

  conditionalRoutes(
    units: string[],
    trial: number,
    completion: string[] = [],
  ): Trace[] | null {
    if (!units.length) return []
    const pivot = trial % units.length,
      index = Math.floor(trial / units.length)
    const domains = units.map((n, i) => {
      const pool = this.pools.get(n) ?? []
      return trial < 0 || i !== pivot || !pool.length
        ? pool
        : [pool[index % pool.length]]
    })
    let selected = this.compatible(domains, 500000)
    if (!selected) return null
    const extended = selected.map((candidate) => [candidate])
    for (const unit of completion) {
      if (units.includes(unit)) continue
      const domain = this.pools.get(unit) ?? []
      const next = this.compatible([...extended, domain])
      if (!next) continue
      extended.push(domain)
      selected = next
    }
    return selected.flatMap((candidate) => candidate.traces)
  }

  get revisionNumber() {
    return this.revision
  }

  private collides(a: Candidate, b: Candidate): boolean {
    if (
      a.singleLayer !== undefined &&
      b.singleLayer !== undefined &&
      a.singleLayer !== b.singleLayer
    )
      return false
    const low = a.id < b.id ? a : b
    const high = Math.max(a.id, b.id)
    const row = low.conflicts
    const cached = row.get(high)
    if (cached !== undefined) return cached
    if (!a.layers.some((layer) => b.layers.includes(layer))) {
      row.set(high, false)
      return false
    }
    for (const first of a.traces)
      for (const second of b.traces) {
        if ((first.route[0] as Wire).layer !== (second.route[0] as Wire).layer)
          continue
        const required =
          ((first.route[0] as Wire).width + (second.route[0] as Wire).width) /
            2 +
          this.clearance -
          1e-8
        if (
          this.routeConflicts.firstConflict(first.route, second.route, required)
        ) {
          row.set(high, true)
          return true
        }
      }
    row.set(high, false)
    return false
  }

  private compatible(
    domains: Candidate[][],
    searchBudget = 50000,
  ): Candidate[] | null {
    const key =
      `${searchBudget}:` +
      domains.map((domain) => domain.map((c) => c.id).join(",")).join(";")
    if (this.assignments.has(key)) return this.assignments.get(key)!
    const result = this.computeCompatible(domains, searchBudget)
    if (this.assignments.size >= 128)
      this.assignments.delete(this.assignments.keys().next().value!)
    this.assignments.set(key, result)
    return result
  }

  private computeCompatible(
    domains: Candidate[][],
    searchBudget: number,
  ): Candidate[] | null {
    if (domains.some((domain) => !domain.length)) return null
    // Separate layer-disjoint domains before backtracking. An unsatisfiable
    // byte bus must not cause enumeration of every solution on another layer.
    const layers = domains.map(
      (domain) => new Set(domain.flatMap((candidate) => candidate.layers)),
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
    for (const pool of this.pools.values())
      for (const candidate of pool)
        for (const other of candidate.conflicts.keys())
          if (!active.has(other)) candidate.conflicts.delete(other)
    this.additions = 0
  }

  select(units: string[], matchingGroups: string[][] = []): Trace[] | null {
    const key = JSON.stringify([units, matchingGroups])
    if (
      this.selection?.revision === this.revision &&
      this.selection.key === key
    )
      return this.selection.result?.slice() ?? null
    const result = this.computeSelection(units, matchingGroups)
    this.selection = { revision: this.revision, key, result }
    return result?.slice() ?? null
  }

  private computeSelection(
    units: string[],
    matchingGroups: string[][],
  ): Trace[] | null {
    if (this.additions >= 100) this.pruneConflicts()
    let domains = units.map((unit) => this.pools.get(unit) ?? [])
    let best = this.compatible(domains)
    if (!best) return null
    const peak = (candidate: Candidate) => candidate.peak
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

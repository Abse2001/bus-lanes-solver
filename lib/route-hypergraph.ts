import { length } from "./geometry"
import { RouteConflictIndex } from "./route-conflict-index"
import type { Trace, Wire } from "./types"

/** A vertex is a signal demand. A hyperedge is an atomic geometric alternative
 * covering one or more demands (the two rails of a pair share one hyperedge).
 * Intersecting copper induces exclusion edges. Initial routing is a cost-ordered
 * exact cover of demands, with forward checking of geometric exclusions. */
export interface RouteHyperedge {
  id: number
  vertices: string[]
  traces: Trace[]
  cost: number
}
export class RouteHypergraph {
  readonly vertices = new Set<string>()
  readonly edges: RouteHyperedge[] = []
  private domains = new Map<string, RouteHyperedge[]>()
  private signatures = new Set<string>()
  private covers = new Map<string, Trace[] | null>()
  private exclusions = new Map<string, boolean>()
  private conflicts = new RouteConflictIndex()
  private pairMembers = new Map<string, [string, string]>()
  private singles = new Map<string, Trace[]>()
  constructor(
    private clearance: number,
    pairs: Array<[string, string]> = [],
  ) {
    for (const pair of pairs)
      for (const name of pair) this.pairMembers.set(name, pair)
  }
  add(_unit: string, traces: Trace[]) {
    if (
      traces.length === 1 &&
      this.pairMembers.has(traces[0].connection_name!)
    ) {
      const name = traces[0].connection_name!
      const choices = this.singles.get(name) ?? []
      if (
        !choices.some(
          (t) => JSON.stringify(t.route) === JSON.stringify(traces[0].route),
        )
      )
        choices.push(traces[0])
      if (choices.length > 16) choices.shift()
      this.singles.set(name, choices)
      const pair = this.pairMembers.get(name)!
      const other = pair.find((n) => n !== name)!
      for (const trace of this.singles.get(other) ?? []) {
        const first = traces[0].route[0] as Wire,
          second = trace.route[0] as Wire
        if (first.layer !== second.layer) continue
        if (
          this.conflicts.firstConflict(
            traces[0].route,
            trace.route,
            (first.width + second.width) / 2 + this.clearance - 1e-8,
          )
        )
          continue
        this.addEdge(pair.map((n) => (n === name ? traces[0] : trace)))
      }
      return
    }
    this.addEdge(traces)
  }
  private addEdge(traces: Trace[]) {
    const signature = JSON.stringify(traces)
    if (this.signatures.has(signature)) return
    this.signatures.add(signature)
    const edge: RouteHyperedge = {
      id: this.edges.length,
      vertices: traces.map((t) => t.connection_name!),
      traces,
      cost: Math.max(...traces.map((t) => length(t.route))),
    }
    this.edges.push(edge)
    for (const vertex of edge.vertices) {
      this.vertices.add(vertex)
      const domain = this.domains.get(vertex) ?? []
      domain.push(edge)
      if (domain.length > 80) domain.shift()
      this.domains.set(vertex, domain)
    }
  }
  private excludes(a: RouteHyperedge, b: RouteHyperedge) {
    if (a.vertices.some((v) => b.vertices.includes(v))) return true
    const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`
    if (this.exclusions.has(key)) return this.exclusions.get(key)!
    const hit = a.traces.some((first) =>
      b.traces.some((second) => {
        const p = first.route[0] as Wire,
          q = second.route[0] as Wire
        return (
          p.layer === q.layer &&
          !!this.conflicts.firstConflict(
            first.route,
            second.route,
            (p.width + q.width) / 2 + this.clearance - 1e-8,
          )
        )
      }),
    )
    this.exclusions.set(key, hit)
    return hit
  }
  select(units: string[], _matchingGroups?: string[][]): Trace[] | null {
    if (units.some((v) => !this.domains.has(v))) return null
    const vertices = new Set(
      units.flatMap((v) => this.domains.get(v)![0].vertices),
    )
    const domains = new Map([...vertices].map((v) => [v, this.domains.get(v)!]))
    // Independent copper layers are independent exact-cover components.
    const layers = new Map(
      [...domains].map(([v, edges]) => [
        v,
        new Set(
          edges.flatMap((e) => e.traces.map((t) => (t.route[0] as Wire).layer)),
        ),
      ]),
    )
    const remaining = new Set(vertices)
    const groups: string[][] = []
    while (remaining.size) {
      const group = [remaining.values().next().value!]
      remaining.delete(group[0])
      for (let i = 0; i < group.length; i++)
        for (const v of remaining) {
          if ([...layers.get(v)!].some((l) => layers.get(group[i])!.has(l))) {
            group.push(v)
            remaining.delete(v)
          }
        }
      groups.push(group)
    }
    if (groups.length > 1) {
      const result: Trace[] = []
      for (const group of groups) {
        const selected = this.select(group)
        if (!selected) return null
        result.push(...selected)
      }
      return result
    }
    const key = [...domains.values()]
      .map((es) => es.map((e) => e.id).join(","))
      .join(";")
    if (this.covers.has(key)) return this.covers.get(key)!
    let budget = 3000
    const visit = (
      pending: Map<string, RouteHyperedge[]>,
    ): RouteHyperedge[] | null => {
      if (!pending.size) return []
      if (--budget < 0) return null
      const [, choices] = [...pending].sort(
        (a, b) => a[1].length - b[1].length,
      )[0]
      if (!choices.length) return null
      for (const edge of [...choices].sort((a, b) => a.cost - b.cost)) {
        const next = new Map<string, RouteHyperedge[]>()
        for (const [v, domain] of pending) {
          if (edge.vertices.includes(v)) continue
          next.set(
            v,
            domain.filter((other) => !this.excludes(edge, other)),
          )
        }
        if ([...next.values()].some((d) => !d.length)) continue
        const rest = visit(next)
        if (rest) return [edge, ...rest]
        if (budget < 0) break
      }
      return null
    }
    const result = visit(domains)?.flatMap((e) => e.traces) ?? null
    if (this.covers.size >= 128)
      this.covers.delete(this.covers.keys().next().value!)
    this.covers.set(key, result)
    return result
  }
}

import { distance, segmentDistance } from "./geometry"
import { fixedCopper } from "./vector-scene"
import type { Point, SimpleRouteJson, Trace, Wire } from "./types"

export type CompactionVertex = Point & { group?: number }
type Vertex = CompactionVertex

/** Keep sampled arcs rigid. Flexible banks move matching crests together while
 * their straight legs change length. Nearby differential rail vertices share a
 * displacement; the final coupling validator remains authoritative. */
export function compactionMotionGroups(
  input: SimpleRouteJson,
  traces: Trace[],
  flexible: boolean,
  protectVias: boolean,
  flexiblePairs = false,
): Vertex[][] {
  let groups = 0
  const paired = new Set(
    input.differentialPairs?.flatMap((p) => p.connectionNames),
  )
  const paths: Vertex[][] = traces.map((t) => {
    if (flexible && (flexiblePairs || !paired.has(t.connection_name!))) {
      const curve = new Set(t.curvedSegments ?? []),
        banks: number[][] = []
      for (const k of [...curve].sort((a, b) => a - b)) {
        if (!banks.length || k - banks.at(-1)!.at(-1)! > 4) banks.push([])
        banks.at(-1)!.push(k)
      }
      const runs = banks.map((indices, bi) => {
        const first = indices[0] - 1,
          last = indices.at(-1)!,
          a = t.route[first],
          b = t.route[last],
          span = distance(a, b)
        const n =
          span > 1e-6
            ? { x: -(b.y - a.y) / span, y: (b.x - a.x) / span }
            : { x: 0, y: 1 }
        return { first, last, n, bi }
      })
      const components: number[][] = []
      for (let i = 0; i < t.route.length; i++)
        if (i > 0 && curve.has(i)) components.at(-1)!.push(i)
        else components.push([i])
      const assigned = new Map<number, number | undefined>(),
        keys = new Map<string, number>()
      for (const component of components) {
        let group: number | undefined
        if (!component.includes(0) && !component.includes(t.route.length - 1)) {
          const bank = runs.find(
            (b) => component[0] >= b.first && component.at(-1)! <= b.last,
          )
          const values = bank
            ? component.map(
                (i) => t.route[i].x * bank.n.x + t.route[i].y * bank.n.y,
              )
            : []
          const key =
            bank && component.length > 2
              ? `${bank.bi}:${Math.round(Math.min(...values) * 1e6)}:${Math.round(Math.max(...values) * 1e6)}`
              : `vertex${component[0]}`
          group = keys.get(key)
          if (group === undefined) {
            group = groups++
            keys.set(key, group)
          }
        }
        for (const i of component) assigned.set(i, group)
      }
      return t.route.map((p, i) => ({ ...p, group: assigned.get(i) }))
    }

    const first = Math.min(...(t.curvedSegments ?? [])) - 1,
      last = Math.max(...(t.curvedSegments ?? []))
    const block = groups++
    return t.route.map((p, i) => ({
      ...p,
      group:
        i === 0 ||
        i === t.route.length - 1 ||
        (i >= first &&
          i <= last &&
          (first === 0 || last === t.route.length - 1))
          ? undefined
          : i >= first && i <= last
            ? block
            : groups++,
    }))
  })
  const pinGroups = new Set<number>()
  const terminalCopper = fixedCopper(input).filter(
    (c) => !c.rect && distance(c.a, c.b) < 1e-8,
  )
  for (let ti = 0; protectVias && ti < traces.length; ti++)
    for (const via of terminalCopper) {
      if (!via.owners.includes(traces[ti].connection_name!)) continue
      const path = paths[ti],
        reach =
          via.radius +
          (traces[ti].route[0] as Wire).width / 2 +
          (input.minTraceToPadEdgeClearance ??
            input.defaultObstacleMargin ??
            0.075)
      for (let i = 1; i < path.length; i++)
        if (
          segmentDistance([path[i - 1], path[i]], [via.a, via.b]) <=
          reach + 1e-8
        )
          for (const p of [path[i - 1], path[i]])
            if (p.group !== undefined) pinGroups.add(p.group)
    }
  const roots = Array.from({ length: groups }, (_, i) => i)
  const root = (g: number): number =>
    roots[g] === g ? g : (roots[g] = root(roots[g]))
  const frozen = new Set<number>(pinGroups)
  for (const pair of input.differentialPairs ?? []) {
    const ai = traces.findIndex(
        (t) => t.connection_name === pair.connectionNames[0],
      ),
      bi = traces.findIndex(
        (t) => t.connection_name === pair.connectionNames[1],
      )
    if (ai < 0 || bi < 0) continue
    const reach = (input.minTraceWidth + (pair.traceGap ?? 0.1)) * 1.6
    for (const p of paths[ai])
      for (const q of paths[bi]) {
        if (distance(p, q) > reach) continue
        if (p.group === undefined && q.group !== undefined) frozen.add(q.group)
        else if (q.group === undefined && p.group !== undefined)
          frozen.add(p.group)
        else if (p.group !== undefined && q.group !== undefined)
          roots[root(p.group)] = root(q.group)
      }
  }
  const fixedGroups = new Set([...frozen].map(root))
  for (const path of paths)
    for (const p of path)
      if (p.group !== undefined)
        p.group = fixedGroups.has(root(p.group)) ? undefined : root(p.group)
  return paths
}

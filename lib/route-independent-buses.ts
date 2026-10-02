import { repairGridJogs } from "./repair-grid-jogs"
import { routeCoupledPair } from "./coupled-pair-routing"
import { negotiateLanes } from "./negotiate-lanes"
import type { Copper } from "./vector-scene"
import type { SimpleRouteJson, Trace } from "./types"

/** Independent signal layers can finish their bus before the next layer is
 * searched. Bound each fresh paired topology so a closed package approach
 * cannot consume the entire board's routing budget. */
export function independentBusGroups(
  input: SimpleRouteJson,
): SimpleRouteJson[] | null {
  if ((input.buses?.length ?? 0) < 2) return null
  const constrained = new Set([
    ...(input.buses ?? []).flatMap((b) => b.connectionNames),
    ...(input.differentialPairs ?? []).flatMap((p) => p.connectionNames),
  ])
  if (
    input.connections.some(
      (c) =>
        !constrained.has(c.name) ||
        c.pointsToConnect.some((p) => p.layer !== c.pointsToConnect[0].layer),
    )
  )
    return null
  const layers = [
    ...new Set(input.connections.map((c) => c.pointsToConnect[0].layer)),
  ]
  if (layers.length < 2) return null
  const groups = layers.map((layer) => {
    const connections = input.connections.filter(
      (c) => c.pointsToConnect[0].layer === layer,
    )
    const names = new Set(connections.map((c) => c.name))
    const buses = (input.buses ?? []).filter((b) =>
      b.connectionNames.some((n) => names.has(n)),
    )
    const differentialPairs = (input.differentialPairs ?? []).filter((p) =>
      p.connectionNames.some((n) => names.has(n)),
    )
    if (
      buses.some((b) => b.connectionNames.some((n) => !names.has(n))) ||
      differentialPairs.some((p) =>
        p.connectionNames.some((n) => !names.has(n)),
      ) ||
      differentialPairs.length > 1
    )
      return null
    return { ...input, connections, buses, differentialPairs }
  })
  return groups.every((g) => g !== null) ? (groups as SimpleRouteJson[]) : null
}

export function* routeIndependentBuses(
  groups: SimpleRouteJson[],
  fixed: Copper[],
  widths: Map<string, number>,
  finish: (input: SimpleRouteJson, traces: Trace[]) => Trace[] | null,
): Generator<Trace[], Trace[] | null> {
  const completed: Trace[] = []
  for (const input of groups) {
    const pair = input.differentialPairs?.[0]
    const ordinary = input.connections.filter(
      (c) => !pair?.connectionNames.includes(c.name),
    )
    let solved: Trace[] | null = null
    for (let variant = 0; variant < 6 && !solved; variant++) {
      let paired: Trace[] = []
      if (pair) {
        const search = routeCoupledPair(input, pair, fixed, {
          copper: [],
          penalty: 0,
          variant,
        })
        let state = search.next(),
          steps = 0
        try {
          while (!state.done && steps++ < 12000) {
            yield completed
            state = search.next()
          }
        } finally {
          if (!state.done) search.return(null)
        }
        if (!state.done || !state.value) continue
        paired = state.value
      }
      if (!ordinary.length) {
        solved = finish(input, paired)
        continue
      }
      const search = negotiateLanes(
        input,
        ordinary,
        fixed,
        paired,
        widths,
        undefined,
        new Map(),
        () => false,
      )
      let state = search.next(),
        steps = 0
      try {
        while (!state.done && steps++ < 12000) {
          yield [...completed, ...state.value]
          state = search.next()
        }
      } finally {
        if (!state.done) search.return(null)
      }
      if (state.done && state.value) {
        const repair = repairGridJogs(input, state.value, fixed)
        let repaired = repair.next(),
          repairSteps = 0
        try {
          while (!repaired.done && repairSteps++ < 6000) {
            yield [...completed, ...state.value]
            repaired = repair.next()
          }
        } finally {
          if (!repaired.done) repair.return(false)
        }
        if (!repaired.done || !repaired.value) continue
        solved = finish(input, state.value)
      }
    }
    if (!solved) return null
    completed.push(...solved)
    yield completed
  }
  return completed
}

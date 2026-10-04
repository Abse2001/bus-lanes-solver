import { BusLanesSolver } from "./bus-lanes-solver"
import { negotiateLanes } from "./negotiate-lanes"
import { fixedCopper } from "./vector-scene"
import { signalWidth } from "./repair-bus-dogbones"
import type { SimpleRouteJson, SolverOptions, Trace, Wire } from "./types"

/** Reserve complete short-budget buses before routing groups with more room.
 * Paired corridors and every supplied trace remain hard obstacles throughout.
 * All groups are matched before returning a candidate to the native validator. */
export function* routeBoundedBusGroups(
  input: SimpleRouteJson,
  paired: Trace[],
  layers: ReadonlyMap<string, string[]>,
  options: SolverOptions,
): Generator<void, Trace[] | null> {
  const buses = [...(input.buses ?? [])].sort(
    (a, b) => (a.maxLength ?? Infinity) - (b.maxLength ?? Infinity),
  )
  if (buses.length < 2 || !buses.some((bus) => bus.maxLength !== undefined))
    return null
  const orders = [buses.map((bus) => [bus])]
  if (buses.length > 2)
    orders.push([buses.slice(0, 2), ...buses.slice(2).map((bus) => [bus])])
  for (const groups of orders) {
    const complete: Trace[] = []
    let valid = true
    for (const [index, group] of groups.entries()) {
      const names = new Set(group.flatMap((bus) => bus.connectionNames))
      if (index === groups.length - 1)
        for (const c of input.connections)
          if (!buses.some((bus) => bus.connectionNames.includes(c.name)))
            names.add(c.name)
      const connections = structuredClone(
        input.connections.filter((c) => names.has(c.name)),
      )
      const held = [
        ...complete,
        ...paired.filter(
          (t) =>
            !names.has(t.connection_name!) &&
            !complete.some((c) => c.connection_name === t.connection_name),
        ),
      ]
      const local: SimpleRouteJson = {
        ...input,
        connections,
        buses: group,
        differentialPairs: input.differentialPairs?.filter((pair) =>
          pair.connectionNames.every((n) => names.has(n)),
        ),
        traces: [...(input.traces ?? []), ...held],
      }
      const groupPairs = paired.filter((t) => names.has(t.connection_name!))
      const ordinary = connections.filter(
        (c) => !groupPairs.some((t) => t.connection_name === c.name),
      )
      const search = negotiateLanes(
        local,
        ordinary,
        fixedCopper(local),
        groupPairs,
        new Map(connections.map((c) => [c.name, signalWidth(input, c)])),
        undefined,
        layers,
        () => false,
        true,
        true,
      )
      let step = search.next(),
        iterations = 0
      try {
        while (!step.done && iterations++ < 30000) {
          yield
          step = search.next()
        }
      } finally {
        if (!step.done) search.return(null)
      }
      if (!step.done || !step.value) {
        valid = false
        break
      }
      const routes = step.value
      local.connections = connections.map((c) => {
        const t = routes.find((t) => t.connection_name === c.name)!
        return {
          ...c,
          pointsToConnect: [t.route[0], t.route.at(-1)!] as Wire[],
        }
      })
      const matcher = BusLanesSolver.forRefinement(local, routes, options)
      try {
        while (!matcher.solved && !matcher.failed) {
          matcher.step()
          yield
        }
        if (!matcher.solved) {
          valid = false
          break
        }
        complete.push(...matcher.traces)
      } finally {
        if (!matcher.solved && !matcher.failed) matcher.tryFinalAcceptance()
      }
    }
    if (valid && complete.length === input.connections.length) return complete
  }
  return null
}

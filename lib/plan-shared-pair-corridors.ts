import { maximumCarrierLength } from "./route-lengths"
import { reserveBusPackageExits } from "./reserve-bus-package-exits"
import { routeCoupledPair } from "./coupled-pair-routing"
import { length } from "./geometry"
import { RouteConflictIndex } from "./route-conflict-index"
import { runBoundedRouting } from "./run-bounded-routing"
import { fixedCopper } from "./vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "./types"

interface Choice {
  id: number
  layer: string
  traces: Trace[]
  length: number
  provisional: boolean
}

const provisionalPlans = new WeakSet<Trace[]>()

/** Search policy is transient and is never written into routed copper. */
export function isProvisionalPairPlan(traces: Trace[]): boolean {
  return provisionalPlans.has(traces)
}

/** Grow compatible pair domains together, so a shared-layer pair does not
 * commit to a corridor that cuts through another pair's package approach. */
export function* planSharedPairCorridors(
  input: SimpleRouteJson,
  terminalLayers: ReadonlyMap<string, string[]>,
  freshDogbones = false,
  options: {
    preferPackageOnlyTuning?: boolean
    /** Bound an additional guidance probe without replacing the main search. */
    maxTopologyVariants?: number
  } = {},
): Generator<Trace[] | undefined> {
  const pairs = input.differentialPairs ?? []
  const bounded = input.buses?.some((bus) => bus.maxLength !== undefined)
  const domains: Choice[][] = pairs.map(() => [])
  const geometry = pairs.map(() => new Set<string>())
  const tried = new Set<string>()
  const offeredShapes = new Set<string>()
  const fixed = fixedCopper(input)
  const conflicts = new RouteConflictIndex()
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  const scenes = new Map<string, SimpleRouteJson>()
  let serial = 0
  const collides = (a: Choice, b: Choice) =>
    a.layer === b.layer &&
    a.traces.some((t) =>
      b.traces.some((r) =>
        conflicts.firstConflict(
          t.route,
          r.route,
          ((t.route[0] as Wire).width + (r.route[0] as Wire).width) / 2 +
            clearance -
            1e-8,
        ),
      ),
    )
  const alternatives: (number | readonly [number, number])[] = freshDogbones
    ? [100, 2, 3, 0, 1, 101, 102, 103, 4, 104, 5, 105, 6, 106, 7, 107]
    : [1, 2, [0, 1], [1, 0], 0, [0, 2], [2, 0], 3, [1, 2], [2, 1], 4, 5, 6, 7]
  // Prefer corrections inside package approaches. A secondary provisional
  // shape may still help ordinary lanes connect; final pipeline acceptance
  // independently enforces physical coupling outside those approaches.
  const searches = alternatives
    .slice(0, options.maxTopologyVariants ?? alternatives.length)
    .flatMap((variant) =>
      (freshDogbones && options.preferPackageOnlyTuning
        ? [false, true]
        : [false]
      ).map((allowProvisionalPairTuning) => ({
        variant,
        allowProvisionalPairTuning,
      })),
    )
  function* offerPlans(): Generator<Trace[]> {
    if (bounded)
      for (const choices of domains) choices.sort((a, b) => a.length - b.length)
    const plans: Choice[][] = []
    const visit = (selected: Choice[], index: number) => {
      if (plans.length >= 256) return
      if (index === domains.length) {
        const key = JSON.stringify([
          selected.some((choice) => choice.provisional),
          selected
            .flatMap((choice) => choice.traces)
            .map((trace) => trace.route),
        ])
        if (!tried.has(key)) plans.push(selected)
        return
      }
      for (const choice of domains[index])
        if (!selected.some((other) => collides(choice, other)))
          visit([...selected, choice], index + 1)
    }
    visit([], 0)
    const busNames = new Set(input.buses?.flatMap((bus) => bus.connectionNames))
    const pairNames = new Set(pairs.flatMap((pair) => pair.connectionNames))
    const costs = new Map(
      plans.map((plan) => [
        plan,
        freshDogbones
          ? input.connections
              .filter((c) => busNames.has(c.name) && !pairNames.has(c.name))
              .reduce(
                (sum, c) =>
                  sum +
                  plan
                    .filter(
                      (choice) => choice.layer === c.pointsToConnect[0].layer,
                    )
                    .flatMap((choice) => choice.traces)
                    .filter((trace) =>
                      conflicts.firstConflict(
                        c.pointsToConnect,
                        trace.route,
                        ((trace.route[0] as Wire).width + input.minTraceWidth) /
                          2 +
                          clearance -
                          1e-8,
                      ),
                    ).length,
                0,
              )
          : 0,
      ]),
    )
    const shapeKey = (plan: Choice[]) =>
      JSON.stringify(
        plan.flatMap((choice) => choice.traces).map((trace) => trace.route),
      )
    plans.sort(
      (a, b) =>
        Number(offeredShapes.has(shapeKey(a))) -
          Number(offeredShapes.has(shapeKey(b))) ||
        costs.get(a)! - costs.get(b)! ||
        a.reduce((sum, c) => sum + c.length, 0) -
          b.reduce((sum, c) => sum + c.length, 0),
    )
    for (const plan of plans) {
      const traces = plan.flatMap((choice) => choice.traces)
      const provisional = plan.some((choice) => choice.provisional)
      const key = JSON.stringify([
        provisional,
        traces.map((trace) => trace.route),
      ])
      if (tried.has(key)) continue
      tried.add(key)
      offeredShapes.add(shapeKey(plan))
      if (provisional) provisionalPlans.add(traces)
      yield traces
    }
  }
  for (const { variant, allowProvisionalPairTuning } of searches) {
    function* growDomain(
      index: number,
      pair: NonNullable<SimpleRouteJson["differentialPairs"]>[number],
      layer: string,
    ): Generator<Trace[] | undefined> {
      const reserved = typeof variant === "number" && variant >= 100
      const sceneKey = JSON.stringify([index, layer, reserved])
      const local = scenes.get(sceneKey) ?? {
        ...input,
        connections: input.connections.map((c) =>
          pair.connectionNames.includes(c.name)
            ? {
                ...c,
                pointsToConnect: c.pointsToConnect.map((p) => ({
                  ...p,
                  layer,
                })),
              }
            : c,
        ),
      }
      scenes.set(sceneKey, local)
      const search = runBoundedRouting(
        routeCoupledPair(
          local,
          pair,
          reserved ? [...fixed, ...reserveBusPackageExits(local, pair)] : fixed,
          {
            copper: [],
            penalty: 0,
            preferPackageOnlyTuning: options.preferPackageOnlyTuning,
            allowProvisionalPairTuning,
            ...(typeof variant === "number"
              ? { variant: reserved ? variant - 100 : variant }
              : { handoffOffsets: variant }),
          },
        ),
        6000,
      )
      let state = search.next()
      try {
        while (!state.done) {
          yield undefined
          state = search.next()
        }
      } finally {
        if (!state.done) search.return(null)
      }
      if (!state.value) return
      if (
        bounded &&
        state.value.some(
          (trace) =>
            length(trace.route) >
            maximumCarrierLength(input, trace.connection_name!) + 1e-7,
        )
      )
        return
      const key = JSON.stringify([
        allowProvisionalPairTuning,
        state.value.map((t) => t.route),
      ])
      if (geometry[index].has(key)) return
      geometry[index].add(key)
      domains[index].push({
        id: serial++,
        layer,
        provisional: allowProvisionalPairTuning,
        traces: state.value,
        length: state.value.reduce((sum, t) => sum + length(t.route), 0),
      })
      // A completed compatible tuple must not wait for an unrelated slow
      // carrier search. Fresh plans stay cancellable and resume the full
      // remaining domain stream when their caller needs another candidate.
      if (freshDogbones) yield* offerPlans()
    }
    const jobs = pairs.flatMap((pair, index) => {
      const members = pair.connectionNames.map(
        (name) => input.connections.find((c) => c.name === name)!,
      )
      const layers = terminalLayers
        .get(members[0].name)
        ?.filter((layer) =>
          members.every((c) => terminalLayers.get(c.name)?.includes(layer)),
        ) ?? [members[0].pointsToConnect[0].layer]
      return layers
        .filter(
          (layer) =>
            !input.allowedLayers || input.allowedLayers.includes(layer),
        )
        .map((layer) => growDomain(index, pair, layer))
    })
    if (freshDogbones) {
      // Advance compatible carriers cooperatively in preferred order. A slow
      // preferred layer for one pair must not consume its entire local budget
      // before the other pairs and an available alternate carrier can finish.
      const pending = new Set(jobs)
      try {
        while (pending.size)
          for (const job of pending) {
            const state = job.next()
            if (state.done) pending.delete(job)
            else yield state.value
          }
      } finally {
        for (const job of pending) job.return(undefined)
      }
    } else {
      for (const job of jobs) yield* job
    }
    // With no pair domains, retain the ordinary-only empty seed.
    if (!freshDogbones || !pairs.length) yield* offerPlans()
  }
}

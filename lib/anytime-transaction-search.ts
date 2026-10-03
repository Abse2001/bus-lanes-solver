import { compactTuningCandidates } from "./anytime-candidates"
import { jointTuningCandidates } from "./anytime-joint-tuning"
import { pairTopologyCandidates } from "./anytime-pair-topology"
import {
  stripCollapseCandidates,
  type AnytimeStripCollapseProposal,
} from "./anytime-strip-collapse"
import {
  recoverAnytimeSkeleton,
  skeletonDriverPriorities,
  skeletonShortcutCandidates,
} from "./anytime-skeleton"
import {
  anytimeMatchingCohort,
  searchAnytimeTopology,
} from "./anytime-topology-search"
import { routeAnglesAreConventional } from "./route-angle-validation"
import { fixedCopper, VectorScene } from "./vector-scene"
import type { SimpleRouteJson, Trace, Wire } from "./types"

/** Each operator and electrical cohort receives work from the first round.
 * Expensive searches yield after bounded chunks, rather than monopolizing an
 * effort preset behind thousands of variations of the first tuning bank. */
function* interleave<T>(
  streams: Generator<T | undefined>[],
  quotas: number[] = streams.map(() => 1),
) {
  const active = streams.map((stream, i) => ({ stream, quota: quotas[i] ?? 1 }))
  try {
    while (active.length) {
      for (let i = 0; i < active.length; ) {
        const current = active[i]
        let done = false
        for (let chunk = 0; chunk < current.quota; chunk++) {
          const next = current.stream.next()
          if (next.done) {
            done = true
            break
          }
          yield next.value
        }
        if (done) active.splice(i, 1)
        else i++
      }
    }
  } finally {
    for (const { stream } of active) stream.return(undefined as never)
  }
}

function* limitedSolutions<T>(stream: Generator<T | undefined>, limit = 8) {
  let complete = 0
  try {
    for (const candidate of stream) {
      yield candidate
      if (candidate !== undefined && ++complete >= limit) return
    }
  } finally {
    stream.return(undefined as never)
  }
}

function geometricallyPossible(input: SimpleRouteJson, traces: Trace[]) {
  if (!routeAnglesAreConventional(traces)) return false
  // Other lanes are unfinished scratch geometry and may need to leave these
  // chords during simultaneous allocation. Only immutable copper can prune a
  // partial transaction; full inter-lane checks follow joint reconstruction.
  const copper = fixedCopper(input)
  return traces.every((trace) => {
    const connection = input.connections.find(
      (c) => c.name === trace.connection_name,
    )!
    const scene = new VectorScene(
      input,
      connection,
      (trace.route[0] as Wire).width,
      copper,
    )
    return scene.pathVisible(trace.route)
  })
}

function* cohortTransactions(input: SimpleRouteJson, incumbent: Trace[]) {
  const recovered = recoverAnytimeSkeleton(input, incumbent)
  const tune = (scratch: Trace[]) =>
    interleave(
      [1, 0.5, 0].map((fraction) =>
        limitedSolutions(
          jointTuningCandidates(input, scratch, {
            banks: recovered.pockets,
            preservedTraces: incumbent,
            targetSkewFractions: [fraction],
            pairedTargetModes: ["minimum"],
            maxCandidates: 4096,
            maxPlacementsPerGroup: 64,
            validateSelfClear: false,
          }),
        ),
      ),
      [4, 2, 2],
    )
  function* shortcuts(): Generator<Trace[] | undefined> {
    for (const scratch of skeletonShortcutCandidates(input, recovered.traces, {
      maxCandidates: 128,
      maxWindowsPerTrace: 12,
    })) {
      if (!scratch || !geometricallyPossible(input, scratch)) {
        yield undefined
        continue
      }
      yield* tune(scratch)
    }
  }
  function* topology(): Generator<Trace[] | undefined> {
    for (const proposal of searchAnytimeTopology(input, recovered.traces, {
      maxTargets: 12,
      maxTransactions: 96,
      maxProposals: 24,
      maxSearchExpansions: 30_000,
      beamWidth: 4,
    })) {
      if (!proposal) yield undefined
      else yield* tune(proposal.traces)
    }
  }
  function* pairedTopology(): Generator<Trace[] | undefined> {
    for (const scratch of pairTopologyCandidates(input, recovered.traces, {
      maxCandidates: 512,
      validateSelfClear: false,
    })) {
      if (!scratch) yield undefined
      else yield* tune(scratch)
    }
  }
  yield* interleave(
    [
      tune(recovered.traces),
      shortcuts(),
      topology(),
      pairedTopology(),
      compactTuningCandidates(input, incumbent, {
        maxCandidates: 128,
        validateSelfClear: false,
      }),
    ],
    [4, 2, 8, 4, 1],
  )
}

/** Routes in the same overlapping bus/pair component are reconstructed as one
 * transaction. Unrelated carriers are immutable scene obstacles. Search states
 * may be unmatched or longer internally; only the caller's strictly validated
 * complete, better result can become the public incumbent. */
export function* anytimeTransactionCandidates(
  input: SimpleRouteJson,
  traces: Trace[],
): Generator<Trace[] | undefined> {
  const visited = new Set<string>()
  const streams: Generator<Trace[] | undefined>[] = []
  const quotas: number[] = []
  function* reconstructCollapse(
    proposal: AnytimeStripCollapseProposal,
  ): Generator<Trace[] | undefined> {
    const names = new Set(anytimeMatchingCohort(input, proposal.changedNames))
    const selected = proposal.traces.filter((t) =>
      names.has(t.connection_name!),
    )
    const activeInput: SimpleRouteJson = {
      ...input,
      traces: [
        ...(input.traces ?? []),
        ...traces
          .filter((t) => !names.has(t.connection_name!))
          .map((t) => ({ ...t, source_trace_id: undefined })),
      ],
      connections: input.connections.filter((c) => names.has(c.name)),
      buses: input.buses?.filter((b) =>
        b.connectionNames.every((n) => names.has(n)),
      ),
      differentialPairs: input.differentialPairs?.filter((p) =>
        p.connectionNames.every((n) => names.has(n)),
      ),
    }
    const recovered = recoverAnytimeSkeleton(activeInput, selected)
    const modes = [
      { mode: "known_pockets", reserved: true },
      { mode: "known_pockets", reserved: false },
      { mode: "minimum", reserved: false },
      { mode: "preserve", reserved: false },
    ] as const
    for (const complete of interleave(
      modes.map(({ mode, reserved }) =>
        limitedSolutions(
          jointTuningCandidates(activeInput, recovered.traces, {
            banks: recovered.pockets,
            preservedTraces: selected,
            targetSkewFractions: [1],
            pairedTargetModes: [mode],
            reserveFutureBanks: reserved,
            maxCandidates: 4096,
            maxPlacementsPerGroup: 64,
            validateSelfClear: true,
          }),
        ),
      ),
      [4, 4, 1, 1],
    )) {
      if (!complete) yield undefined
      else {
        const changed = new Map(complete.map((t) => [t.connection_name, t]))
        yield traces.map((t) => changed.get(t.connection_name) ?? t)
      }
    }
  }
  function* collapseStrips(): Generator<Trace[] | undefined> {
    const proposals = stripCollapseCandidates(input, traces)
    const active: Generator<Trace[] | undefined>[] = []
    let discovered = false
    try {
      while (!discovered || active.length) {
        // A difficult maximal contraction must not starve feasible smaller
        // cuts. Retain a bounded beam of area-ranked matching transactions.
        while (!discovered && active.length < 8) {
          const next = proposals.next()
          if (next.done) {
            discovered = true
            break
          }
          if (!next.value) {
            yield undefined
            continue
          }
          yield next.value.traces
          active.push(reconstructCollapse(next.value))
        }
        for (let i = 0; i < active.length; ) {
          let done = false
          for (let chunk = 0; chunk < 8; chunk++) {
            const next = active[i].next()
            if (next.done) {
              done = true
              break
            }
            yield next.value
          }
          if (done) active.splice(i, 1)
          else i++
        }
      }
    } finally {
      proposals.return(undefined as never)
      for (const stream of active) stream.return(undefined as never)
    }
  }
  streams.push(collapseStrips())
  quotas.push(32)
  // A bus's shorter corridor can be blocked by a different bus or an
  // unconstrained control net. Keep a global transaction branch alongside the
  // cheap cohort branches so the optimizer can cross that partition too.
  const globalSkeleton = recoverAnytimeSkeleton(input, traces)
  function* globalTransactions(): Generator<Trace[] | undefined> {
    for (const proposal of searchAnytimeTopology(input, globalSkeleton.traces, {
      maxTargets: 4,
      maxTransactions: 192,
      maxProposals: 32,
      maxSearchExpansions: 30_000,
      beamWidth: 6,
      repackChunksPerRound: 16,
    })) {
      if (!proposal) yield undefined
      else {
        const names = new Set(proposal.retuneNames)
        const selected = proposal.traces.filter((t) =>
          names.has(t.connection_name!),
        )
        const activeInput: SimpleRouteJson = {
          ...input,
          traces: [
            ...(input.traces ?? []),
            ...traces
              .filter((t) => !names.has(t.connection_name!))
              .map((t) => ({ ...t, source_trace_id: undefined })),
          ],
          connections: input.connections.filter((c) => names.has(c.name)),
          buses: input.buses?.filter((b) =>
            b.connectionNames.every((n) => names.has(n)),
          ),
          differentialPairs: input.differentialPairs?.filter((p) =>
            p.connectionNames.every((n) => names.has(n)),
          ),
        }
        for (const complete of limitedSolutions(
          jointTuningCandidates(activeInput, selected, {
            banks: globalSkeleton.pockets,
            preservedTraces: traces,
            targetSkewFractions: [1],
            pairedTargetModes: ["minimum"],
            maxCandidates: 4096,
            maxPlacementsPerGroup: 64,
            validateSelfClear: false,
          }),
        )) {
          if (!complete) yield undefined
          else {
            const changed = new Map(complete.map((t) => [t.connection_name, t]))
            yield traces.map((t) => changed.get(t.connection_name) ?? t)
          }
        }
      }
    }
  }
  streams.push(globalTransactions())
  quotas.push(24)
  for (const index of skeletonDriverPriorities(input, traces)) {
    const name = traces[index].connection_name!
    if (visited.has(name)) continue
    const names = new Set(anytimeMatchingCohort(input, [name]))
    for (const member of names) visited.add(member)
    const selected = traces.filter((t) => names.has(t.connection_name!))
    const cohortInput: SimpleRouteJson = {
      ...input,
      traces: [
        ...(input.traces ?? []),
        ...traces
          .filter((t) => !names.has(t.connection_name!))
          .map((t) => ({ ...t, source_trace_id: undefined })),
      ],
      connections: input.connections.filter((c) => names.has(c.name)),
      buses: input.buses?.filter((b) =>
        b.connectionNames.every((n) => names.has(n)),
      ),
      differentialPairs: input.differentialPairs?.filter((p) =>
        p.connectionNames.every((n) => names.has(n)),
      ),
    }
    function* stream(): Generator<Trace[] | undefined> {
      for (const candidate of cohortTransactions(cohortInput, selected)) {
        if (!candidate) {
          yield undefined
          continue
        }
        const changed = new Map(candidate.map((t) => [t.connection_name, t]))
        yield traces.map((t) => changed.get(t.connection_name) ?? t)
      }
    }
    streams.push(stream())
    quotas.push(Math.min(8, selected.length))
  }
  yield* interleave(streams, quotas)
}

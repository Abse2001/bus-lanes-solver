import {
  pruneCandidateDomains,
  type CandidateDomainFailure,
} from "./prune-candidate-domains"

/** Select one mutually compatible candidate per connection. Arc consistency
 * runs before bounded backtracking; returned references keep the input order. */
export function solveSignalCandidatePool<T>(
  domains: readonly (readonly T[])[],
  compatible: (first: T, second: T) => boolean,
  maxSearchNodes = 4000,
  maxSupportChecks = 1_000_000,
  onArcEmptyDomain?: (failure: CandidateDomainFailure) => void,
): T[] | null {
  const initial = onArcEmptyDomain
    ? pruneCandidateDomains(
        domains,
        compatible,
        maxSupportChecks,
        onArcEmptyDomain,
      )
    : pruneCandidateDomains(domains, compatible, maxSupportChecks)
  if (!initial) return null
  let nodes = 0
  const selected: T[] = new Array(initial.length)
  const assigned = new Uint8Array(initial.length)
  const visit = (remaining: T[][]): T[] | null => {
    if (++nodes > maxSearchNodes) return null
    let next = -1
    for (let index = 0; index < remaining.length; index++) {
      if (assigned[index]) continue
      if (!remaining[index].length) return null
      if (next < 0 || remaining[index].length < remaining[next].length)
        next = index
    }
    if (next < 0) return selected.slice()
    for (const candidate of remaining[next]) {
      selected[next] = candidate
      assigned[next] = 1
      const filtered = remaining.map((domain, index) =>
        assigned[index]
          ? domain
          : domain.filter((other) => compatible(candidate, other)),
      )
      const answer = filtered.some(
        (domain, index) => !assigned[index] && !domain.length,
      )
        ? null
        : visit(filtered)
      if (answer) return answer
      assigned[next] = 0
      if (nodes >= maxSearchNodes) break
    }
    return null
  }
  return visit(initial)
}

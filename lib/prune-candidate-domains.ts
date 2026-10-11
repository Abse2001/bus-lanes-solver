export interface CandidateDomainRemoval {
  first: number
  second: number
  /** Indices refer to the original, complete input domains. */
  removed: number[]
  support: number[]
}

export interface CandidateDomainFailure {
  emptyDomain: number
  unsupportedBy: number
  removals: CandidateDomainRemoval[]
  implicatedRemovals: CandidateDomainRemoval[]
}

/** Remove alternatives that have no compatible support in another domain.
 * Every removal is sound; reaching the work bound leaves the remaining domains
 * available to the ordinary constraint search. Compatibility must be symmetric;
 * domain order and candidate references survive. */
export function pruneCandidateDomains<T>(
  input: readonly (readonly T[])[],
  compatible: (first: T, second: T) => boolean,
  maxSupportChecks = 1_000_000,
  onEmptyDomain?: (failure: CandidateDomainFailure) => void,
): T[][] | null {
  const domains = input.map((domain) => [...domain])
  if (domains.some((domain) => !domain.length)) return null
  const count = domains.length
  const queue: Array<[number, number]> = []
  const queued = new Uint8Array(count * count)
  const enqueue = (first: number, second: number) => {
    const key = first * count + second
    if (first !== second && !queued[key]) {
      queued[key] = 1
      queue.push([first, second])
    }
  }
  for (let first = 0; first < count; first++)
    for (let second = 0; second < count; second++) enqueue(first, second)
  // Small support domains expose impossible alternatives before larger ones.
  queue.sort((a, b) => domains[a[1]].length - domains[b[1]].length)
  const removals: CandidateDomainRemoval[] = []
  let checks = 0
  for (let head = 0; head < queue.length; head++) {
    const [first, second] = queue[head]
    queued[first * count + second] = 0
    const retained: T[] = []
    for (const candidate of domains[first]) {
      let supported = false
      for (const support of domains[second]) {
        if (checks >= maxSupportChecks) return domains
        checks++
        if (compatible(candidate, support)) {
          supported = true
          break
        }
      }
      if (supported) retained.push(candidate)
    }
    if (retained.length === domains[first].length) continue
    if (onEmptyDomain) {
      const removed = new Set(
        domains[first].filter((candidate) => !retained.includes(candidate)),
      )
      const support = new Set(domains[second])
      removals.push({
        first,
        second,
        removed: input[first].flatMap((candidate, index) =>
          removed.has(candidate) ? [index] : [],
        ),
        support: input[second].flatMap((candidate, index) =>
          support.has(candidate) ? [index] : [],
        ),
      })
    }
    domains[first] = retained
    if (!retained.length) {
      if (onEmptyDomain) {
        const implicated = new Set<number>()
        const visit = (index: number) => {
          if (implicated.has(index)) return
          implicated.add(index)
          const removal = removals[index]
          for (let previous = 0; previous < index; previous++)
            if (
              removals[previous].first === removal.first ||
              removals[previous].first === removal.second
            )
              visit(previous)
        }
        visit(removals.length - 1)
        onEmptyDomain({
          emptyDomain: first,
          unsupportedBy: second,
          removals,
          implicatedRemovals: [...implicated]
            .sort((a, b) => a - b)
            .map((index) => removals[index]),
        })
      }
      return null
    }
    // Only support in the revised domain changed. Revisit those incoming arcs.
    for (let other = 0; other < count; other++)
      if (other !== second) enqueue(other, first)
  }
  return domains
}

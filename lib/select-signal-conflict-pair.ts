export interface SignalConflictPair {
  indices: [number, number]
  /** True only when every candidate combination was checked without support. */
  unsupported: boolean
  /** Existence count, capped at one; zero can also mean the budget ran out. */
  supports: number
}

/** Rank current conflicts that may benefit from a forced compatible alternative.
 * Check small domains first, then prioritize certified unsupported pairs. A
 * bounded or incomplete support scan never certifies a pair as unsupported.
 * This proposes negotiation work; it does not accept or alter any route. */
export function rankSignalConflictPairs<T>(
  domains: readonly (readonly T[])[],
  current: readonly T[],
  compatible: (first: T, second: T) => boolean,
  maxSupportChecks = 10000,
): SignalConflictPair[] {
  const pairs: SignalConflictPair[] = []
  for (let first = 0; first < current.length; first++)
    for (let second = first + 1; second < current.length; second++)
      if (!compatible(current[first], current[second]))
        pairs.push({
          indices: [first, second],
          unsupported: false,
          supports: 0,
        })
  const byDomainSize = (
    first: SignalConflictPair,
    second: SignalConflictPair,
  ) => {
    const sizes = (pair: SignalConflictPair) =>
      pair.indices.map((index) => domains[index].length)
    const a = sizes(first),
      b = sizes(second)
    return (
      Math.min(...a) - Math.min(...b) ||
      a[0] * a[1] - b[0] * b[1] ||
      first.indices[0] - second.indices[0] ||
      first.indices[1] - second.indices[1]
    )
  }
  pairs.sort(byDomainSize)
  const budget = Number.isFinite(maxSupportChecks)
    ? Math.max(0, Math.floor(maxSupportChecks))
    : 10000
  let checks = 0
  for (const pair of pairs) {
    const [first, second] = pair.indices
    let complete = true
    scan: for (const a of domains[first])
      for (const b of domains[second]) {
        if (checks >= budget) {
          complete = false
          break scan
        }
        checks++
        if (compatible(a, b)) {
          pair.supports = 1
          break scan
        }
      }
    pair.unsupported = complete && !pair.supports
  }
  return pairs.sort(
    (first, second) =>
      Number(second.unsupported) - Number(first.unsupported) ||
      byDomainSize(first, second),
  )
}

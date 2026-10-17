/** Improve a complete provisional assignment without accepting it as a route.
 * Each coordinate change strictly reduces the number of conflicting pairs;
 * unresolved pairs still require negotiation and final physical validation.
 * Candidate references and connection order are preserved. */
export function minimizeSignalCandidateConflicts<T>(
  domains: readonly (readonly T[])[],
  current: readonly T[],
  compatible: (first: T, second: T) => boolean,
  maxPasses = 4,
): T[] {
  const selected = [...current]
  if (maxPasses <= 0) return selected
  const counts = new Uint32Array(selected.length)
  for (let first = 0; first < selected.length; first++)
    for (let second = first + 1; second < selected.length; second++)
      if (!compatible(selected[first], selected[second])) {
        counts[first]++
        counts[second]++
      }
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false
    for (let index = 0; index < selected.length; index++) {
      if (!counts[index]) continue
      const previous = selected[index]
      let best = previous,
        bestCount = counts[index]
      for (const candidate of domains[index]) {
        if (candidate === previous) continue
        let count = 0
        for (let other = 0; other < selected.length; other++) {
          if (other !== index && !compatible(candidate, selected[other]))
            count++
          // Equal-cost replacements cannot reduce the complete conflict graph.
          if (count >= bestCount) break
        }
        if (count < bestCount) {
          best = candidate
          bestCount = count
        }
        if (!bestCount) break
      }
      if (best === previous) continue
      for (let other = 0; other < selected.length; other++) {
        if (other === index) continue
        const before = !compatible(previous, selected[other]),
          after = !compatible(best, selected[other])
        if (before && !after) counts[other]--
        else if (!before && after) counts[other]++
      }
      selected[index] = best
      counts[index] = bestCount
      changed = true
    }
    if (!changed) break
  }
  return selected
}

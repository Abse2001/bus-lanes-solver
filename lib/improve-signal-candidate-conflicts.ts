export interface CandidateConflictImprovementOptions {
  /** Coordinate updates, including bounded equal-conflict plateau moves. */
  maxMoves?: number
  maxPairChecks?: number
  maxCompatibilityChecks?: number
  maxPlateauMoves?: number
  /** Return a different equal-conflict assignment when no strict gain exists. */
  returnPlateauChanges?: boolean
}

/** Improve a provisional assignment with single and simultaneous two-net moves.
 * A pair may include a currently clear net whose alternative frees a contested
 * site. Equal-conflict moves visit distinct assignments and can unlock a later
 * strict gain; the returned assignment never has more conflicts than current.
 * Compatibility remains the caller's complete physical predicate. This helper
 * does not accept an unresolved assignment as routed or change any domains. */
export function improveSignalCandidateConflicts<T>(
  domains: readonly (readonly T[])[],
  current: readonly T[],
  compatible: (first: T, second: T) => boolean,
  options: CandidateConflictImprovementOptions = {},
): T[] {
  const selected = [...current],
    count = selected.length,
    maxMoves = Math.max(0, Math.floor(options.maxMoves ?? 12)),
    maxPairChecks = Math.max(0, Math.floor(options.maxPairChecks ?? 50_000)),
    maxChecks = Math.max(
      0,
      Math.floor(options.maxCompatibilityChecks ?? 250_000),
    ),
    maxPlateauMoves = Math.max(0, Math.floor(options.maxPlateauMoves ?? 4))
  let best = selected.slice(),
    bestCount = Infinity,
    checks = 0,
    pairChecks = 0,
    plateauMoves = 0
  if (!maxMoves || domains.length !== count) return best
  const budget = Symbol("candidate optimization work budget")
  const clear = (first: T, second: T) => {
    if (checks++ >= maxChecks) throw budget
    return compatible(first, second)
  }
  const ids = new Map<T, number>()
  const id = (candidate: T) => {
    let value = ids.get(candidate)
    if (value === undefined) {
      value = ids.size
      ids.set(candidate, value)
    }
    return value
  }
  const key = (first = -1, a?: T, second = -1, b?: T) =>
    selected
      .map((value, at) => id(at === first ? a! : at === second ? b! : value))
      .join(":")
  const visited = new Set([key()])
  type Choice = { value: T; hits: Uint8Array; count: number }
  type Update = { first: number; a: T; second: number; b: T; delta: number }
  try {
    for (let move = 0; move < maxMoves; move++) {
      const hits = new Uint8Array(count * count),
        counts = new Uint32Array(count)
      let total = 0
      for (let first = 0; first < count; first++)
        for (let second = first + 1; second < count; second++)
          if (!clear(selected[first], selected[second])) {
            hits[first * count + second] = hits[second * count + first] = 1
            counts[first]++
            counts[second]++
            total++
          }
      if (
        total < bestCount ||
        (total === bestCount && options.returnPlateauChanges)
      ) {
        bestCount = total
        best = selected.slice()
      }
      if (!total) return best
      const views = new Map<number, Choice[]>()
      const choices = (index: number) => {
        let result = views.get(index)
        if (result) return result
        result = [
          {
            value: selected[index],
            hits: hits.subarray(index * count, (index + 1) * count),
            count: counts[index],
          },
        ]
        const seen = new Set<T>([selected[index]])
        for (const candidate of domains[index]) {
          if (seen.has(candidate)) continue
          seen.add(candidate)
          const otherHits = new Uint8Array(count)
          let otherCount = 0
          for (let other = 0; other < count; other++)
            if (other !== index && !clear(candidate, selected[other])) {
              otherHits[other] = 1
              otherCount++
            }
          result.push({ value: candidate, hits: otherHits, count: otherCount })
        }
        views.set(index, result)
        return result
      }
      const order = Array.from({ length: count }, (_, at) => at).sort(
        (a, b) => counts[b] - counts[a] || a - b,
      )
      let update: Update | undefined
      // Cheap strict single-net gains precede pair enumeration.
      for (const first of order) {
        if (!counts[first]) continue
        for (const choice of choices(first))
          if (choice.count < counts[first]) {
            update = {
              first,
              a: choice.value,
              second: first,
              b: choice.value,
              delta: choice.count - counts[first],
            }
            break
          }
        if (update) break
      }
      if (!update) {
        const pairs: Array<[number, number]> = []
        for (let first = 0; first < count; first++)
          for (let second = first + 1; second < count; second++)
            if (counts[first] || counts[second]) pairs.push([first, second])
        pairs.sort(
          (a, b) =>
            hits[b[0] * count + b[1]] - hits[a[0] * count + a[1]] ||
            counts[b[0]] + counts[b[1]] - counts[a[0]] - counts[a[1]],
        )
        let plateau: Update | undefined
        pairSearch: for (const [first, second] of pairs) {
          const before =
            counts[first] + counts[second] - hits[first * count + second]
          for (const a of choices(first))
            for (const b of choices(second)) {
              if (a.value === selected[first] && b.value === selected[second])
                continue
              if (pairChecks++ >= maxPairChecks) break pairSearch
              // Outside-net contributions are cached for each alternative.
              const outside = a.count - a.hits[second] + b.count - b.hits[first]
              if (outside > before) continue
              const after = outside + (clear(a.value, b.value) ? 0 : 1),
                delta = after - before
              if (delta > 0) continue
              if (delta < 0) {
                update = { first, a: a.value, second, b: b.value, delta }
                break pairSearch
              }
              if (
                !plateau &&
                plateauMoves < maxPlateauMoves &&
                !visited.has(key(first, a.value, second, b.value))
              )
                plateau = { first, a: a.value, second, b: b.value, delta }
            }
        }
        update ??= plateau
      }
      if (!update) break
      selected[update.first] = update.a
      selected[update.second] = update.b
      visited.add(key())
      if (!update.delta) plateauMoves++
      const nextCount = total + update.delta
      if (
        nextCount < bestCount ||
        (nextCount === bestCount && options.returnPlateauChanges)
      ) {
        best = selected.slice()
        bestCount = nextCount
      }
    }
  } catch (error) {
    if (error !== budget) throw error
  }
  return best
}

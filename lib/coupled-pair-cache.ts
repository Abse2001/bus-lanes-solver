import type { Copper } from "./vector-scene"
import type { SimpleRouteJson, Trace } from "./types"

export interface CoupledPairAlternative {
  traces: Trace[] | null
  score: number
  /** Stops this handoff search; the chosen minimum-score route may still need tuning. */
  hasMatchedAlternative: boolean
  countsAttempt: boolean
}

const requestCaches = new WeakMap<
  SimpleRouteJson,
  { scene: string; alternatives: Map<string, CoupledPairAlternative> }
>()

/** Transient computed alternatives, never saved board geometry. Include all
 * effective scene data so a changed terminal, layer, rule or copper invalidates
 * previous work. Empty-soft-copper retries revisit many identical handoffs. */
export function coupledPairCache(input: SimpleRouteJson, fixed: Copper[]) {
  const scene = JSON.stringify([input, fixed])
  let cache = requestCaches.get(input)
  if (!cache || cache.scene !== scene) {
    cache = { scene, alternatives: new Map() }
    requestCaches.set(input, cache)
  }
  return {
    get(key: string) {
      const alternative = cache.alternatives.get(key)
      return alternative ? structuredClone(alternative) : undefined
    },
    set(key: string, alternative: CoupledPairAlternative) {
      if (cache.alternatives.size >= 512)
        cache.alternatives.delete(cache.alternatives.keys().next().value!)
      cache.alternatives.set(key, structuredClone(alternative))
    },
  }
}

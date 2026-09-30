import { connectors } from "./vector-visibility"
import { distance, length, simplify } from "./geometry"
import { tuningPathIsSelfClear } from "./length-tuning"
import type { Point } from "./types"
import type { VectorScene } from "./vector-scene"

/** Clearance-aware shortening before length tuning. Board-world mm, +X right,
 * +Y up. Never run on sampled meanders or one rail of an already coupled pair. */
export function reduceOrdinaryTurns(path: Point[], scene: VectorScene) {
  let result = simplify(path)
  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    for (let i = 0; i < result.length - 2; i++) {
      for (let j = result.length - 1; j > i + 1; j--) {
        const old = length(result.slice(i, j + 1))
        const candidates = connectors(result[i], result[j]).sort(
          (a, b) => length(a) - length(b) || a.length - b.length,
        )
        let accepted = false
        for (const replacement of candidates) {
          if (
            length(replacement) > old + 1e-8 ||
            replacement.length >= j - i + 1 ||
            !scene.pathVisible(replacement)
          )
            continue
          const candidate = simplify([
            ...result.slice(0, i),
            ...replacement,
            ...result.slice(j + 1),
          ])
          const required = scene.width / 2 + scene.margin
          // A raster path may contain several tiny returning jogs. Repair them
          // progressively; requiring the entire path to be clean after the first
          // shortcut prevents either independent jog from being removed.
          if (
            !tuningPathIsSelfClear(candidate, required) &&
            tuningPathIsSelfClear(result, required)
          )
            continue
          result = candidate
          changed = true
          accepted = true
          break
        }
        if (accepted) break
      }
    }
    if (!changed) break
  }
  return tuningPathIsSelfClear(result, scene.width / 2 + scene.margin)
    ? result
    : path
}

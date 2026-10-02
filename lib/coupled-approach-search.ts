import { GridVisibilitySearch } from "./grid-visibility"
import type { Point, SimpleRouteJson } from "./types"
import type { Copper, VectorScene } from "./vector-scene"

type GridOptions = ConstructorParameters<typeof GridVisibilitySearch>[6]
type Answer = { path: Point[] | null; iterations: number; bytes: number }

/** Pair escape permutations revisit identical bounded searches. Reuse only
 * geometry computed during this routing request, retaining the same yields
 * so search budgets and debugger iteration boundaries remain unchanged. */
export class CoupledApproachSearch {
  private answers = new Map<string, Answer>()
  private bytes = 0
  private readonly maxBytes = 16 * 1024 * 1024;

  *route(
    scene: VectorScene,
    start: Point,
    end: Point,
    budget: number,
    grid?: GridOptions,
    soft: Copper[] = [],
    penalty?: number,
    history?: Float32Array,
  ): Generator<void, Point[] | null> {
    // Negotiated costs are mutable. Only hard-clear approaches are memoized.
    const bounds = grid?.bounds
    const stepSize = grid?.step
    // End attachments and every searched edge stay within this local grid.
    // Omit distant copper from the key so changing the far end of a paired
    // corridor does not invalidate an identical package approach.
    const localCopper =
      bounds && stepSize
        ? scene.copper.filter((c) => {
            const halo = scene.margin + Math.max(0.01, stepSize) + 1e-8
            const box = c.rect ?? {
              minX: Math.min(c.a.x, c.b.x) - c.radius,
              maxX: Math.max(c.a.x, c.b.x) + c.radius,
              minY: Math.min(c.a.y, c.b.y) - c.radius,
              maxY: Math.max(c.a.y, c.b.y) + c.radius,
            }
            return (
              box.minX <= Math.max(bounds.maxX, start.x, end.x) + halo &&
              box.maxX >= Math.min(bounds.minX, start.x, end.x) - halo &&
              box.minY <= Math.max(bounds.maxY, start.y, end.y) + halo &&
              box.maxY >= Math.min(bounds.minY, start.y, end.y) - halo
            )
          })
        : []
    const key =
      soft.length || history || !bounds || !stepSize
        ? undefined
        : JSON.stringify([
            start,
            end,
            budget,
            grid,
            scene.input.bounds,
            scene.input.minBoardEdgeClearance,
            scene.input.minTraceWidth,
            scene.width,
            scene.margin,
            localCopper.map((c) => [
              c.a.x,
              c.a.y,
              c.b.x,
              c.b.y,
              c.radius,
              c.rect,
            ]),
          ])
    const cached = key === undefined ? undefined : this.answers.get(key)
    if (cached) {
      this.answers.delete(key!)
      this.answers.set(key!, cached)
      for (let i = 0; i < cached.iterations; i++) yield
      return cached.path?.map((p) => ({ ...p })) ?? null
    }
    const search = new GridVisibilitySearch(
      scene,
      start,
      end,
      soft,
      penalty,
      history,
      grid,
    )
    let iterations = 0
    try {
      while (!search.solved && !search.failed && search.expanded < budget) {
        search.step()
        iterations++
        yield
      }
    } finally {
      search.cancel()
    }
    const path = search.solved ? search.result : null
    if (key !== undefined) {
      const bytes = key.length * 2 + (path?.length ?? 0) * 32 + 64
      if (bytes <= this.maxBytes) {
        const previous = this.answers.get(key)
        if (previous) {
          this.bytes -= previous.bytes
          this.answers.delete(key)
        }
        while (this.bytes + bytes > this.maxBytes) {
          const oldest = this.answers.keys().next().value!
          this.bytes -= this.answers.get(oldest)!.bytes
          this.answers.delete(oldest)
        }
        this.answers.set(key, {
          path: path?.map((p) => ({ ...p })) ?? null,
          iterations,
          bytes,
        })
        this.bytes += bytes
      }
    }
    return path?.map((p) => ({ ...p })) ?? null
  }
}

const requestApproaches = new WeakMap<SimpleRouteJson, CoupledApproachSearch>()
export function coupledApproachSearch(input: SimpleRouteJson) {
  let memo = requestApproaches.get(input)
  if (!memo) requestApproaches.set(input, (memo = new CoupledApproachSearch()))
  return memo
}

import { GridHeap } from "./grid-heap"
import type { SimpleRouteJson } from "./types"

interface GridScratch {
  cellCount: number
  best: Float64Array
  parent: Int32Array
  travel?: Float64Array
  heap: GridHeap
}

export interface GridScratchLease {
  readonly scratch: GridScratch
  release(): void
}

const maxScratchBytes = 64 * 1024 * 1024
const pools = new WeakMap<SimpleRouteJson, GridScratchPool>()

function storageBytes(scratch: GridScratch) {
  return (
    scratch.best.byteLength +
    scratch.parent.byteLength +
    (scratch.travel?.byteLength ?? 0) +
    scratch.heap.storageBytes
  )
}

class GridScratchPool {
  private available = new Map<number, GridScratch[]>()
  private retained = new Map<GridScratch, number>()
  private bytes = 0

  acquire(cellCount: number, withTravel: boolean): GridScratchLease {
    const bucket = this.available.get(cellCount)
    const scratch: GridScratch = bucket?.pop() ?? {
      cellCount,
      best: new Float64Array(cellCount),
      parent: new Int32Array(cellCount),
      heap: new GridHeap(cellCount),
    }
    if (bucket && !bucket.length) this.available.delete(cellCount)
    const retainedBytes = this.retained.get(scratch)
    if (retainedBytes !== undefined) {
      this.bytes -= retainedBytes
      this.retained.delete(scratch)
    }
    // Scores always reset, preserving undiscovered cells' exact Infinity
    // sentinel. Parent/travel values are read only after discovery writes them.
    scratch.best.fill(Infinity)
    if (withTravel && !scratch.travel)
      scratch.travel = new Float64Array(cellCount)
    let active = true
    return {
      scratch,
      release: () => {
        // A completed search retains this lease; it must never clear buffers
        // that a later search borrowed through a different lease.
        if (!active) return
        active = false
        this.retain(scratch)
      },
    }
  }

  private retain(scratch: GridScratch) {
    scratch.heap.clear()
    const bytes = storageBytes(scratch)
    if (bytes > maxScratchBytes) return
    while (this.bytes + bytes > maxScratchBytes) {
      const oldest = this.retained.keys().next().value!
      this.bytes -= this.retained.get(oldest)!
      this.retained.delete(oldest)
      const bucket = this.available.get(oldest.cellCount)!
      bucket.splice(bucket.indexOf(oldest), 1)
      if (!bucket.length) this.available.delete(oldest.cellCount)
    }
    const bucket = this.available.get(scratch.cellCount) ?? []
    bucket.push(scratch)
    this.available.set(scratch.cellCount, bucket)
    this.retained.set(scratch, bytes)
    this.bytes += bytes
  }
}

/** Request-local scratch, containing no search objects or saved routes. Active
 * searches own distinct leases; only released buffers participate in the LRU. */
export function acquireGridScratch(
  input: SimpleRouteJson,
  cellCount: number,
  withTravel: boolean,
): GridScratchLease {
  let pool = pools.get(input)
  if (!pool) pools.set(input, (pool = new GridScratchPool()))
  return pool.acquire(cellCount, withTravel)
}

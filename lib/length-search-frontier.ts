import type { Point } from "./types"

export interface LengthSearchLabel {
  node: number
  cost: number
  travelled: number
  priority: number
  sequence: number
  parent?: LengthSearchLabel
  rootPath?: Point[]
  active: boolean
}

/** A length-limited shortest path has two resources: congestion cost and copper
 * length. Neither a cheaper longer prefix nor a shorter more expensive prefix
 * dominates the other. Keep immutable predecessors for every surviving label. */
export class LengthSearchFrontier {
  private labels = new Map<number, LengthSearchLabel[]>()
  private heap: LengthSearchLabel[] = []
  private sequence = 0
  get length() {
    return this.heap.length
  }
  clear() {
    this.labels.clear()
    this.heap.length = 0
    this.sequence = 0
  }
  dominated(node: number, cost: number, travelled: number) {
    return (
      this.labels
        .get(node)
        ?.some(
          (label) =>
            label.cost <= cost + 1e-10 && label.travelled <= travelled + 1e-10,
        ) ?? false
    )
  }
  add(
    node: number,
    cost: number,
    travelled: number,
    heuristic: number,
    parent?: LengthSearchLabel,
    rootPath?: Point[],
  ) {
    if (this.dominated(node, cost, travelled)) return
    const previous = this.labels.get(node) ?? []
    const retained = previous.filter((label) => {
      if (cost <= label.cost + 1e-10 && travelled <= label.travelled + 1e-10) {
        label.active = false
        return false
      }
      return true
    })
    const label: LengthSearchLabel = {
      node,
      cost,
      travelled,
      priority: cost + heuristic,
      sequence: this.sequence++,
      parent,
      rootPath,
      active: true,
    }
    retained.push(label)
    this.labels.set(node, retained)
    let i = this.heap.length
    this.heap.push(label)
    while (i > 0) {
      const parentIndex = (i - 1) >> 1
      if (!this.before(label, this.heap[parentIndex])) break
      this.heap[i] = this.heap[parentIndex]
      i = parentIndex
    }
    this.heap[i] = label
  }
  private before(a: LengthSearchLabel, b: LengthSearchLabel) {
    return (
      a.priority < b.priority ||
      (a.priority === b.priority &&
        (a.cost > b.cost || (a.cost === b.cost && a.sequence < b.sequence)))
    )
  }
  pop(): LengthSearchLabel | undefined {
    while (this.heap.length) {
      const result = this.heap[0],
        last = this.heap.pop()!
      if (this.heap.length) {
        let i = 0
        while (2 * i + 1 < this.heap.length) {
          let next = 2 * i + 1
          if (
            next + 1 < this.heap.length &&
            this.before(this.heap[next + 1], this.heap[next])
          )
            next++
          if (!this.before(this.heap[next], last)) break
          this.heap[i] = this.heap[next]
          i = next
        }
        this.heap[i] = last
      }
      if (result.active) return result
    }
  }
}

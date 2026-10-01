/** Numeric A* queue: lowest f, then largest g (closest to the goal), then
 * insertion order. Progress breaks equal-cost plateaus without weighting h. */
export class GridHeap {
  private ids = new Int32Array(1024)
  private costs = new Float64Array(1024)
  private priorities = new Float64Array(1024)
  private sequences = new Float64Array(1024)
  private size = 0
  private positions: Int32Array
  constructor(cellCount: number) {
    this.positions = new Int32Array(cellCount)
  }
  private sequence = 0
  id = 0
  g = 0
  get length() {
    return this.size
  }
  get storageBytes() {
    return (
      this.positions.byteLength +
      this.ids.byteLength +
      this.costs.byteLength +
      this.priorities.byteLength +
      this.sequences.byteLength
    )
  }
  clear() {
    // Removed cells already have a zero position. Clear only queued cells so
    // a completed or canceled search can reuse its buffers without a grid fill.
    for (let i = 0; i < this.size; i++) this.positions[this.ids[i]] = 0
    this.size = 0
    this.sequence = 0
    this.id = 0
    this.g = 0
  }
  push(id: number, g: number, f: number) {
    const seq = this.sequence++
    const previous = this.positions[id]
    if (
      previous &&
      (f > this.priorities[previous - 1] ||
        (f === this.priorities[previous - 1] && g <= this.costs[previous - 1]))
    ) {
      this.sink(previous - 1, id, g, f, seq)
      return
    }
    let i = previous ? previous - 1 : this.size++
    if (i === this.ids.length) {
      const ids = new Int32Array(i * 2),
        costs = new Float64Array(i * 2),
        priorities = new Float64Array(i * 2),
        sequences = new Float64Array(i * 2)
      ids.set(this.ids)
      costs.set(this.costs)
      priorities.set(this.priorities)
      sequences.set(this.sequences)
      this.ids = ids
      this.costs = costs
      this.priorities = priorities
      this.sequences = sequences
    }
    const { ids, positions, costs, priorities, sequences } = this
    while (i > 0) {
      const p = (i - 1) >> 2
      const pf = priorities[p]
      if (
        f > pf ||
        (f === pf && (g < costs[p] || (g === costs[p] && seq >= sequences[p])))
      )
        break
      ids[i] = ids[p]
      positions[ids[i]] = i + 1
      costs[i] = costs[p]
      priorities[i] = pf
      sequences[i] = sequences[p]
      i = p
    }
    ids[i] = id
    positions[id] = i + 1
    costs[i] = g
    priorities[i] = f
    sequences[i] = seq
  }
  pop() {
    const { ids, positions, costs, priorities, sequences } = this
    this.id = ids[0]
    this.g = costs[0]
    positions[this.id] = 0
    const n = --this.size
    const id = ids[n],
      g = costs[n],
      f = priorities[n],
      seq = sequences[n]
    if (!n) return
    this.sink(0, id, g, f, seq)
  }
  private sink(i: number, id: number, g: number, f: number, seq: number) {
    const n = this.size
    const { ids, costs, priorities, sequences, positions } = this
    while (i * 4 + 1 < n) {
      let child = i * 4 + 1
      let cf = priorities[child],
        cg = costs[child],
        cs = sequences[child]
      const end = Math.min(child + 4, n)
      for (let other = child + 1; other < end; other++) {
        const of = priorities[other]
        if (
          of < cf ||
          (of === cf &&
            (costs[other] > cg ||
              (costs[other] === cg && sequences[other] < cs)))
        ) {
          child = other
          cf = of
          cg = costs[other]
          cs = sequences[other]
        }
      }
      if (cf > f || (cf === f && (cg < g || (cg === g && cs >= seq)))) break
      ids[i] = ids[child]
      positions[ids[i]] = i + 1
      costs[i] = cg
      priorities[i] = cf
      sequences[i] = cs
      i = child
    }
    ids[i] = id
    positions[id] = i + 1
    costs[i] = g
    priorities[i] = f
    sequences[i] = seq
  }
}

/** Stable numeric A* queue. Parallel arrays avoid allocating two objects for
 * every relaxed grid edge; equal priorities retain insertion order. */
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
  push(id: number, g: number, f: number) {
    const seq = this.sequence++
    const previous = this.positions[id]
    if (previous && f >= this.priorities[previous - 1]) {
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
    while (i > 0) {
      const p = (i - 1) >> 2
      const pf = this.priorities[p]
      if (f > pf || (f === pf && seq >= this.sequences[p])) break
      this.ids[i] = this.ids[p]
      this.positions[this.ids[i]] = i + 1
      this.costs[i] = this.costs[p]
      this.priorities[i] = pf
      this.sequences[i] = this.sequences[p]
      i = p
    }
    this.ids[i] = id
    this.positions[id] = i + 1
    this.costs[i] = g
    this.priorities[i] = f
    this.sequences[i] = seq
  }
  pop() {
    this.id = this.ids[0]
    this.g = this.costs[0]
    this.positions[this.id] = 0
    const n = --this.size
    const id = this.ids[n],
      g = this.costs[n],
      f = this.priorities[n],
      seq = this.sequences[n]
    if (!n) return
    this.sink(0, id, g, f, seq)
  }
  private sink(i: number, id: number, g: number, f: number, seq: number) {
    const n = this.size
    const { ids, costs, priorities, sequences, positions } = this
    while (i * 4 + 1 < n) {
      let child = i * 4 + 1
      let cf = priorities[child],
        cs = sequences[child]
      const end = Math.min(child + 4, n)
      for (let other = child + 1; other < end; other++) {
        const of = priorities[other]
        if (of < cf || (of === cf && sequences[other] < cs)) {
          child = other
          cf = of
          cs = sequences[other]
        }
      }
      if (cf > f || (cf === f && cs >= seq)) break
      ids[i] = ids[child]
      positions[ids[i]] = i + 1
      costs[i] = costs[child]
      priorities[i] = cf
      sequences[i] = sequences[child]
      i = child
    }
    ids[i] = id
    positions[id] = i + 1
    costs[i] = g
    priorities[i] = f
    sequences[i] = seq
  }
}

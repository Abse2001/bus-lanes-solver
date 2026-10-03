/** Eight-neighbor occupancy components over free horizontal runs. Ignoring
 * continuous edge barriers makes this graph a superset: different components
 * prove disconnection, while shared components still need exact edge checks. */
export class GridComponents {
  private starts: Uint32Array
  private ends: Uint32Array
  private roots: Uint32Array
  private rows: Uint32Array
  constructor(
    blocked: Uint8Array,
    private width: number,
  ) {
    const starts = [0],
      ends = [0],
      parents = [0],
      rows = [1]
    const root = (id: number): number => {
      while (parents[id] !== id) {
        parents[id] = parents[parents[id]]
        id = parents[id]
      }
      return id
    }
    let previousFirst = 1,
      previousEnd = 1
    for (let base = 0; base < blocked.length; base += width) {
      const rowEnd = Math.min(base + width, blocked.length),
        first = parents.length
      const row = blocked.subarray(base, rowEnd)
      let position = base,
        previous = previousFirst
      while (position < rowEnd) {
        const offset = row.indexOf(0, position - base)
        if (offset < 0) break
        const start = base + offset
        const stop = row.indexOf(1, offset)
        const end = stop < 0 ? rowEnd : base + stop
        const id = parents.length
        starts.push(start)
        ends.push(end)
        parents.push(id)
        while (previous < previousEnd && ends[previous] + width < start)
          previous++
        for (
          let other = previous;
          other < previousEnd && starts[other] + width <= end;
          other++
        ) {
          const a = root(id),
            b = root(other)
          if (a !== b) parents[Math.max(a, b)] = Math.min(a, b)
        }
        position = end
      }
      previousFirst = first
      previousEnd = parents.length
      rows.push(previousEnd)
    }
    this.starts = Uint32Array.from(starts)
    this.ends = Uint32Array.from(ends)
    this.roots = Uint32Array.from(parents.map((_, id) => root(id)))
    this.rows = Uint32Array.from(rows)
  }
  get storageBytes() {
    return (
      this.starts.byteLength +
      this.ends.byteLength +
      this.roots.byteLength +
      this.rows.byteLength
    )
  }
  at(cell: number): number {
    const row = Math.floor(cell / this.width)
    let lo = this.rows[row],
      hi = this.rows[row + 1]
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (cell < this.starts[middle]) hi = middle
      else if (cell >= this.ends[middle]) lo = middle + 1
      else return this.roots[middle]
    }
    return 0
  }
}

/** Stable minimum queue for A*; preserves insertion order for equal scores. */
export class MinHeap<T extends { f: number }> {
  private entries: Array<{ value: T; sequence: number }> = []
  private sequence = 0
  constructor(private readonly tieBreak?: (a: T, b: T) => number) {}
  get length() {
    return this.entries.length
  }
  values() {
    return this.entries.map((e) => e.value)
  }
  private before(
    a: { value: T; sequence: number },
    b: { value: T; sequence: number },
  ) {
    if (a.value.f !== b.value.f) return a.value.f < b.value.f
    const tied = this.tieBreak?.(a.value, b.value) ?? 0
    return tied < 0 || (tied === 0 && a.sequence < b.sequence)
  }
  push(value: T) {
    const entry = { value, sequence: this.sequence++ }
    let i = this.entries.length
    this.entries.push(entry)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.before(entry, this.entries[parent])) break
      this.entries[i] = this.entries[parent]
      i = parent
    }
    this.entries[i] = entry
  }
  pop(): T {
    const first = this.entries[0],
      last = this.entries.pop()!
    if (this.entries.length) {
      let i = 0
      while (i * 2 + 1 < this.entries.length) {
        let child = i * 2 + 1
        if (
          child + 1 < this.entries.length &&
          this.before(this.entries[child + 1], this.entries[child])
        )
          child++
        if (!this.before(this.entries[child], last)) break
        this.entries[i] = this.entries[child]
        i = child
      }
      this.entries[i] = last
    }
    return first.value
  }
}

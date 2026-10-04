type WaveKind = "restore" | "phases"
interface Entry {
  amount: number
  value: unknown
  points: number
  amounts: Map<number, Entry>
}

/** Generator-local memoization of pure bank constructions. FIFO eviction
 * changes only recomputation; neither trial order nor yielded work changes.
 * Count point references conservatively, including shared points in variants. */
export class AnytimeWaveCache {
  private banks = new WeakMap<object, Map<WaveKind, Map<number, Entry>>>()
  private retained = new Map<Entry, undefined>()
  private points = 0

  constructor(
    readonly maxPointReferences = 200_000,
    readonly maxEntries = 128,
  ) {}

  get size() {
    return this.retained.size
  }

  get pointReferences() {
    return this.points
  }

  get<T>(
    bank: object,
    kind: WaveKind,
    amount: number,
    create: () => T,
    countPoints: (value: T) => number,
  ): T {
    const cached = this.banks.get(bank)?.get(kind)?.get(amount)
    if (cached) return cached.value as T
    const value = create(),
      points = countPoints(value)
    if (points > this.maxPointReferences || this.maxEntries < 1) return value
    while (
      this.retained.size >= this.maxEntries ||
      this.points + points > this.maxPointReferences
    ) {
      const oldest = this.retained.keys().next().value!
      oldest.amounts.delete(oldest.amount)
      this.retained.delete(oldest)
      this.points -= oldest.points
    }
    let kinds = this.banks.get(bank)
    if (!kinds) this.banks.set(bank, (kinds = new Map()))
    let amounts = kinds.get(kind)
    if (!amounts) kinds.set(kind, (amounts = new Map()))
    const entry = { amount, value, points, amounts }
    amounts.set(amount, entry)
    this.retained.set(entry, undefined)
    this.points += points
    return value
  }
}

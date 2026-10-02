/** Minimal longitudinal staggering for ordered rectilinear bank entrances.
 * Only lanes whose transverse moves overlap constrain each other; counting
 * every lane wastes the tuning window and can fold a pair back onto itself. */
export function staggeredBankEntries(
  lanes: { from: number; to: number; width: number }[],
  clearance: number,
): number[] | null {
  const edges = lanes.map(() => new Set<number>())
  const incoming = lanes.map(() => 0)
  const connect = (a: number, b: number) => {
    if (!edges[a].has(b)) {
      edges[a].add(b)
      incoming[b]++
    }
  }
  for (let i = 0; i < lanes.length; i++) {
    const a = lanes[i]
    if (Math.abs(a.to - a.from) < 1e-8) continue
    for (let j = 0; j < lanes.length; j++) {
      if (i === j) continue
      const b = lanes[j],
        margin = (a.width + b.width) / 2 + clearance
      const between = (y: number) =>
        y > Math.min(a.from, a.to) - margin + 1e-8 &&
        y < Math.max(a.from, a.to) + margin - 1e-8
      if (between(b.from)) connect(j, i)
      if (between(b.to)) connect(i, j)
    }
  }
  const depths = lanes.map(() => 0),
    ready = incoming.flatMap((n, i) => (n === 0 ? [i] : []))
  let count = 0
  for (let k = 0; k < ready.length; k++) {
    const i = ready[k]
    count++
    for (const j of edges[i]) {
      depths[j] = Math.max(
        depths[j],
        depths[i] + (lanes[i].width + lanes[j].width) / 2 + clearance,
      )
      if (--incoming[j] === 0) ready.push(j)
    }
  }
  return count === lanes.length ? depths : null
}

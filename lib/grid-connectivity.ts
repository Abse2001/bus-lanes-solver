/** Conservative reachability on the occupancy raster. Horizontal runs avoid
 * A* heap work and per-cell Set allocations. Diagonal corner moves are allowed
 * here, even when the router disallows them: false must prove disconnection.
 * Reaching the work limit is inconclusive and leaves the real search enabled. */
export function gridPossiblyConnected(
  blocked: Uint8Array,
  width: number,
  start: number,
  goal: number,
  maxCells = 100000,
): boolean {
  if (start === goal) return true
  const height = blocked.length / width
  const visited = new Uint8Array(blocked.length)
  const pending = [goal]
  let count = 0
  while (pending.length) {
    const id = pending.pop()!
    if (visited[id] || blocked[id]) continue
    const y = Math.floor(id / width),
      row = y * width
    let left = id % width,
      right = left
    while (left > 0 && !blocked[row + left - 1] && !visited[row + left - 1])
      left--
    while (
      right + 1 < width &&
      !blocked[row + right + 1] &&
      !visited[row + right + 1]
    )
      right++
    if (start >= row + left && start <= row + right) return true
    count += right - left + 1
    if (count > maxCells) return true
    visited.fill(1, row + left, row + right + 1)
    for (const nextY of [y - 1, y + 1]) {
      if (nextY < 0 || nextY >= height) continue
      const nextRow = nextY * width,
        end = Math.min(width - 1, right + 1)
      let inRun = false
      for (let x = Math.max(0, left - 1); x <= end; x++) {
        const next = nextRow + x
        if (blocked[next] || visited[next]) inRun = false
        else if (!inRun) {
          pending.push(next)
          inRun = true
        }
      }
    }
  }
  return false
}

import type { SimpleRouteJson } from "./types"

/** The public fanout dependency recognizes connection names and port IDs when
 * finding a pad. Preserve source-trace aliases in the native scene while adding
 * their already-equivalent names only in its derived search input. */
export function localDogboneInput(input: SimpleRouteJson): SimpleRouteJson {
  const names = new Map<string, string[]>()
  for (const connection of input.connections) {
    if (
      !connection.source_trace_id ||
      connection.source_trace_id === connection.name
    )
      continue
    const aliases = names.get(connection.source_trace_id) ?? []
    aliases.push(connection.name)
    names.set(connection.source_trace_id, aliases)
  }
  if (!names.size) return input
  let changed = false
  const obstacles = input.obstacles.map((obstacle) => {
    const additional = obstacle.connectedTo
      .flatMap((id) => names.get(id) ?? [])
      .filter((name) => !obstacle.connectedTo.includes(name))
    if (!additional.length) return obstacle
    changed = true
    return {
      ...obstacle,
      connectedTo: [...new Set([...obstacle.connectedTo, ...additional])],
    }
  })
  return changed ? { ...input, obstacles } : input
}

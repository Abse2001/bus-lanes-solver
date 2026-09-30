import { clearanceToCopper, fixedCopper } from "./vector-scene"
import type { Connection, SimpleRouteJson, Terminal } from "./types"

/** True only for a component pad with no supplied connected copper at the
 * terminal. Points use board-world mm (+X right, +Y up); handoffs are not pads. */
export function isUnroutedComponentPad(
  input: SimpleRouteJson,
  connection: Connection,
  point: Terminal,
): boolean {
  const owners = new Set(
    [
      connection.name,
      connection.source_trace_id,
      point.pointId,
      point.pcb_port_id,
    ].filter((s): s is string => !!s),
  )
  const layers = point.layers ?? [point.layer]
  const pad = input.obstacles.find((o) => {
    if (
      !o.componentId ||
      !o.connectedTo.some((id) => owners.has(id)) ||
      !o.layers.some((l) => layers.includes(l))
    )
      return false
    const angle = (-(o.ccwRotationDegrees ?? 0) * Math.PI) / 180
    const dx = point.x - o.center.x,
      dy = point.y - o.center.y
    if (o.shape === "circle") return Math.hypot(dx, dy) <= o.width / 2 + 1e-8
    const x = dx * Math.cos(angle) - dy * Math.sin(angle),
      y = dx * Math.sin(angle) + dy * Math.cos(angle)
    return (
      Math.abs(x) <= o.width / 2 + 1e-8 && Math.abs(y) <= o.height / 2 + 1e-8
    )
  })
  if (!pad) return false
  return !fixedCopper({ ...input, obstacles: [] }).some(
    (c) =>
      layers.includes(c.layer) &&
      c.owners.some((id) => owners.has(id)) &&
      clearanceToCopper(point, point, c) <= 1e-8,
  )
}

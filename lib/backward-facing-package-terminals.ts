import { distance } from "./geometry"
import type { Point, SimpleRouteJson } from "./types"

/** Whether a package's terminals lie behind its pad-field center relative to
 * the connected package. Such exits need topology planning around the package,
 * rather than ordinary shortest-path routing between facing handoffs. */
export function backwardFacingPackageTerminals(
  input: SimpleRouteJson,
): boolean {
  const fields = new Map<
    string,
    { left: number; right: number; bottom: number; top: number }
  >()
  const pads = input.obstacles.filter((pad) => pad.componentId)
  const physicalPorts = new Map<string, string>()
  for (const pad of pads) {
    const port = (
      pad as typeof pad & {
        circuitJsonMetadata?: { pcb_port_id?: string }
      }
    ).circuitJsonMetadata?.pcb_port_id
    if (port) physicalPorts.set(port, pad.componentId!)
    const angle = ((pad.ccwRotationDegrees ?? 0) * Math.PI) / 180
    const width =
      Math.abs(Math.cos(angle)) * pad.width +
      Math.abs(Math.sin(angle)) * pad.height
    const height =
      Math.abs(Math.sin(angle)) * pad.width +
      Math.abs(Math.cos(angle)) * pad.height
    const field = fields.get(pad.componentId!) ?? {
      left: Infinity,
      right: -Infinity,
      bottom: Infinity,
      top: -Infinity,
    }
    field.left = Math.min(field.left, pad.center.x - width / 2)
    field.right = Math.max(field.right, pad.center.x + width / 2)
    field.bottom = Math.min(field.bottom, pad.center.y - height / 2)
    field.top = Math.max(field.top, pad.center.y + height / 2)
    fields.set(pad.componentId!, field)
  }
  const centers = new Map(
    [...fields].map(([id, field]) => [
      id,
      { x: (field.left + field.right) / 2, y: (field.bottom + field.top) / 2 },
    ]),
  )
  const groups = new Map<
    string,
    { source: string; remote: string; points: Point[] }
  >()
  for (const connection of input.connections) {
    if (connection.pointsToConnect.length !== 2) continue
    const components = connection.pointsToConnect.map((terminal) => {
      // Connected aliases may include both packages' ports on the whole net.
      // A completed handoff can also be nearer the remote package's pads.
      // Preserve its native physical owner before using geometric fallback.
      const physicalOwner = terminal.pcb_port_id
        ? physicalPorts.get(terminal.pcb_port_id)
        : undefined
      if (physicalOwner) return physicalOwner
      const owners = new Set(
        [
          connection.name,
          connection.source_trace_id,
          terminal.pointId,
          terminal.pcb_port_id,
        ].filter((owner): owner is string => !!owner),
      )
      return pads
        .filter((pad) => pad.connectedTo.some((owner) => owners.has(owner)))
        .sort(
          (a, b) => distance(terminal, a.center) - distance(terminal, b.center),
        )[0]?.componentId
    })
    for (const [index, source] of components.entries()) {
      const remote = components[1 - index]
      if (!source || !remote || source === remote) continue
      const key = JSON.stringify([source, remote])
      const group = groups.get(key) ?? { source, remote, points: [] }
      group.points.push(connection.pointsToConnect[index])
      groups.set(key, group)
    }
  }
  return [...groups.values()].some((group) => {
    const center = centers.get(group.source)!,
      remote = centers.get(group.remote)!
    const centroid = {
      x:
        group.points.reduce((sum, point) => sum + point.x, 0) /
        group.points.length,
      y:
        group.points.reduce((sum, point) => sum + point.y, 0) /
        group.points.length,
    }
    return (
      (centroid.x - center.x) * (remote.x - center.x) +
        (centroid.y - center.y) * (remote.y - center.y) <
      -1e-9
    )
  })
}

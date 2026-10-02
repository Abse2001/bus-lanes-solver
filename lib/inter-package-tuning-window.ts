import { distance } from "./geometry"
import { fixedCopper } from "./vector-scene"
import type { Point, SimpleRouteJson, Trace } from "./types"

/** Open longitudinal space between package pad fields, including the real
 * through-via barrels near each field. Board-world mm; `along` is a unit-axis
 * projection. Supplied copper and terminals remain immutable. */
export function interPackageTuningWindow(
  input: SimpleRouteJson,
  traces: Trace[],
  along: (point: Point) => number,
  margin: number,
) {
  const physicalPorts = new Map<string, string>()
  for (const pad of input.obstacles) {
    const port = (
      pad as typeof pad & { circuitJsonMetadata?: { pcb_port_id?: string } }
    ).circuitJsonMetadata?.pcb_port_id
    if (port && pad.componentId) physicalPorts.set(port, pad.componentId)
  }
  const componentAt = (trace: Trace, last: boolean) => {
    const endpoint = last ? trace.route.at(-1)! : trace.route[0]
    const connection = input.connections.find(
      (c) => c.name === trace.connection_name,
    )
    const terminal = connection?.pointsToConnect
      .slice()
      .sort((a, b) => distance(endpoint, a) - distance(endpoint, b))[0]
    const port =
      terminal?.pcb_port_id ??
      (endpoint as Point & { pcb_port_id?: string }).pcb_port_id
    const owner = port ? physicalPorts.get(port) : undefined
    if (owner) return owner
    const aliases = new Set(
      [
        trace.connection_name,
        trace.source_trace_id,
        connection?.source_trace_id,
        terminal?.pointId,
        terminal?.pcb_port_id,
      ].filter((alias): alias is string => !!alias),
    )
    return input.obstacles
      .filter(
        (pad) =>
          pad.componentId &&
          pad.connectedTo.some((alias) => aliases.has(alias)),
      )
      .sort(
        (a, b) => distance(endpoint, a.center) - distance(endpoint, b.center),
      )[0]?.componentId
  }
  const localCopper = fixedCopper(input).filter(
    (copper) => copper.a.x === copper.b.x && copper.a.y === copper.b.y,
  )
  const extent = (ids: Set<string>) => {
    let min = Infinity,
      max = -Infinity
    for (const id of ids) {
      const pads = input.obstacles.filter((pad) => pad.componentId === id)
      if (!pads.length) continue
      const envelopes = pads.map((pad) => {
        const angle = ((pad.ccwRotationDegrees ?? 0) * Math.PI) / 180
        const width =
          Math.abs(Math.cos(angle)) * pad.width +
          Math.abs(Math.sin(angle)) * pad.height
        const height =
          Math.abs(Math.sin(angle)) * pad.width +
          Math.abs(Math.cos(angle)) * pad.height
        return {
          left: pad.center.x - width / 2,
          right: pad.center.x + width / 2,
          bottom: pad.center.y - height / 2,
          top: pad.center.y + height / 2,
        }
      })
      const left = Math.min(...envelopes.map((pad) => pad.left)),
        right = Math.max(...envelopes.map((pad) => pad.right)),
        bottom = Math.min(...envelopes.map((pad) => pad.bottom)),
        top = Math.max(...envelopes.map((pad) => pad.top))
      const halo =
        Math.max(
          input.minViaPadDiameter ?? 0.3,
          ...pads.flatMap((pad) => [pad.width, pad.height]),
        ) * 2
      for (const x of [left, right])
        for (const y of [bottom, top]) {
          min = Math.min(min, along({ x, y }))
          max = Math.max(max, along({ x, y }))
        }
      for (const copper of localCopper) {
        const point = copper.a
        if (
          point.x < left - halo ||
          point.x > right + halo ||
          point.y < bottom - halo ||
          point.y > top + halo
        )
          continue
        min = Math.min(min, along(point) - copper.radius)
        max = Math.max(max, along(point) + copper.radius)
      }
    }
    return { min, max }
  }
  const componentIds = (last: boolean) =>
    new Set(
      traces
        .map((trace) => componentAt(trace, last))
        .filter((id): id is string => !!id),
    )
  return {
    start: extent(componentIds(false)).max + margin,
    end: extent(componentIds(true)).min - margin,
  }
}

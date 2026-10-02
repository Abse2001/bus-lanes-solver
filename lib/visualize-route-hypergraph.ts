import type { GraphicsObject } from "graphics-debug"
import type { RouteHypergraphTopology } from "./route-hypergraph"

/** Incidence view: hyperedges are square factor nodes joined to demand circles.
 * The separate conflict view shows tested geometric exclusions, not incidence.
 * Abstract graphics have no PCB layer so a retained copper filter cannot hide them. */
export function visualizeRouteHypergraph(
  topology: RouteHypergraphTopology,
): GraphicsObject {
  const graphics: GraphicsObject = {
    coordinateSystem: "cartesian",
    title: "Hypergraph topology (abstract, not PCB coordinates)",
    lines: [],
    circles: [],
    rects: [],
    texts: [],
  }
  const groups = new Map<string, typeof topology.edges>()
  for (const edge of topology.edges) {
    const key = [...edge.vertices].sort().join("\0")
    const group = groups.get(key) ?? []
    group.push(edge)
    groups.set(key, group)
  }
  const rows = [...groups.values()].map((edges) =>
    [...edges]
      .sort(
        (a, b) =>
          Number(b.selected) - Number(a.selected) ||
          a.cost - b.cost ||
          a.id - b.id,
      )
      .slice(0, 8),
  )
  const shown = rows.flat()
  const ids = new Set(shown.map((e) => e.id))
  const conflicts = topology.testedExclusions.filter(
    ([a, b]) => ids.has(a) && ids.has(b),
  )
  const text = (
    x: number,
    y: number,
    value: string,
    size = 1.05,
    color = "#334155",
  ) =>
    graphics.texts!.push({
      x,
      y,
      text: value,
      // InteractiveGraphics renders text in screen pixels, independent of zoom.
      fontSize: Math.max(9, size * 10),
      color,
      anchorSide: "center_left",
    })
  text(0, 10, "HYPERGRAPH INCIDENCE", 1.7, "#0f172a")
  text(0, 6.2, "Blue circle = signal demand; square E# = candidate hyperedge")
  text(
    0,
    3.4,
    "Green = selected. Choose exactly one incident hyperedge per demand.",
  )
  text(
    0,
    0.6,
    `${topology.vertices.length} demands · ${shown.length}/${topology.edges.length} active candidates shown · ${topology.generatedEdges} generated`,
  )
  text(
    0,
    -2.2,
    "Up to 8 per group, including selected. Inspect squares for layer and cost.",
  )
  for (const [row, edges] of rows.entries()) {
    const members = edges[0].vertices
    const y = -6 - row * 5.5
    const vertexPositions = members.map((name, i) => ({
      name,
      x: 18,
      y: y + (members.length - 1) * 1.2 - i * 2.4,
    }))
    for (const v of vertexPositions) {
      graphics.circles!.push({
        center: v,
        radius: 0.42,
        fill: "#dbeafe",
        stroke: "#2563eb",
        label: `Demand: ${v.name}`,
      })
      text(0, v.y, v.name, 0.95, "#1d4ed8")
    }
    for (const [column, edge] of edges.entries()) {
      const x = 25 + column * 5
      for (const v of vertexPositions)
        graphics.lines!.push({
          // Bow each incidence link so alternatives do not resemble a chain.
          points: Array.from({ length: 13 }, (_, i) => {
            const t = i / 12
            return {
              x: v.x + (x - v.x) * t,
              y: v.y + (y - v.y) * t - 4 * t * (1 - t) * column * 0.18,
            }
          }),
          strokeColor: edge.selected ? "#16a34a" : "#cbd5e1",
          strokeWidth: edge.selected ? 0.13 : 0.05,
          label: `E${edge.id} covers ${v.name}`,
        })
      graphics.rects!.push({
        center: { x, y },
        width: 1.15,
        height: 1.15,
        fill: edge.selected ? "#16a34a" : "#f1f5f9",
        stroke: edge.selected ? "#15803d" : "#64748b",
        label: `E${edge.id}: ${edge.vertices.join(" + ")} | ${edge.layer} | cost ${edge.cost.toFixed(3)} mm${edge.selected ? " | SELECTED" : ""}`,
      })
      text(
        x - 0.9,
        y + 1.8,
        `E${edge.id}`,
        0.8,
        edge.selected ? "#15803d" : "#475569",
      )
    }
    if (members.length > 1)
      text(
        18,
        y - 2.5,
        "Atomic pair: one square covers both circles",
        0.72,
        "#7c3aed",
      )
  }
  const right = 76
  text(right, 10, "TESTED COPPER EXCLUSIONS", 1.7, "#0f172a")
  text(right, 6.2, "Same E# candidates; a red link forbids selecting both.")
  text(right, 3.4, "Only collision tests performed by the search are shown.")
  text(
    right,
    0.6,
    `${conflicts.length}/${topology.testedExclusions.length} known conflicts shown; missing links may be untested.`,
  )
  text(
    right,
    -2.2,
    "Shared-demand exclusivity is represented by membership on the left.",
  )
  const radius = 25
  const center = { x: right + radius + 4, y: -radius - 8 }
  const positions = new Map(
    shown.map((e, i) => {
      const angle = Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, shown.length)
      return [
        e.id,
        {
          x: center.x + radius * Math.cos(angle),
          y: center.y + radius * Math.sin(angle),
        },
      ]
    }),
  )
  for (const [a, b] of conflicts)
    graphics.lines!.push({
      points: [positions.get(a)!, positions.get(b)!],
      strokeColor: "#ef444480",
      strokeWidth: 0.055,
      label: `E${a} and E${b}: tested copper conflict`,
    })
  for (const edge of shown) {
    const p = positions.get(edge.id)!
    graphics.rects!.push({
      center: p,
      width: 0.9,
      height: 0.9,
      fill: edge.selected ? "#16a34a" : "#e2e8f0",
      stroke: edge.selected ? "#15803d" : "#64748b",
      label: `E${edge.id}: ${edge.vertices.join(" + ")}${edge.selected ? " | SELECTED" : ""}`,
    })
    const vx = (p.x - center.x) / radius,
      vy = (p.y - center.y) / radius
    text(p.x + vx * 1.1 - 0.4, p.y + vy * 1.1, `E${edge.id}`, 0.7)
  }
  // Fit the abstract drawing into roughly the same scale as the PCB views.
  const scale = 0.36
  const position = (p: { x: number; y: number }) => ({
    x: p.x * scale * 1.5 - 22,
    y: p.y * scale + 7,
  })
  for (const line of graphics.lines!) {
    line.points = line.points.map(position)
    line.strokeWidth! *= scale
  }
  for (const c of graphics.circles!) {
    c.center = position(c.center)
    c.radius *= scale
  }
  for (const r of graphics.rects!) {
    r.center = position(r.center)
    r.width *= scale
    r.height *= scale
  }
  for (const t of graphics.texts!) {
    const p = position(t)
    t.x = p.x
    t.y = p.y
  }
  return graphics
}

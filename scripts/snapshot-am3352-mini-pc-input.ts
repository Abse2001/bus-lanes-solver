import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { gunzipSync } from "node:zlib"
import type { SimpleRouteJson } from "../lib"

// Requested input diagnostic, not a routed snapshot or solver progress image.
export async function snapshotAm3352MiniPcInput() {
  const fixture = new URL(
    "../tests/fixtures/am3352-mini-pc-inner-layers/input.json.gz",
    import.meta.url,
  )
  const input: SimpleRouteJson = JSON.parse(
    gunzipSync(await Bun.file(fixture).arrayBuffer()).toString("utf8"),
  )
  if (input.connections.length !== 50 || input.traces?.length)
    throw Error("Expected the unchanged 50-signal input without saved copper")
  const colors = ["#ffc45c", "#c99bff", "#56d9ed", "#acb8c8"]
  const groups = new Map(
    input.buses!.flatMap((bus, i) =>
      bus.connectionNames.map((name) => [name, colors[i]] as const),
    ),
  )
  const x = (value: number) => 600 + value * 24
  const y = (value: number) => 784 - value * 24
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1410" viewBox="0 0 1200 1410">',
    '<rect width="1200" height="1410" fill="#101720"/>',
    '<defs><clipPath id="board"><rect x="24" y="144" width="1152" height="1136" rx="12"/></clipPath></defs>',
    '<g font-family="DejaVu Sans, sans-serif" fill="#edf2f8">',
  ]
  const text = (
    tx: number,
    ty: number,
    value: string,
    size = 20,
    color = "#edf2f8",
  ) =>
    svg.push(
      `<text x="${tx}" y="${ty}" font-size="${size}" fill="${color}">${value}</text>`,
    )
  text(36, 47, "AM3352 mini-PC · DDR input reproduction", 28)
  text(
    36,
    82,
    "INPUT ONLY — straight airwires, no routed copper",
    23,
    "#ffc45c",
  )
  text(
    36,
    115,
    "RAM rotated 90° · 50 signals · inner1 / inner2 carriers · four physical layers",
    20,
  )
  svg.push(
    '<rect x="24" y="144" width="1152" height="1136" rx="12" fill="#17212e" stroke="#3b4b5e"/>',
    '<g clip-path="url(#board)">',
  )
  for (const pad of input.obstacles) {
    const cx = x(pad.center.x),
      cy = y(pad.center.y)
    const w = pad.width * 24,
      h = pad.height * 24
    const shape = pad.shape ?? pad.type
    const rotation = -(pad.ccwRotationDegrees ?? 0)
    const fill = ["pcb_component_0", "pcb_component_1"].includes(
      pad.componentId ?? "",
    )
      ? "#728398"
      : "#465366"
    svg.push(
      shape === "circle"
        ? `<circle cx="${cx}" cy="${cy}" r="${w / 2}" fill="${fill}"/>`
        : `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${shape === "oval" ? Math.min(w, h) / 2 : 0}" fill="${fill}" transform="rotate(${rotation} ${cx} ${cy})"/>`,
    )
  }
  for (const connection of input.connections) {
    if (connection.pointsToConnect.length !== 2)
      throw Error("Expected pad pairs")
    const [a, b] = connection.pointsToConnect
    const color = groups.get(connection.name) ?? "#acb8c8"
    svg.push(
      `<line x1="${x(a.x)}" y1="${y(a.y)}" x2="${x(b.x)}" y2="${y(b.y)}" stroke="${color}" stroke-width="1.4" opacity="0.75"/>`,
    )
    for (const p of [a, b])
      svg.push(
        `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="3.2" fill="${color}"/>`,
      )
  }
  svg.push("</g>")
  text(390, 208, "AM3352 native pads", 21)
  text(390, 1215, "DDR3 x16 native pads · 90°", 21)
  text(42, 1260, "DDR crop · all-layer obstacle projection")
  text(36, 1321, "BYTE0 · 11", 20, colors[0])
  text(242, 1321, "BYTE1 · 11", 20, colors[1])
  text(448, 1321, "CA + CLOCK · 27", 20, colors[2])
  text(766, 1321, "RESET · 1", 20, colors[3])
  text(
    36,
    1364,
    "Airwires show requested connectivity, not routes, timing, or clearance results.",
    20,
    "#ffc45c",
  )
  svg.push("</g></svg>")
  return svg.join("\n") + "\n"
}

if (import.meta.main) {
  const output = process.argv[2] ?? "docs/am3352-mini-pc-input.svg"
  await mkdir(dirname(output), { recursive: true })
  await Bun.write(output, await snapshotAm3352MiniPcInput())
  console.log(`Wrote input airwire diagnostic: ${output}`)
}

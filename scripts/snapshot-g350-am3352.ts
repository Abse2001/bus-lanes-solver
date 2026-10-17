import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  getPngBufferFromGraphicsObject,
  getSvgFromGraphicsObject,
  type GraphicsObject,
} from "graphics-debug"
import type { SimpleRouteJson, Trace } from "../lib"
import { g350Am3352Metadata, loadG350Am3352Sample } from "./g350-am3352-sample"
import { validateG350Am3352Sample } from "./validate-g350-am3352-sample"

const background = "#10151b"
const componentNames: Record<string, string> = g350Am3352Metadata.componentNames
const layerColors: Record<string, string> = {
  top: "#e56b6f",
  inner1: "#f1b75d",
  inner2: "#b586ed",
  bottom: "#8cd391",
}
const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex")

/** Input and accepted copper have separate labels, names and export paths. */
function g350SnapshotGraphics(input: SimpleRouteJson, traces?: Trace[]) {
  const routed = traces !== undefined
  const title = routed
    ? "G350 DDR - 49/49 routed - DRC and matching passed"
    : "G350 DDR reproduction - INPUT / NOT ROUTED"
  const graphics: GraphicsObject = {
    coordinateSystem: "cartesian",
    title,
    lines: [],
    circles: [],
    rects: [],
    texts: [],
  }
  const text = (x: number, y: number, value: string, size = 1.3) =>
    graphics.texts!.push({
      x,
      y,
      text: value,
      fontSize: size,
      color: "#e2e8f0",
      anchorSide: "bottom_left",
    })
  const wirePoints = (traces ?? []).flatMap((trace) => trace.route)
  const overview = {
    minX: Math.min(input.bounds!.minX, ...wirePoints.map((p) => p.x)),
    maxX: Math.max(input.bounds!.maxX, ...wirePoints.map((p) => p.x)),
    minY: Math.min(input.bounds!.minY, ...wirePoints.map((p) => p.y)),
    maxY: Math.max(input.bounds!.maxY, ...wirePoints.map((p) => p.y)),
  }
  const overviewScale = Math.min(
    53 / (overview.maxX - overview.minX),
    82.5 / (overview.maxY - overview.minY),
  )
  const panels = [
    {
      name: "CPU / RAM pad fields",
      minX: -12,
      maxX: 12,
      minY: -3,
      maxY: 30,
      scale: 2.5,
      dx: 0,
      dy: 0,
    },
    {
      name: "Complete fixture",
      ...overview,
      scale: overviewScale,
      dx: 66,
      dy: 82.5 - (overview.maxY - overview.minY) * overviewScale,
    },
  ]
  for (const panel of panels) {
    const { minX, maxX, minY, maxY, scale, dx, dy } = panel
    const point = (p: { x: number; y: number }) => ({
      x: dx + (p.x - minX) * scale,
      y: dy + (p.y - minY) * scale,
    })
    const visible = (p: { x: number; y: number }) =>
      p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
    graphics.rects!.push({
      center: point({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }),
      width: (maxX - minX) * scale,
      height: (maxY - minY) * scale,
      fill: "none",
      stroke: "#475569",
    })
    if (!routed) {
      for (const connection of input.connections) {
        const [a, b] = connection.pointsToConnect
        if (!visible(a) || !visible(b)) continue
        const bus = input.buses?.find((b) =>
          b.connectionNames.includes(connection.name),
        )
        const color =
          bus?.busId === "DDR_BYTE0"
            ? "#63b3ff"
            : bus?.busId === "DDR_BYTE1"
              ? "#cf95ff"
              : "#f4c767"
        // Explicit dash segments render consistently in both SVG and PNG.
        const length = Math.hypot(b.x - a.x, b.y - a.y)
        const along = (distance: number) =>
          point({
            x: a.x + ((b.x - a.x) * distance) / length,
            y: a.y + ((b.y - a.y) * distance) / length,
          })
        for (let distance = 0; distance < length; distance += 0.24)
          graphics.lines!.push({
            points: [along(distance), along(Math.min(distance + 0.12, length))],
            strokeColor: color,
            strokeWidth: 0.035 * scale,
          })
      }
    }
    for (const pad of input.obstacles) {
      if (!visible(pad.center)) continue
      const name = pad.componentId ? componentNames[pad.componentId] : undefined
      const fill =
        name === "U_SOC" ? "#f8b267" : name === "U_RAM" ? "#71d6c4" : "#8a9caf"
      if (pad.shape === "circle")
        graphics.circles!.push({
          center: point(pad.center),
          radius: (pad.width * scale) / 2,
          fill,
          stroke: "none",
        })
      else
        graphics.rects!.push({
          center: point(pad.center),
          width: pad.width * scale,
          height: pad.height * scale,
          ccwRotationDegrees: pad.ccwRotationDegrees,
          fill,
          stroke: "none",
        })
    }
    for (const trace of traces ?? []) {
      for (let i = 1; i < trace.route.length; i++) {
        const a = trace.route[i - 1],
          b = trace.route[i]
        if (
          a.route_type !== "wire" ||
          b.route_type !== "wire" ||
          a.layer !== b.layer ||
          !visible(a) ||
          !visible(b)
        )
          continue
        graphics.lines!.push({
          points: [point(a), point(b)],
          strokeWidth: a.width * scale,
          strokeColor: layerColors[a.layer],
        })
      }
      for (const via of trace.route) {
        if (via.route_type !== "via" || !visible(via)) continue
        graphics.circles!.push(
          {
            center: point(via),
            radius:
              ((via.via_diameter ?? input.minViaPadDiameter!) * scale) / 2,
            fill: "#f8fafc",
            stroke: "none",
          },
          {
            center: point(via),
            radius:
              ((via.via_hole_diameter ?? input.minViaHoleDiameter!) * scale) /
              2,
            fill: background,
            stroke: "none",
          },
        )
      }
    }
    text(dx, dy + (maxY - minY) * scale + 1, panel.name, 1.5)
  }
  text(0, 90, title, 2.1)
  text(
    0,
    86.5,
    routed
      ? "Copper colors: Top red / Inner1 amber / Inner2 violet / Bottom green"
      : "Dashed lines are logical DDR connections, NOT PCB copper.",
    1.6,
  )
  text(
    0,
    -3,
    `${input.connections.length} DDR connections | ${input.obstacles.length} pad obstacles | ${g350Am3352Metadata.supportComponents} components`,
    1.5,
  )
  text(
    0,
    -6,
    "Four physical copper layers | DDR signal wires: Top / Bottom",
    1.5,
  )
  text(
    0,
    -9,
    `Amber pads: ${g350Am3352Metadata.cpu.part} | Teal pads: ${g350Am3352Metadata.ram.part}`,
    1.3,
  )
  return graphics
}

async function writeSnapshot(
  graphics: GraphicsObject,
  input: SimpleRouteJson,
  directory: string,
  kind: "input" | "routed",
) {
  const width = 2400,
    height = 2100
  const options = { includeTextLabels: false, backgroundColor: background }
  const svg = getSvgFromGraphicsObject(graphics, {
    ...options,
    svgWidth: width,
    svgHeight: height,
  }).replace(/[ \t]+$/gm, "")
  const png = await getPngBufferFromGraphicsObject(graphics, {
    ...options,
    pngWidth: width,
    pngHeight: height,
    yFlip: true,
  })
  const name = `g350-${kind}`
  await mkdir(directory, { recursive: true })
  await Bun.write(join(directory, name + ".svg"), svg)
  await Bun.write(join(directory, name + ".png"), png)
  await Bun.write(
    join(directory, name + ".json"),
    JSON.stringify(
      {
        kind,
        routingAccepted: kind === "routed",
        inputFixtureSha256: g350Am3352Metadata.filesSha256["native-input.json"],
        signalCount: input.connections.length,
        padObstacleCount: input.obstacles.length,
        filesSha256: { [name + ".svg"]: hash(svg), [name + ".png"]: hash(png) },
      },
      null,
      2,
    ) + "\n",
  )
}

export async function exportG350InputSnapshot(directory: string) {
  const input = loadG350Am3352Sample()
  await writeSnapshot(g350SnapshotGraphics(input), input, directory, "input")
}

/** Match the merged SBC exporter: reject incomplete or invalid copper before writing. */
export async function exportG350RoutedSnapshot(
  output: SimpleRouteJson,
  directory: string,
) {
  const input = loadG350Am3352Sample()
  const report = validateG350Am3352Sample(input, output)
  if (!report.valid || report.connectedSignals !== 49)
    throw Error(
      "Refusing a G350 routed snapshot without 49/49 connectivity, DRC and matching",
    )
  await writeSnapshot(
    g350SnapshotGraphics(input, output.traces),
    input,
    directory,
    "routed",
  )
  return report
}

if (import.meta.main) {
  const [source, directory, ...extra] = process.argv.slice(2)
  if (!source || !directory || extra.length)
    throw Error(
      "Usage: bun scripts/snapshot-g350-am3352.ts --input|completed.json output-directory",
    )
  if (source === "--input") await exportG350InputSnapshot(directory)
  else await exportG350RoutedSnapshot(await Bun.file(source).json(), directory)
}

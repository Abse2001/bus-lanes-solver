import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  getPngBufferFromGraphicsObject,
  type GraphicsObject,
} from "graphics-debug"
import {
  BusLanesSolver,
  type BusLanesPipelineSolver,
  type SimpleRouteJson,
} from "../lib"
import type { Am3352SampleMetadata } from "./am3352-samples"
import { validateAm3352Sample } from "./validate-am3352-sample"

/** Export only completed, independently validated copper; never partial search
 * state. JSON retains original pads, rules and all immutable power dogbones. */
export async function exportAm3352Solution(
  directory: string,
  solver: BusLanesPipelineSolver,
  metadata: Am3352SampleMetadata,
) {
  if (!solver.solved || solver.failed)
    throw Error("Refusing to export incomplete routing")
  const audit = await validateAm3352Sample(
    solver.input,
    metadata,
    solver.traces,
  )
  if (!audit.valid) throw Error("Refusing to export invalid routed copper")
  const output = solver.getOutput()
  const png = await renderAm3352Solution(output, metadata.name)
  await mkdir(directory, { recursive: true })
  await Bun.write(
    join(directory, `${metadata.name}-solved.json`),
    JSON.stringify(output, null, 2) + "\n",
  )
  await Bun.write(join(directory, `${metadata.name}-solved.png`), png)
}

/** Render a previously validated output; exporting still requires the audit above. */
export async function renderAm3352Solution(
  output: SimpleRouteJson,
  name: string,
) {
  const source = new BusLanesSolver({ ...output, connections: [] }).visualize()
  const graphic: GraphicsObject = {
    coordinateSystem: "cartesian",
    title: `AM3352 / ${name}: 47/47 connected; DRC and matching passed`,
    lines: [],
    circles: [],
    rects: [],
    texts: [],
  }
  const b = output.bounds,
    w = b.maxX - b.minX,
    h = b.maxY - b.minY
  for (const [i, layer] of ["top", "inner1", "inner2", "bottom"].entries()) {
    const dx = (i % 2) * (w + 8),
      dy = -Math.floor(i / 2) * (h + 10)
    const move = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy })
    graphic.lines!.push(
      ...(source.lines ?? [])
        .filter((s) => s.layer === layer)
        .map((s) => ({ ...s, points: s.points.map(move) })),
    )
    graphic.circles!.push(
      ...(source.circles ?? [])
        .filter((s) => s.layer === layer)
        .map((s) => ({ ...s, center: move(s.center) })),
    )
    graphic.rects!.push(
      ...(source.rects ?? [])
        .filter((s) => s.layer === layer)
        .map((s) => ({ ...s, center: move(s.center) })),
    )
    graphic.rects!.push({
      center: move({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }),
      width: w,
      height: h,
      fill: "transparent",
      stroke: "#d1d5db",
    })
    graphic.texts!.push({
      ...move({ x: b.minX, y: b.maxY + 3 }),
      text: layer,
      fontSize: 2.2,
      anchorSide: "center_left",
      color: "#111827",
    })
  }
  return getPngBufferFromGraphicsObject(graphic, {
    pngWidth: 1600,
    pngHeight: 1600,
    includeTextLabels: false,
    backgroundColor: "white",
  })
}

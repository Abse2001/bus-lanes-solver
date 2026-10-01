import {
  getPngBufferFromGraphicsObject,
  type GraphicsObject,
} from "graphics-debug"
import {
  RoutingStageSolver,
  routingStageDescriptions,
} from "../lib/routing-stage-solver"
const recording = await Bun.file("work/hypergraph-control-stages.json").json()
const stages = recording.stages.map(({ inputIndex, ...s }: any) => ({
  ...s,
  input: recording.inputs[inputIndex],
}))
const selected = [0, 1, 2, 3, 4, 11]
const out: GraphicsObject = {
  coordinateSystem: "cartesian",
  lines: [],
  circles: [],
  rects: [],
  texts: [],
}
for (const [panel, index] of selected.entries()) {
  const stage = stages[index]
  const graphics = new RoutingStageSolver(stage, "inner1").visualize()
  const dx = (panel % 3) * 35,
    dy = -Math.floor(panel / 3) * 55
  const move = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy })
  out.lines!.push(
    ...(graphics.lines ?? []).map((l) => ({
      ...l,
      points: l.points.map(move),
    })),
  )
  out.circles!.push(
    ...(graphics.circles ?? []).map((c) => ({ ...c, center: move(c.center) })),
  )
  out.rects!.push(
    ...(graphics.rects ?? []).map((r) => ({ ...r, center: move(r.center) })),
  )
  out.texts!.push({
    ...move({ x: -13, y: 12 }),
    text: `${index + 1}. ${routingStageDescriptions[stage.stage as keyof typeof routingStageDescriptions][0]}`,
    fontSize: 1.3,
    anchorSide: "center_left",
    color: "#0f172a",
  })
  out.texts!.push({
    ...move({ x: -13, y: 9.5 }),
    text:
      index === 11
        ? "47/47 complete · DRC + matching passed"
        : "Intermediate · inner1 copper",
    fontSize: 1,
    anchorSide: "center_left",
    color: "#64748b",
  })
}
const path = process.argv[2] ?? "work/hypergraph-stage-overview.png"
await Bun.write(
  path,
  await getPngBufferFromGraphicsObject(out, {
    pngWidth: 1600,
    pngHeight: 1600,
    includeTextLabels: false,
    backgroundColor: "white",
  }),
)
console.log(path)

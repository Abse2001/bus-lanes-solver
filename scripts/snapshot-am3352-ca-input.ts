import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { am3352Hash, loadAm3352Sample } from "./am3352-samples"
import { withAm3352CaBus } from "./repro-am3352-ca-bus"

// Explicitly requested reproduction diagnostic. This draws INPUT airwires,
// never solver progress or a claimed successful route. The routed-snapshot
// exporter's success/connectivity guards remain unchanged.
export async function snapshotAm3352CaInput() {
  const { input: baseline, metadata } = await loadAm3352Sample("inner-layers")
  const complete = withAm3352CaBus(baseline, metadata.signalNames)
  const geometryHash = (input: typeof baseline) =>
    am3352Hash({ ...input, buses: undefined })
  if (geometryHash(baseline) !== geometryHash(complete))
    throw Error("Reproduction changed geometry or fixed copper")
  const colors = ["#ffc45c", "#c99bff", "#56d9ed"]
  const escapeXml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1240" viewBox="0 0 1600 1240">',
    '<rect width="1600" height="1240" fill="#101720"/>',
    '<g font-family="DejaVu Sans, sans-serif" fill="#edf2f8">',
  ]
  const text = (
    x: number,
    y: number,
    value: string,
    size = 20,
    color = "#edf2f8",
  ) =>
    svg.push(
      `<text x="${x}" y="${y}" font-size="${size}" fill="${color}">${escapeXml(value)}</text>`,
    )
  text(
    36,
    48,
    "AM3352 reproduction: only the CA / clock timing bus changes",
    28,
  )
  text(
    36,
    83,
    "INPUT SNAPSHOT — colored straight lines are airwires, not routed signal copper.",
    22,
    "#ffc45c",
  )
  text(
    36,
    113,
    "Same pads, endpoints, 161 fixed power escapes and inner1/inner2 signal restriction in both cases.",
    19,
  )

  for (const [index, input] of [baseline, complete].entries()) {
    const left = 28 + index * 786
    const x = (value: number) => left + 377 + value * 18
    const y = (value: number) => 392 - value * 18
    svg.push(
      `<rect x="${left}" y="140" width="758" height="938" rx="12" fill="#17212e" stroke="#3b4b5e"/>`,
    )
    text(
      left + 22,
      178,
      index
        ? "Reproduction: three timing buses"
        : "Upstream benchmark: two timing buses",
      23,
    )
    text(
      left + 22,
      211,
      index
        ? "Added: 24 CA / CK signals, skew ≤ 0.635 mm"
        : "CA / CK group skew is not constrained",
      19,
      index ? colors[2] : "#acb8c8",
    )
    const groups = new Map(
      input.buses!.flatMap((bus, i) =>
        bus.connectionNames.map((name) => [name, colors[i]] as const),
      ),
    )
    // Fixed physical power paths and through vias are projected together in gray.
    for (const trace of input.traces!) {
      for (let i = 1; i < trace.route.length; i++) {
        const a = trace.route[i - 1],
          b = trace.route[i]
        if (
          a.route_type === "wire" &&
          b.route_type === "wire" &&
          a.layer === b.layer
        )
          svg.push(
            `<line x1="${x(a.x)}" y1="${y(a.y)}" x2="${x(b.x)}" y2="${y(b.y)}" stroke="#728398" stroke-width="1.4"/>`,
          )
      }
      for (const via of trace.route.filter((p) => p.route_type === "via"))
        svg.push(
          `<circle cx="${x(via.x)}" cy="${y(via.y)}" r="2.7" fill="none" stroke="#a6b3c4" stroke-width="1"/>`,
        )
    }
    for (const pad of input.obstacles) {
      if (pad.shape === "circle")
        svg.push(
          `<circle cx="${x(pad.center.x)}" cy="${y(pad.center.y)}" r="${pad.width * 9}" fill="#465366"/>`,
        )
      else
        svg.push(
          `<rect x="${x(pad.center.x - pad.width / 2)}" y="${y(pad.center.y + pad.height / 2)}" width="${pad.width * 18}" height="${pad.height * 18}" fill="#465366"/>`,
        )
    }
    // Draw unconstrained signals first so colored bus membership stays visible.
    const ordered = [...input.connections].sort(
      (a, b) => Number(groups.has(a.name)) - Number(groups.has(b.name)),
    )
    for (const connection of ordered) {
      const [a, b] = connection.pointsToConnect
      if (connection.pointsToConnect.length !== 2)
        throw Error("Expected point-to-point DDR")
      const color = groups.get(connection.name) ?? "#8795a8"
      svg.push(
        `<line x1="${x(a.x)}" y1="${y(a.y)}" x2="${x(b.x)}" y2="${y(b.y)}" stroke="${color}" stroke-width="1.3" opacity="${groups.has(connection.name) ? 0.8 : 0.3}"/>`,
      )
      for (const p of [a, b])
        svg.push(
          `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="2.8" fill="${color}"/>`,
        )
    }
    text(left + 28, 276, "AM3352", 20)
    text(left + 28, 304, "(0, 0)", 17, "#acb8c8")
    text(left + 28, 785, "DDR3 x16", 20)
    text(left + 28, 813, "(0, −27), 0°", 17, "#acb8c8")
    text(left + 22, 1014, "BYTE0: 11 signals  |  BYTE1: 11 signals", 20)
    text(
      left + 22,
      1047,
      index
        ? "46 signals in timing buses; RESET remains separate"
        : "22 signals in timing buses; other signals shown in gray",
      18,
      "#acb8c8",
    )
  }
  text(36, 1115, "Legend:", 19)
  text(132, 1115, "BYTE0", 19, colors[0])
  text(257, 1115, "BYTE1", 19, colors[1])
  text(382, 1115, "CA + CK (added bus)", 19, colors[2])
  text(
    659,
    1115,
    "Gray rings / short paths: unchanged fixed power escapes",
    19,
    "#acb8c8",
  )
  text(
    36,
    1153,
    "Both retain DQS0±, DQS1± and CK± pairs (≤ 0.127 mm skew); byte buses retain ≤ 0.635 mm skew.",
    20,
  )
  text(
    36,
    1189,
    "This compares input constraints. It does not show a completed route or establish DDR compliance.",
    20,
    "#ffc45c",
  )
  text(
    36,
    1220,
    `Geometry + fixed-copper SHA-256 (excluding buses): ${geometryHash(baseline)}`,
    15,
    "#acb8c8",
  )
  svg.push("</g></svg>")
  return svg.join("\n") + "\n"
}

if (import.meta.main) {
  const output = process.argv[2] ?? "docs/am3352-ca-input.svg"
  await mkdir(dirname(output), { recursive: true })
  await Bun.write(output, await snapshotAm3352CaInput())
  console.log(
    `Wrote INPUT diagnostic: ${output} (airwires, not routed signal copper)`,
  )
}

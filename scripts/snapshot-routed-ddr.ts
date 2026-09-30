import { BusLanesSolver } from "../lib"
import { getPngFromLogString } from "graphics-debug"
import { mkdir } from "node:fs/promises"

const directory = process.argv[2] ?? "docs/routed-ddr"
const completed: Array<{ name: string; solver: BusLanesSolver }> = []
for (const name of [
  "ddr_left_io_right",
  "ddr_right_io_left",
  "ddr_top_io_bottom",
  "ddr_bottom_io_top",
]) {
  const input = await Bun.file(`tests/fixtures/two-fanouts/${name}.json`).json()
  const solver = new BusLanesSolver(input)
  solver.solve()
  const routed = new Set(solver.traces.map((trace) => trace.connection_name))
  if (
    !solver.solved ||
    solver.failed ||
    solver.traces.length !== input.connections.length ||
    input.connections.some(
      (connection: { name: string }) => !routed.has(connection.name),
    )
  )
    throw Error(
      `${name}: refusing to export incomplete routing: ${solver.error ?? "missing routes"}`,
    )
  completed.push({ name, solver })
}

// Validate every case before writing any PR artifact. Iteration captures and
// failed/partial outputs belong in local diagnostics, never in review images.
await mkdir(directory, { recursive: true })
for (const { name, solver } of completed) {
  await Bun.write(
    `${directory}/${name}-solved.png`,
    await getPngFromLogString(
      ":graphics " + JSON.stringify(solver.visualize()),
    ),
  )
  console.log(
    `${name}: ${solver.traces.length}/${solver.input.connections.length} routed`,
  )
}

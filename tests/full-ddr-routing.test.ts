import { expect, test } from "bun:test"
import { busLengthReports } from "../lib/route-lengths"
import { tuningPathIsSelfClear } from "../lib/length-tuning"
import { BusLanesSolver } from "../lib"
import { validateTwoFanoutSample } from "../scripts/validate-two-fanout-sample"
const profiles = [
  "ddr_left_io_right",
  "ddr_right_io_left",
  "ddr_top_io_bottom",
  "ddr_bottom_io_top",
]
test("all complete DDR phases route without transitions and pass combined copper DRC", async () => {
  for (const profile of profiles) {
    const input = await Bun.file(
        `tests/fixtures/two-fanouts/${profile}.json`,
      ).json(),
      meta = await Bun.file(
        `tests/fixtures/two-fanouts/${profile}.meta.json`,
      ).json()
    const solver = new BusLanesSolver(input, { maxSearchIterations: 1000 })
    solver.solve()
    expect(solver.error).toBeNull()
    expect(solver.solved).toBe(true)
    expect(solver.traces.length).toBe(33)
    const reports = busLengthReports(input, solver.traces)
    expect(reports).toHaveLength(3)
    for (const report of reports) {
      expect(report.toleranceMm).toBe(0.1)
      expect(report.matched).toBe(true)
      expect(report.skewMm!).toBeLessThanOrEqual(report.toleranceMm! + 1e-7)
      const totals = report.lengths.map(({ name }) => {
        const copper = [
          ...meta.fixedFanoutTraces.filter(
            (t: any) => t.source_trace_id === name,
          ),
          ...solver.traces.filter((t) => t.connection_name === name),
        ]
        expect(copper).toHaveLength(3)
        return copper.reduce(
          (sum: number, t: any) =>
            sum +
            t.route
              .slice(1)
              .reduce(
                (n: number, p: any, i: number) =>
                  n + Math.hypot(p.x - t.route[i].x, p.y - t.route[i].y),
                0,
              ),
          0,
        )
      })
      expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(
        report.toleranceMm! + 1e-7,
      )
    }
    for (const trace of solver.traces)
      expect(tuningPathIsSelfClear(trace.route, 0.225)).toBe(true)
    for (const trace of solver.traces)
      for (let i = 1; i < trace.route.length - 1; i++) {
        const a = trace.route[i - 1],
          b = trace.route[i],
          c = trace.route[i + 1]
        const ab = Math.hypot(b.x - a.x, b.y - a.y),
          bc = Math.hypot(c.x - b.x, c.y - b.y)
        expect(ab).toBeGreaterThan(1e-8)
        expect(bc).toBeGreaterThan(1e-8)
        const cosine =
          ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (ab * bc)
        expect(cosine).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-7)
      }
    expect(
      solver.traces.every((t) => t.route.every((p) => p.route_type === "wire")),
    ).toBe(true)
    expect(
      validateTwoFanoutSample(input, meta, solver.traces).fixedCopperDrcErrors,
    ).toBe(0)
    expect(meta.corePhase.status).toBe("completed")
    expect(meta.corePhase.circuitErrors).toBe(0)
  }
}, 30000)
test("SoC ball positions and orientation are identical in every DDR layout", async () => {
  let reference: any
  for (const profile of profiles) {
    const record = await Bun.file(
      `examples/fanout-solver-outputs/${profile}-soc.json`,
    ).json()
    const pads = record.input.obstacles
      .filter((o: any) => o.componentId === record.options.sourceComponentId)
      .map((o: any) => ({
        id: o.circuitJsonMetadata?.pcb_smtpad_id,
        x: o.center.x,
        y: o.center.y,
        width: o.width,
        height: o.height,
      }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id))
    if (reference) expect(pads).toEqual(reference)
    else reference = pads
  }
})

import { expect, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import { BusLanesPipelineSolver } from "../lib"
import { loadAm3352NativeInput } from "../scripts/am3352-samples"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import { exteriorPairSpacingReports } from "../lib/exterior-pair-spacing"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"

test("native AM3352 pads route without supplied fanouts, with matching and exterior pair coupling", async () => {
  const input = await loadAm3352NativeInput()
  const original = structuredClone(input)
  expect(input.traces).toHaveLength(0)
  const solver = new BusLanesPipelineSolver(input)
  solver.solve()
  expect(solver.error).toBeNull()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toHaveLength(47)
  expect(new Set(solver.traces.map((t) => t.connection_name)).size).toBe(47)
  for (const trace of solver.traces) {
    expect(trace.route.filter((p) => p.route_type === "via")).toHaveLength(2)
    const carrier = trace.route.filter(
      (p) => p.route_type === "wire" && p.layer !== "top",
    )
    expect(
      new Set(
        carrier.map((p) => (p.route_type === "wire" ? p.layer : undefined)),
      ).size,
    ).toBe(1)
  }
  expect(routeAnglesAreConventional(solver.traces)).toBe(true)
  expect(
    [
      ...busLengthReports(input, solver.traces),
      ...pairLengthReports(input, solver.traces),
    ].every((r) => r.matched),
  ).toBe(true)
  expect(
    exteriorPairSpacingReports(input, solver.traces).every(
      (r) => r.applicable && r.matched,
    ),
  ).toBe(true)
  const drc = validateRoutedCopperDrc({
    inputSrj: input,
    routedSrj: solver.getOutput(),
    clearance: 0.1,
    allowBlindAndBuriedVias: false,
  } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.issues).toEqual([])
  expect(drc.valid).toBe(true)
  expect(drc.checkedViaCount).toBe(94)
  expect(input).toEqual(original)
}, 120_000)

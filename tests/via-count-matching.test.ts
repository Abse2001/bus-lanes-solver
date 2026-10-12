import { expect, test } from "bun:test"
import {
  validateOriginalEndpointConnectivity,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { BusLanesPipelineSolver, BusLanesSolver } from "../lib"
import { boardOutlineViolations } from "../lib/board-outline"
import { generatedEscapeHolesConflict } from "../lib/expanded-signal-sites"
import { pairCouplingReports } from "../lib/pair-coupling"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import { busLengthReports, pairLengthReports } from "../lib/route-lengths"
import type { SolverOptions, Terminal, Trace } from "../lib/types"
import {
  fixture,
  physicalLayers,
  type Fixture,
} from "./fixtures/via-count-matching"

type Mode = "validation" | "refinement" | "pipeline"
type Solver = BusLanesSolver | BusLanesPipelineSolver

function create(
  value: Fixture,
  mode: Mode,
  options: SolverOptions = {},
): Solver {
  if (mode === "validation")
    return BusLanesSolver.forValidation(value.input, value.carriers, options)
  if (mode === "refinement")
    return BusLanesSolver.forRefinement(value.input, value.carriers, options)
  return new BusLanesPipelineSolver(value.input, {
    ...options,
    fanout: "none",
    goal: "matched",
  })
}

function finish(solver: Solver) {
  try {
    for (let advances = 0; advances < 1000; advances++) {
      if (solver.solved || solver.failed) return
      solver.step()
    }
    throw Error("Small via-count caller control exceeded its diagnostic budget")
  } finally {
    if (!solver.solved && !solver.failed) solver.tryFinalAcceptance()
  }
}

/** Check actual returned copper against the unchanged original native pads.
 * Supplied fixed fragments participate once in both physical and length checks. */
function expectPhysical(value: Fixture, carriers: Trace[]) {
  const all = [...(value.input.traces ?? []), ...carriers]
  expect(value.native.connections).toHaveLength(2)
  expect(value.native.obstacles).toHaveLength(4)
  expect(carriers).toHaveLength(2)
  expect(new Set(all.map((trace) => trace.pcb_trace_id)).size).toBe(all.length)
  const counts = value.input.connections.map(
    (connection) =>
      all
        .filter((trace) => trace.connection_name === connection.name)
        .flatMap((trace) =>
          trace.route.filter((point) => point.route_type === "via"),
        ).length,
  )
  expect(counts).toEqual(value.counts)
  for (const carrier of carriers) {
    const connection = value.input.connections.find(
      (candidate) => candidate.name === carrier.connection_name,
    )!
    expect(connection).toBeDefined()
    const endpoints: Array<[Trace["route"][number], Terminal]> = [
      [carrier.route[0], connection.pointsToConnect[0]],
      [carrier.route.at(-1)!, connection.pointsToConnect[1]],
    ]
    for (const [point, terminal] of endpoints) {
      expect(point.route_type).toBe("wire")
      expect(
        Math.hypot(point.x - terminal.x, point.y - terminal.y),
      ).toBeLessThan(1e-8)
      if (point.route_type === "wire") expect(point.layer).toBe(terminal.layer)
    }
    expect(
      carrier.route.every(
        (point) => point.route_type === "wire" && point.layer === "top",
      ),
    ).toBe(true)
  }
  for (const trace of all) {
    expect(trace.route[0].route_type).toBe("wire")
    expect(trace.route.at(-1)!.route_type).toBe("wire")
    for (const [index, point] of trace.route.entries()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
      if (point.route_type === "wire") {
        expect(point.width).toBe(value.native.minTraceWidth)
        expect(["top", "bottom"]).toContain(point.layer)
        const next = trace.route[index + 1]
        if (next?.route_type === "wire") expect(next.layer).toBe(point.layer)
      } else {
        expect(point.layers).toEqual(physicalLayers)
        expect(point.via_diameter).toBe(value.native.minViaPadDiameter)
        expect(point.via_hole_diameter).toBe(value.native.minViaHoleDiameter)
        expect(point.from_layer).not.toBe(point.to_layer)
        const before = trace.route[index - 1],
          after = trace.route[index + 1]
        expect(before?.route_type).toBe("wire")
        expect(after?.route_type).toBe("wire")
        if (before?.route_type === "wire" && after?.route_type === "wire") {
          expect(before.layer).toBe(point.from_layer)
          expect(after.layer).toBe(point.to_layer)
          expect(
            Math.hypot(before.x - point.x, before.y - point.y),
          ).toBeLessThan(1e-8)
          expect(Math.hypot(after.x - point.x, after.y - point.y)).toBeLessThan(
            1e-8,
          )
        }
      }
    }
  }
  const drc = validateRoutedCopperDrc({
    inputSrj: value.native,
    routedSrj: { ...value.native, traces: all },
    clearance: value.native.minTraceToPadEdgeClearance!,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0])
  expect(drc.issues).toEqual([])
  expect(drc.valid).toBe(true)
  const connectivity = validateOriginalEndpointConnectivity({
    inputSrj: value.native,
    routedSrj: { ...value.native, traces: all },
  } as Parameters<typeof validateOriginalEndpointConnectivity>[0])
  expect(connectivity.valid).toBe(true)
  expect(connectivity.checkedConnectionCount).toBe(2)
  expect(connectivity.connectedConnectionCount).toBe(2)
  expect(connectivity.checkedEndpointCount).toBe(4)
  expect(connectivity.connectedEndpointCount).toBe(4)
  expect(boardOutlineViolations(value.native, all)).toEqual([])
  expect(routeAnglesAreConventional(all)).toBe(true)
  for (let index = 0; index < all.length; index++)
    expect(
      generatedEscapeHolesConflict(
        value.native,
        [all[index]],
        all.slice(index + 1),
      ),
    ).toBe(false)
  const buses = busLengthReports(value.input, carriers)
  expect(
    buses.every(
      (report) =>
        report.matched && report.withinLengthLimit && report.aboveMinimumLength,
    ),
  ).toBe(true)
  for (const bus of buses)
    expect(bus.lengths.map((member) => member.totalLengthMm)).toEqual([10, 10])
  expect(
    pairLengthReports(value.input, carriers).every((report) => report.matched),
  ).toBe(true)
  expect(
    pairCouplingReports(value.input, carriers).every(
      (report) => report.matched,
    ),
  ).toBe(true)
}

for (const kind of ["bus", "pair"] as const)
  test(`${kind} N0/N2 mismatch passes physically by default and rejects under zero count skew`, () => {
    const value = fixture([0, 2], kind),
      before = structuredClone(value)
    const omitted = create(value, "validation")
    const explicitUndefined = create(value, "validation", {
      maxBusViaCountSkew: undefined,
      maxPairViaCountSkew: undefined,
    })
    finish(omitted)
    finish(explicitUndefined)
    expect(omitted.solved).toBe(true)
    expect(explicitUndefined.solved).toBe(true)
    expect(explicitUndefined.getOutput()).toEqual(omitted.getOutput())
    expectPhysical(value, omitted.traces)
    const rejected = create(
      value,
      "validation",
      kind === "bus" ? { maxBusViaCountSkew: 0 } : { maxPairViaCountSkew: 0 },
    )
    finish(rejected)
    expect(rejected.failed).toBe(true)
    expect(rejected.solved).toBe(false)
    expect(rejected.error).toContain("via-count")
    expect(() => rejected.getOutput()).toThrow()
    expect(value).toEqual(before)
  })

for (const mode of ["refinement", "pipeline"] as const)
  test(`${mode} includes immutable fixed N2 fanouts in bus count enforcement`, () => {
    const value = fixture([0, 2]),
      before = structuredClone(value)
    const original = create(value, mode)
    finish(original)
    expect(original.solved).toBe(true)
    expectPhysical(value, original.traces)
    const rejected = create(value, mode, { maxBusViaCountSkew: 0 })
    finish(rejected)
    expect(rejected.failed).toBe(true)
    expect(rejected.error).toContain("via-count")
    expect(value).toEqual(before)
  })

for (const [count, mode] of [
  [0, "validation"],
  [2, "refinement"],
  [4, "pipeline"],
] as const)
  test(`equal N${count} actual via records pass ${mode} with zero bus and pair count skew`, () => {
    const value = fixture([count, count], "pair"),
      before = structuredClone(value)
    const solver = create(value, mode, {
      maxBusViaCountSkew: 0,
      maxPairViaCountSkew: 0,
    })
    finish(solver)
    expect(solver.solved).toBe(true)
    expectPhysical(value, solver.traces)
    const suppliedTraces = value.input.traces
    expect(suppliedTraces).toBeDefined()
    if (!suppliedTraces) throw Error("Fixture supplied traces are required")
    expect(solver.getOutput().traces!.slice(0, suppliedTraces.length)).toEqual(
      suppliedTraces,
    )
    expect(value).toEqual(before)
  })

test("public pending acceptance restores the actual qualified Pipeline snapshot", () => {
  const value = fixture([4, 4], "pair"),
    before = structuredClone(value)
  const solver = create(value, "pipeline", {
    maxBusViaCountSkew: 0,
    maxPairViaCountSkew: 0,
  })
  try {
    for (
      let advances = 0;
      advances < 1000 &&
      !solver.solved &&
      !solver.failed &&
      solver.phase !== "optimize_envelope";
      advances++
    )
      solver.step()
    expect(solver.failed).toBe(false)
    expect(solver.solved).toBe(false)
    expect(solver.phase).toBe("optimize_envelope")
    expectPhysical(value, solver.traces)
    const accepted = structuredClone(solver.traces)
    expect(() => solver.getOutput()).toThrow()
    // This phase arose from normal routing and matching. No private state,
    // acceptance fields, flags, or route generators are fabricated.
    solver.traces[0].route[0].x += 0.01
    solver.tryFinalAcceptance()
    expect(solver.solved).toBe(true)
    expect(solver.traces).toEqual(accepted)
    expectPhysical(value, solver.traces)
    expect(value).toEqual(before)
  } finally {
    if (!solver.solved && !solver.failed) solver.tryFinalAcceptance()
  }
})

import { expect, test } from "bun:test"
import { BusLanesPipelineSolver } from "../lib/bus-lanes-pipeline-solver"
import { boardOutlineViolations } from "../lib/board-outline"
import type { SimpleRouteJson, Trace } from "../lib/types"

const fixture = (): SimpleRouteJson => ({
  layerCount: 4,
  minTraceWidth: 0.2,
  minBoardEdgeClearance: 0.2,
  bounds: { minX: -1, maxX: 11, minY: -1, maxY: 11 },
  outline: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 6, y: 10 },
    { x: 6, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 10 },
    { x: 0, y: 10 },
  ],
  obstacles: [],
  connections: [
    {
      name: "D",
      pointsToConnect: [
        { x: 2, y: 8, layer: "top" },
        { x: 8, y: 8, layer: "top" },
      ],
    },
  ],
  traces: [
    {
      type: "pcb_trace",
      pcb_trace_id: "fixed",
      connection_name: "fixed",
      route: [1, 2].map((x) => ({
        x,
        y: 1,
        route_type: "wire",
        layer: "bottom",
        width: 0.2,
      })),
    },
  ],
})

test("the matched pipeline publishes only complete copper inside its preserved polygon", () => {
  const input = fixture(),
    before = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input, { fanout: "none" })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(solver.traces).toHaveLength(1)
  expect(solver.traces[0].route.some((p) => p.y < 4)).toBe(true)
  expect(boardOutlineViolations(input, solver.getOutput().traces)).toEqual([])
  expect(solver.getOutput().traces[0]).toEqual(input.traces![0])
  expect(solver.getOutput().outline).toEqual(input.outline)
  expect(input).toEqual(before)
})

for (const stop of ["completed", "interrupted"] as const)
  test(`${stop} accepted-snapshot restoration refuses a refinement crossing the polygon cutout`, () => {
    class BadAcceptedRefinement extends BusLanesPipelineSolver {
      closed = false
      protected *optimizeEnvelope(): Generator<void, void> {
        try {
          // Exercise the public optimizer boundary after a genuinely accepted
          // route exists. A later branch keeps both endpoints but crosses the
          // cutout, so acceptance must recheck full copper before publication.
          const bad: Trace[] = structuredClone(this.traces)
          bad[0].route = [bad[0].route[0], bad[0].route.at(-1)!]
          ;(this as unknown as { acceptedTraces: Trace[] }).acceptedTraces = bad
          yield
        } finally {
          this.closed = true
        }
      }
    }
    const input = fixture(),
      before = structuredClone(input)
    const solver = new BadAcceptedRefinement(input, { fanout: "none" })
    while (
      !solver.solved &&
      !solver.failed &&
      solver.phase !== "optimize_envelope"
    )
      solver.step()
    expect(solver.phase).toBe("optimize_envelope")
    expect(boardOutlineViolations(input, solver.traces)).toEqual([])
    solver.step()
    if (stop === "interrupted") solver.tryFinalAcceptance()
    else solver.step()
    expect(solver.solved).toBe(false)
    expect(solver.failed).toBe(true)
    expect(solver.failureCode).toBe("board_outline_clearance")
    expect(solver.phase).toBe("failed")
    expect(solver.closed).toBe(true)
    expect(solver.traces).toEqual([])
    expect(() => solver.getOutput()).toThrow("board outline clearance")
    expect(input).toEqual(before)
  })

test("pipeline rejects malformed polygons and immutable edge-violating vias before any search", () => {
  const malformed = fixture()
  malformed.outline = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]
  const invalid = new BusLanesPipelineSolver(malformed)
  expect(invalid.failed).toBe(true)
  expect(invalid.failureCode).toBe("invalid_outline")
  expect(invalid.iterations).toBe(0)
  expect(() => invalid.getOutput()).toThrow()
  const input = fixture(),
    before = structuredClone(input)
  input.traces!.push({
    type: "pcb_trace",
    pcb_trace_id: "fixed-via",
    route: [
      {
        route_type: "via",
        x: 0.4,
        y: 2,
        from_layer: "top",
        to_layer: "bottom",
        via_diameter: 0.8,
        via_hole_diameter: 0.2,
      },
    ],
  })
  const fixed = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input)
  expect(solver.failed).toBe(true)
  expect(solver.failureCode).toBe("board_outline_clearance")
  expect(solver.iterations).toBe(0)
  expect(() => solver.getOutput()).toThrow()
  expect(input).toEqual(fixed)
  expect(input.outline).toEqual(before.outline)
})

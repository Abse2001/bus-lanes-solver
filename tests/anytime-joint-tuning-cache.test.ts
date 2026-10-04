import { expect, test } from "bun:test"
import { jointTuningCandidates } from "../lib/anytime-joint-tuning"
import { recoverAnytimeSkeleton } from "../lib/anytime-skeleton"
import { BusLanesSolver } from "../lib/bus-lanes-solver"
import { roundedPairedLobes } from "../lib/smooth-tuning"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

function freezeGeometry(value: unknown) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freezeGeometry(child)
  Object.freeze(value)
}

function trace(name: string, points: Point[]): Trace {
  return {
    type: "pcb_trace",
    pcb_trace_id: name,
    connection_name: name,
    route: points.map(
      (point): Wire => ({
        ...point,
        route_type: "wire",
        width: 0.1,
        layer: "top",
      }),
    ),
    curvedSegments: points.slice(1).flatMap((point, i) => {
      const dx = Math.abs(point.x - points[i].x),
        dy = Math.abs(point.y - points[i].y)
      return dx > 1e-8 && dy > 1e-8 && Math.abs(dx - dy) > 1e-8 ? [i + 1] : []
    }),
  }
}

test("retained joint scenes and bank caches leave frozen inputs and prior candidates untouched", () => {
  const waves = roundedPairedLobes(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    0.22,
    4,
    2,
    1,
    0.12,
  )!
  const original = waves.map((points, side) => {
    const rail = trace(`pair${side}`, points)
    rail.coupledSection = [0, rail.route.length - 1]
    return rail
  })
  original.push(
    trace("driver", [
      { x: 0, y: 5 },
      { x: 14, y: 5 },
    ]),
  )
  const board: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.075,
    bounds: { minX: -2, maxX: 20, minY: -5, maxY: 10 },
    obstacles: [],
    connections: original.map((rail) => ({
      name: rail.connection_name!,
      pointsToConnect: [rail.route[0], rail.route.at(-1)!] as Wire[],
    })),
    buses: [
      {
        busId: "DATA",
        connectionNames: ["pair0", "pair1", "driver"],
        maxLengthSkew: 0.05,
      },
    ],
    differentialPairs: [
      {
        connectionNames: ["pair0", "pair1"],
        traceGap: 0.12,
        lengthTolerance: 0.001,
      },
    ],
  }
  const recovery = recoverAnytimeSkeleton(board, original),
    unchanged = JSON.stringify({ board, original, recovery }),
    candidates: Trace[][] = []
  freezeGeometry({ board, original, recovery })
  const generator = jointTuningCandidates(board, recovery.traces, {
    banks: recovery.pockets,
    preservedTraces: original,
    maxCandidates: 128,
    maxPlacementsPerGroup: 16,
  })
  let firstSnapshot: string | undefined
  try {
    for (const candidate of generator) {
      if (!candidate) continue
      const validator = BusLanesSolver.forValidation(board, candidate)
      validator.solve()
      expect(validator.solved).toBe(true)
      if (firstSnapshot !== undefined)
        expect(JSON.stringify(candidates[0])).toBe(firstSnapshot)
      else firstSnapshot = JSON.stringify(candidate)
      freezeGeometry(candidate)
      candidates.push(candidate)
      if (candidates.length === 2) break
    }
  } finally {
    generator.return(undefined)
  }
  expect(candidates).toHaveLength(2)
  expect(JSON.stringify({ board, original, recovery })).toBe(unchanged)
})

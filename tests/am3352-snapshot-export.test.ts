import { expect, test } from "bun:test"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BusLanesPipelineSolver, type Trace } from "../lib"
import {
  am3352SamplePlacements,
  loadAm3352Sample,
} from "../scripts/am3352-samples"
import {
  exportAm3352RoutedSnapshots,
  validateAm3352SnapshotCandidates,
  type Am3352SnapshotCandidate,
} from "../scripts/snapshot-routed-am3352"

async function candidates() {
  return Promise.all(
    am3352SamplePlacements.map(async (placement) => {
      const { input, metadata } = await loadAm3352Sample(placement.name)
      return { solver: new BusLanesPipelineSolver(input), metadata }
    }),
  )
}

/** Deliberately invalid direct copper, used only to test the artifact gate.
 * Complete pad endpoints and success flags cannot stand in for a DRC pass. */
function pretendCompleted(candidate: Am3352SnapshotCandidate) {
  candidate.solver.solved = true
  candidate.solver.traces = candidate.solver.input.connections.map((c, i) => {
    const [a, b] = c.pointsToConnect
    const width = c.width ?? c.nominalTraceWidth ?? 0.1
    return {
      type: "pcb_trace",
      pcb_trace_id: `invalid_direct_${i}`,
      connection_name: c.name,
      source_trace_id: c.source_trace_id,
      route: [
        { route_type: "wire", ...a, width },
        {
          route_type: "via",
          x: a.x,
          y: a.y,
          from_layer: a.layer,
          to_layer: "inner1",
          layers: ["top", "inner1", "inner2", "bottom"],
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        { route_type: "wire", x: a.x, y: a.y, layer: "inner1", width },
        { route_type: "wire", x: b.x, y: b.y, layer: "inner1", width },
        {
          route_type: "via",
          x: b.x,
          y: b.y,
          from_layer: "inner1",
          to_layer: b.layer,
          layers: ["top", "inner1", "inner2", "bottom"],
          via_diameter: 0.3,
          via_hole_diameter: 0.15,
        },
        { route_type: "wire", ...b, width },
      ],
    } as Trace
  })
}

test("AM3352 snapshot export requires exactly the declared benchmark samples", async () => {
  const all = await candidates()
  await expect(
    validateAm3352SnapshotCandidates(all.slice(0, 3)),
  ).rejects.toThrow("exactly the declared benchmark samples")
  await expect(
    validateAm3352SnapshotCandidates([all[0], all[0], ...all.slice(2)]),
  ).rejects.toThrow("exactly the declared benchmark samples")
})

test("unsolved and incomplete AM3352 states never write snapshot artifacts", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "am3352-artifact-gate-"))
  try {
    const directory = join(temporary, "must-not-be-created")
    const all = await candidates()
    await expect(exportAm3352RoutedSnapshots(all, directory)).rejects.toThrow(
      "refusing incomplete routing",
    )
    await expect(access(directory)).rejects.toThrow()
    for (const candidate of all) candidate.solver.solved = true
    await expect(exportAm3352RoutedSnapshots(all, directory)).rejects.toThrow(
      "output changed fixed power copper or native routing input",
    )
    await expect(access(directory)).rejects.toThrow()
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test("complete endpoint counts with invalid DRC or skew never produce AM3352 review images", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "am3352-artifact-drc-"))
  try {
    const directory = join(temporary, "must-not-be-created")
    const all = await candidates()
    for (const candidate of all) pretendCompleted(candidate)
    await expect(exportAm3352RoutedSnapshots(all, directory)).rejects.toThrow(
      "refusing artifacts without complete connectivity",
    )
    await expect(access(directory)).rejects.toThrow()
    all[0].solver.input.traces![0].route[0].x += 0.001
    await expect(validateAm3352SnapshotCandidates(all)).rejects.toThrow(
      "output changed fixed power copper or native routing input",
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

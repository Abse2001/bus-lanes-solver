import { BaseSolver } from "@tscircuit/solver-utils"
import { BusLanesSolver } from "./bus-lanes-solver"
import { busLengthReports, pairLengthReports } from "./route-lengths"
import type { RoutingStageSnapshot } from "./types"

export const routingStageDescriptions = {
  local_dogbones: [
    "Local signal dogbones",
    "Resolve signal layers and add local pad-to-via escapes. Inter-package connections are not routed yet.",
  ],
  hypergraph_cover: [
    "Hypergraph route selection",
    "Signal demands are vertices; compatible route alternatives are hyperedges. This is the selected geometric cover before cleanup or length tuning, not a drawing of the abstract graph.",
  ],
  route_cleanup: [
    "Route cleanup",
    "Simplify ordinary turns and repair raster jogs. The initial carriers are now ready for length matching.",
  ],
  tuning_corridor: [
    "Selected tuning corridor",
    "The corridor candidate that allowed tuning to succeed. It may equal the initial routes when enough space already exists.",
  ],
  length_matching: [
    "Length matching",
    "Add clearance-checked detours to meet the declared bus and pair copper-length tolerances.",
  ],
  validated_lanes: [
    "Validated lane group",
    "The current group passes lane geometry, clearance and length checks. Other signal groups may still be pending.",
  ],
  assembled_output: [
    "Assembled output",
    "Join both local dogbones to each carrier. The saved recording is published only after the full 47-signal independent audit passes.",
  ],
} satisfies Record<RoutingStageSnapshot["stage"], [string, string]>

/** Read-only adapter for GenericSolverDebugger, not a new routing algorithm.
 * `solved` means the recorded stage is available, not that the board is complete. */
export class RoutingStageSolver extends BaseSolver {
  constructor(
    readonly snapshot: RoutingStageSnapshot,
    readonly layer = "all",
  ) {
    super()
    this.solved = true
    this.progress = 1
    this.stats = {
      stage: snapshot.stage,
      routingStage: snapshot.routingStage,
      attempt: snapshot.attempt,
      intermediate: snapshot.stage !== "assembled_output",
      routes: snapshot.traces.length,
      ...snapshot.stats,
      busLengths: busLengthReports(snapshot.input, snapshot.traces),
      pairLengths: pairLengthReports(snapshot.input, snapshot.traces),
    }
  }
  getSolverName() {
    return routingStageDescriptions[this.snapshot.stage][0]
  }
  getConstructorParams() {
    return [this.snapshot, this.layer]
  }
  getOutput() {
    return structuredClone(this.snapshot)
  }
  visualize() {
    // Put composed traces through fixedCopper's layer-aware via renderer.
    const graphics = new BusLanesSolver({
      ...this.snapshot.input,
      traces: [...(this.snapshot.input.traces ?? []), ...this.snapshot.traces],
      connections: [],
    }).visualize()
    const keep = (item: { layer?: string }) =>
      this.layer === "all" || !item.layer || item.layer === this.layer
    return {
      ...graphics,
      coordinateSystem: "cartesian" as const,
      title: this.getSolverName(),
      lines: graphics.lines?.filter(keep),
      rects: graphics.rects?.filter(keep),
      circles: graphics.circles?.filter(keep),
      points: graphics.points?.filter(keep),
    }
  }
}

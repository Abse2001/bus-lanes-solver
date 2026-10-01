import type { RoutingStageSnapshot, SolverOptions } from "./types"

/** Copy at the boundary so later tuning and layer retries cannot rewrite history.
 * No copying or extra geometry work occurs unless an observer is installed. */
export function captureRoutingStage(
  options: SolverOptions,
  snapshot: RoutingStageSnapshot,
) {
  options.onStage?.(structuredClone(snapshot))
}

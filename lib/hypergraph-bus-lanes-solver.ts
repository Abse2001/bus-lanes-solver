import {
  BusLanesPipelineSolver,
  type BusLanesPipelineOptions,
} from "./bus-lanes-pipeline-solver"
import type { SimpleRouteJson } from "./types"

/** Pipeline variant whose initial lane solution is a conflict-free hypergraph
 * cover. Local dogbones, length matching and final validation remain physical. */
export class HypergraphBusLanesSolver extends BusLanesPipelineSolver {
  constructor(input: SimpleRouteJson, options: BusLanesPipelineOptions = {}) {
    super(input, {
      maxSearchIterations: 2000000,
      ...options,
      denseSearch: true,
      initialRouting: "hypergraph",
    })
  }
}

import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { HypergraphDebugPipelineSolver } from "../lib/hypergraph-debug-pipeline-solver"
import type { SimpleRouteJson } from "../lib"
import input from "./data/am3352-ram-right.json"

export default (
  <GenericSolverDebugger
    createSolver={() =>
      new HypergraphDebugPipelineSolver(input as unknown as SimpleRouteJson)
    }
  />
)

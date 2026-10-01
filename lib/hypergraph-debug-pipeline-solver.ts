import {
  BasePipelineSolver,
  BaseSolver,
  type PipelineStep,
} from "@tscircuit/solver-utils"
import type { GraphicsObject } from "graphics-debug"
import { HypergraphBusLanesSolver } from "./hypergraph-bus-lanes-solver"
import type { SimpleRouteJson } from "./types"

/** Coalesce adjacent display segments into polylines. Long tuned fixed traces
 * otherwise create thousands of SVG objects for every retained stage. */
function compactGraphics(graphics: GraphicsObject): GraphicsObject {
  const lines: NonNullable<GraphicsObject["lines"]> = []
  for (const line of graphics.lines ?? []) {
    const previous = lines.at(-1)
    const end = previous?.points.at(-1),
      start = line.points[0]
    if (
      previous &&
      end &&
      start &&
      end.x === start.x &&
      end.y === start.y &&
      previous.layer === line.layer &&
      previous.label === line.label &&
      previous.strokeColor === line.strokeColor &&
      previous.strokeWidth === line.strokeWidth
    ) {
      previous.points.push(...line.points.slice(1))
    } else lines.push({ ...line, points: [...line.points] })
  }
  return { ...graphics, lines }
}

/** Runs the real solver one engine step per debugger iteration, stopping when
 * its phase changes. Completed stage visualizations remain independently visible. */
class HypergraphPhaseSolver extends BaseSolver {
  private readonly startingPhase: string
  private readonly input: SimpleRouteJson
  private completedGraphics?: GraphicsObject
  constructor(private readonly engine: HypergraphBusLanesSolver) {
    super()
    this.MAX_ITERATIONS = engine.MAX_ITERATIONS
    this.startingPhase = engine.phase
    this.input = structuredClone(engine.input)
  }
  getConstructorParams() {
    return [this.input, { phase: this.startingPhase }]
  }
  getSolverName() {
    return this.startingPhase
  }
  _step() {
    this.engine.step()
    this.stats = { ...this.engine.stats, phase: this.engine.phase }
    this.progress = this.engine.progress
    if (this.engine.failed) {
      this.failed = true
      this.error = this.engine.error
    } else if (this.engine.solved || this.engine.phase !== this.startingPhase) {
      this.completedGraphics = structuredClone(
        compactGraphics(this.engine.visualize()),
      )
      this.solved = true
      this.progress = 1
    }
  }
  visualize() {
    return this.completedGraphics ?? compactGraphics(this.engine.visualize())
  }
}

/** Native GenericSolverDebugger pipeline. Stages are discovered as the live
 * solver runs, including retries and separate bus/control passes. No saved routes. */
export class HypergraphDebugPipelineSolver extends BasePipelineSolver<SimpleRouteJson> {
  readonly engine: HypergraphBusLanesSolver
  pipelineDef: PipelineStep<HypergraphPhaseSolver>[] = []
  constructor(input: SimpleRouteJson) {
    super(input)
    this.engine = new HypergraphBusLanesSolver(input)
    this.MAX_ITERATIONS = this.engine.MAX_ITERATIONS * 2
    this.appendStage()
  }
  private appendStage() {
    const phaseNames: Record<string, string> = {
      resolve_layers: "LocalDogbones",
      local_dogbones: "InitializeLanes",
      lanes_route: "HypergraphRouting",
      lanes_hypergraph_cover: "RouteCleanup",
      lanes_route_cleanup: "RouteCleanup",
      lanes_match: "SelectTuningCorridor",
      lanes_tuning_corridor: "PrepareLengthMatching",
      lanes_length_matching: "LengthMatching",
      lanes_validate_output: "ValidateAndAssemble",
      remaining_signals: "InitializeControls",
      retry_layers: "RetryLocalDogbones",
    }
    this.pipelineDef.push({
      solverName: `${String(this.pipelineDef.length + 1).padStart(2, "0")}_${phaseNames[this.engine.phase] ?? this.engine.phase}`,
      solverClass: HypergraphPhaseSolver,
      getConstructorParams: () => [this.engine],
      onSolved: () => {
        if (!this.engine.solved) this.appendStage()
      },
    })
  }
  getConstructorParams() {
    return [this.inputProblem]
  }
  _step() {
    super._step()
    this.stats = { ...this.engine.stats, phase: this.engine.phase }
    this.progress = this.engine.progress
  }
  visualize() {
    return this.solved
      ? super.visualize()
      : compactGraphics(this.engine.visualize())
  }
  getOutput() {
    return this.engine.getOutput()
  }
  initialVisualize() {
    return compactGraphics(
      new HypergraphBusLanesSolver(this.inputProblem).visualize(),
    )
  }
}

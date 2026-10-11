import { GenericSolverDebugger } from "@tscircuit/solver-utils/react"
import { BusLanesPipelineSolver, BusLanesSolver } from "../lib"
import { loadG350Am3352Sample } from "../scripts/g350-am3352-sample"

const input = loadG350Am3352Sample()
export default (
  <main style={{ fontFamily: "system-ui", padding: 20 }}>
    <h1>G350 AM3352 / 49 DDR signals on top and bottom</h1>
    <p>
      AM3352BZCZ100 and MT41K256M16TW-107:P, RAM rotated 270°. Real geometry for
      194 components and 854 pads, including power, clock, reset and decoupling.
      No cached DDR paths or omitted NC pads.
    </p>
    <p>
      Four physical layers; DDR wires use top and bottom. All three bus skew
      limits are 0.635 mm and all three pair limits are 0.127 mm. Support nets
      are retained in the complete fixture and require a separate routing stage.
      The input view and solver progress do not establish successful routing.
    </p>
    <GenericSolverDebugger
      createSolver={() => {
        const solver = new BusLanesPipelineSolver(input)
        const fallback = new BusLanesSolver(input).visualize()
        const visualize = solver.visualize.bind(solver)
        solver.visualize = () => {
          const graphics = visualize()
          return graphics.lines?.length || graphics.points?.length
            ? graphics
            : fallback
        }
        return solver
      }}
    />
  </main>
)

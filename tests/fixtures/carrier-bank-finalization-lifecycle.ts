import assert from "node:assert/strict"
import { mock, spyOn } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import type { FlexibleSignalState } from "../../lib/flexible-signal-state"
import type { Point, SimpleRouteJson, Trace } from "../../lib/types"
import type { Copper, VectorScene } from "../../lib/vector-scene"
import type {
  CarrierShapeCandidate,
  CarrierShapeWorkCache,
} from "../../lib/finalize-carrier-arc-pair"
import type { CandidateDomainFailure } from "../../lib/prune-candidate-domains"

// Direct-run, sequential MOCK-ONLY worker. It exercises the real queue,
// copper predicates, finite AC/CSP and finalizer using supplied toy bodies.
// No Grid search, whole-board routing or G350 qualification runs here.
let assertions = 0
const equal = (actual: unknown, expected: unknown) => {
  assertions++
  assert.strictEqual(actual, expected)
}
const deep = (actual: unknown, expected: unknown) => {
  assertions++
  assert.deepStrictEqual(actual, expected)
}
const ok = (condition: unknown, message?: string) => {
  assertions++
  if (message === undefined) assert.ok(condition)
  else assert.ok(condition, message)
}
const cases: Array<{ name: string; work: () => void }> = []
const test = (name: string, work: () => void) => cases.push({ name, work })
interface Candidate extends CarrierShapeCandidate {
  id: number
  scene: VectorScene
  length: number
  hits: Candidate[]
  score: number
}
interface Started {
  name: string
  scene: VectorScene
  iteration: number
  visit: number
  steps: number
  cancels: number
  history?: Float32Array
  options: unknown
  soft: Copper[]
}
type Mode =
  | "repair"
  | "healthy"
  | "cross"
  | "support"
  | "node"
  | "bare"
  | "unknown"
interface PoolCall {
  iteration: number
  domains: readonly (readonly Candidate[])[]
  failures: CandidateDomainFailure[]
  answer: Candidate[] | null
}
interface ShapeCall {
  iteration: number
  domains: readonly (readonly Candidate[])[]
  failure: CandidateDomainFailure
  work: CarrierShapeWorkCache
  result: Array<{ original: Candidate; trace: Trace }>
}
interface Controller {
  mode: Mode
  unique: boolean
  starts: Started[]
  nativeScenes: Map<string, VectorScene>
  visits: Map<string, number>
  poolCalls: PoolCall[]
  shapes: ShapeCall[]
  comparisons: Array<[unknown, unknown]>
}
let controller: Controller
const actualGrid = await import("../../lib/grid-visibility")
const realGridPrototype = actualGrid.GridVisibilitySearch.prototype
const callableGrid = actualGrid as unknown as {
  GridVisibilitySearch: (...args: unknown[]) => unknown
}
const prohibitedConstructor = spyOn(
  callableGrid,
  "GridVisibilitySearch",
).mockImplementation(() => {
  throw Error("Actual Grid construction is prohibited in this worker")
})
const prohibitedStep = spyOn(realGridPrototype, "step").mockImplementation(
  () => {
    throw Error("Actual Grid advancement is prohibited in this worker")
  },
)
class MockProjector {
  readonly cellCount = 1
  penalizeIntersection() {}
}
class ControlledGrid {
  solved = false
  failed = false
  result: Point[] = []
  readonly observed?: Started
  constructor(
    readonly scene: VectorScene,
    readonly start: Point,
    readonly end: Point,
    readonly soft: Copper[] = [],
    readonly penalty = 0,
    readonly history?: Float32Array,
    readonly options?: unknown,
  ) {
    if (penalty < 10) {
      equal(penalty, 0)
      ok(!controller.nativeScenes.has(scene.connection.name))
      controller.nativeScenes.set(scene.connection.name, scene)
      return
    }
    const name = scene.connection.name
    equal(scene, controller.nativeScenes.get(name))
    const visit = controller.visits.get(name) ?? 0
    controller.visits.set(name, visit + 1)
    this.observed = {
      name,
      scene,
      iteration: penalty - 10,
      visit,
      steps: 0,
      cancels: 0,
      history,
      options,
      soft,
    }
    controller.starts.push(this.observed)
  }
  step() {
    if (!this.observed) {
      this.result = [this.start, this.end]
      this.solved = true
      return
    }
    const observed = this.observed
    observed.steps++
    if (controller.mode === "unknown" && observed.name === "A") return
    if (controller.mode === "healthy") this.result = [this.start, this.end]
    else if (
      controller.mode === "cross" &&
      observed.name === "A" &&
      controller.unique
    ) {
      const offset =
        observed.visit === 49
          ? 9 * 0.0001
          : observed.visit >= 50
            ? 0.0001
            : (observed.visit + 1) * 0.0001
      this.result = [
        this.start,
        { x: 1, y: offset },
        { x: 3, y: offset },
        this.end,
      ]
    } else if (controller.mode === "cross") this.result = [this.start, this.end]
    else if (observed.name === "A")
      this.result = [this.start, { x: 3, y: 0 }, this.end]
    else this.result = [this.start, this.end]
    this.solved = true
  }
  cancel() {
    if (this.observed) this.observed.cancels++
  }
}
mock.module("../../lib/grid-visibility", () => ({
  ...actualGrid,
  GridVisibilitySearch: ControlledGrid,
  GridHistoryProjector: MockProjector,
}))
const { negotiateSignalSites } = await import(
  "../../lib/negotiate-signal-sites"
)
const dogbones = await import("../../lib/alternate-signal-dogbones")
const pool = await import("../../lib/solve-signal-candidate-pool")
const finalizer = await import("../../lib/finalize-carrier-arc-pair")
const routeConflicts = await import("../../lib/route-conflict-index")
const actualSolve = pool.solveSignalCandidatePool
const actualFinalize = finalizer.finalizeCarrierArcPair
const actualConflict = routeConflicts.RouteConflictIndex.prototype.firstConflict

function fixture(mode: Mode): FlexibleSignalState {
  const endpoints =
    mode === "cross"
      ? [
          [
            [0, 0],
            [4, 0],
          ],
          [
            [2, -1],
            [2, 1],
          ],
        ]
      : [
          [
            [0, 0],
            [3, 3],
          ],
          [
            [2.95, 0.05],
            [2.95, 1],
          ],
        ]
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["bottom"],
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    minBoardEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 5, minY: -2, maxY: 5 },
    obstacles: [],
    traces: [],
    connections: ["A", "B"].map((name, index) => ({
      name,
      pointsToConnect: endpoints[index].map(([x, y]) => ({
        x,
        y,
        layer: "bottom",
      })),
    })),
  }
  return {
    native,
    pending: structuredClone(native),
    traces: [],
    retained: [],
    escapes: [],
  }
}
function harness(mode: Mode, unique = false) {
  controller = {
    mode,
    unique,
    starts: [],
    nativeScenes: new Map(),
    visits: new Map(),
    poolCalls: [],
    shapes: [],
    comparisons: [],
  }
  const state = fixture(mode)
  const before = structuredClone(state)
  const generated = spyOn(
    dogbones,
    "routeAlternateSignalDogbones",
  ).mockImplementation(() => {
    throw Error("Controlled one-site fixture offers no alternate dogbone")
  })
  const solve = spyOn(pool, "solveSignalCandidatePool").mockImplementation(
    function <T>(...args: Parameters<typeof actualSolve<T>>) {
      equal(args[2], 4000)
      equal(args[3], 1_000_000)
      equal(typeof args[4], "function")
      const record: PoolCall = {
        iteration: controller.starts.at(-1)!.iteration,
        domains: args[0] as readonly (readonly Candidate[])[],
        failures: [],
        answer: null,
      }
      controller.poolCalls.push(record)
      const callback = args[4]
      const answer =
        controller.mode === "bare"
          ? null
          : actualSolve<T>(
              args[0],
              args[1],
              controller.mode === "node" ? 0 : args[2],
              controller.mode === "support" ? 0 : args[3],
              callback
                ? (failure) => {
                    record.failures.push(failure)
                    callback(failure)
                  }
                : undefined,
            )
      record.answer = answer as Candidate[] | null
      return answer
    },
  )
  const shape = spyOn(finalizer, "finalizeCarrierArcPair").mockImplementation(
    function <T extends CarrierShapeCandidate>(
      ...args: Parameters<typeof actualFinalize<T>>
    ) {
      const result = actualFinalize<T>(...args)
      controller.shapes.push({
        iteration: controller.starts.at(-1)!.iteration,
        domains: args[2] as unknown as readonly (readonly Candidate[])[],
        failure: args[3],
        work: args[4],
        result: result as unknown as Array<{
          original: Candidate
          trace: Trace
        }>,
      })
      return result
    },
  )
  const comparison = spyOn(
    routeConflicts.RouteConflictIndex.prototype,
    "firstConflict",
  ).mockImplementation(function (
    this: InstanceType<typeof routeConflicts.RouteConflictIndex>,
    ...args: Parameters<typeof actualConflict>
  ) {
    controller.comparisons.push([args[0], args[1]])
    return actualConflict.apply(this, args)
  })
  return {
    state,
    before,
    controller,
    restore() {
      generated.mockRestore()
      solve.mockRestore()
      shape.mockRestore()
      comparison.mockRestore()
      deep(state, before)
      equal(prohibitedConstructor.mock.calls.length, 0)
      equal(prohibitedStep.mock.calls.length, 0)
    },
  }
}
function run(
  h: ReturnType<typeof harness>,
  partial = false,
  stop: () => boolean = () => false,
) {
  const iterator = negotiateSignalSites(
    h.state,
    new Set(["A", "B"]),
    partial,
    false,
    {
      allowExpandedSites: false,
      onSiteDomainFailure: () => {
        throw Error("The two native one-site escape banks are compatible")
      },
    },
  )
  let next = iterator.next()
  let yields = 0
  try {
    while (!next.done && !stop() && yields < 40_000) {
      next = iterator.next()
      yields++
    }
    ok(
      yields < 40_000,
      "Mock lifecycle must finish inside its explicit yield budget",
    )
    return {
      done: !!next.done,
      result: next.value as FlexibleSignalState | null | undefined,
      yields,
    }
  } finally {
    if (!next.done) iterator.return(null)
  }
}
function checkSlots(h: ReturnType<typeof harness>) {
  equal(h.controller.nativeScenes.size, 2)
  const iterations = new Set<number>()
  const history = h.controller.starts[0].history
  for (const start of h.controller.starts) {
    ok(
      !iterations.has(start.iteration),
      "One original site means exactly one constructor per scheduled iteration",
    )
    iterations.add(start.iteration)
    equal(start.scene, h.controller.nativeScenes.get(start.name))
    equal(start.cancels, 1)
    ok(start.steps >= 1 && start.steps <= 3000)
    equal(start.history, history)
    ok(start.history instanceof Float32Array)
    deep(start.options, {
      checkReachability: true,
      maxLength: Infinity,
      paretoLength: false,
    })
    ok(start.iteration < 1200)
  }
  const selects = new Set<number>()
  for (const call of h.controller.poolCalls) {
    equal(call.iteration % 8, 0)
    ok(
      !selects.has(call.iteration),
      "One CSP call per existing scheduled selection",
    )
    selects.add(call.iteration)
    for (const domain of call.domains) {
      ok(domain.length >= 1 && domain.length <= 48)
      equal(
        new Set(domain.map((candidate) => candidate.id)).size,
        domain.length,
      )
      equal(
        new Set(
          domain.map((candidate) =>
            JSON.stringify([
              candidate.escapes.map((escape) => escape.route),
              candidate.trace.route,
            ]),
          ),
        ).size,
        domain.length,
      )
    }
  }
}

test("finite select8 evidence augments the bank and only scheduled select16 accepts it", () => {
  const h = harness("repair")
  try {
    const outcome = run(
      h,
      false,
      () =>
        h.controller.poolCalls.length >= 2 &&
        h.controller.poolCalls[1].answer === null,
    )
    checkSlots(h)
    deep(
      h.controller.poolCalls.map((call) => call.iteration),
      [8, 16],
    )
    ok(
      h.controller.poolCalls[1].answer,
      "The next existing select16 must accept the augmented bank",
    )
    equal(h.controller.shapes.length, 1)
    const first = h.controller.poolCalls[0],
      next = h.controller.poolCalls[1],
      shape = h.controller.shapes[0]
    equal(first.failures.length, 1)
    equal(first.answer, null)
    equal(next.failures.length, 0)
    equal(outcome.done, true)
    ok(outcome.result)
    equal(shape.iteration, 8)
    equal(shape.domains, first.domains)
    deep(shape.failure, first.failures[0])
    equal(shape.result.length, 2)
    equal(shape.result[0].original, first.domains[0][0])
    equal(shape.result[1].original, first.domains[1][0])
    equal(next.domains[0].length, 2)
    equal(next.domains[1].length, 1)
    const rawA = first.domains[0][0],
      rawB = first.domains[1][0]
    const shapedA = next.domains[0].find((candidate) => candidate !== rawA)!
    ok(shapedA.id > Math.max(rawA.id, rawB.id))
    equal(shapedA.scene, rawA.scene)
    equal(shapedA.connection, rawA.connection)
    equal(shapedA.escapes, rawA.escapes)
    equal(shapedA.escapeCopper, rawA.escapeCopper)
    equal(shapedA.maxLength, rawA.maxLength)
    equal(shapedA.trace, shape.result[0].trace)
    equal(next.domains[0][1], rawA)
    equal(next.domains[1][0], rawB)
    equal(next.answer![0], shapedA)
    equal(next.answer![1], rawB)
    equal(
      h.controller.comparisons.filter(
        ([a, b]) =>
          (a === rawA.trace.route && b === rawB.trace.route) ||
          (a === rawB.trace.route && b === rawA.trace.route),
      ).length,
      1,
    )
    equal(h.controller.starts.length, 17)
    deep(
      h.controller.starts.map(({ name, iteration }) => [name, iteration]),
      Array.from({ length: 17 }, (_, iteration) => [
        iteration % 2 === 0 ? "A" : "B",
        iteration,
      ]),
    )
    const completed = outcome.result as FlexibleSignalState
    equal(completed.traces.length, 2)
    const drc = validateRoutedCopperDrc({
      inputSrj: h.state.native,
      routedSrj: { ...h.state.native, traces: completed.traces },
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as unknown as Parameters<typeof validateRoutedCopperDrc>[0])
    equal(drc.valid, true)
    deep(drc.issues, [])
  } finally {
    h.restore()
  }
})

test("healthy direct carriers finish with their cheap prefix and no shaping", () => {
  const h = harness("healthy")
  try {
    const outcome = run(h)
    equal(outcome.done, true)
    ok(outcome.result)
    equal(outcome.result!.traces.length, 2)
    deep(
      h.controller.starts.map(({ name, iteration }) => [name, iteration]),
      [
        ["A", 0],
        ["B", 1],
      ],
    )
    equal(h.controller.poolCalls.length, 0)
    equal(h.controller.shapes.length, 0)
    for (const body of outcome.result!.traces) {
      deep(
        body.route.map(({ x, y }) => ({ x, y })),
        h.state.native.connections
          .find((connection) => connection.name === body.connection_name)!
          .pointsToConnect.map(({ x, y }) => ({ x, y })),
      )
    }
    checkSlots(h)
  } finally {
    h.restore()
  }
})

test("partial seed returns its original one route without finalization", () => {
  const h = harness("repair")
  try {
    const outcome = run(h, true)
    equal(outcome.done, true)
    equal(outcome.result!.traces.length, 1)
    equal(outcome.result!.traces[0].connection_name, "A")
    equal(h.controller.starts.length, 1)
    equal(h.controller.poolCalls.length, 0)
    equal(h.controller.shapes.length, 0)
    checkSlots(h)
  } finally {
    h.restore()
  }
})

test("bare and support-budget nulls create no fabricated finite opportunity", () => {
  for (const mode of ["bare", "support"] as const) {
    const h = harness(mode)
    try {
      const outcome = run(h, false, () => h.controller.poolCalls.length === 3)
      equal(outcome.done, false)
      deep(
        h.controller.poolCalls.map((call) => call.iteration),
        [8, 16, 24],
      )
      equal(h.controller.poolCalls.flatMap((call) => call.failures).length, 0)
      equal(h.controller.shapes.length, 0)
      checkSlots(h)
    } finally {
      h.restore()
    }
  }
})

test("node cap unknown after real select8 shaping does not manufacture another proof", () => {
  const h = harness("node")
  try {
    const outcome = run(h, false, () => h.controller.poolCalls.length === 3)
    equal(outcome.done, false)
    deep(
      h.controller.poolCalls.map((call) => call.iteration),
      [8, 16, 24],
    )
    deep(
      h.controller.poolCalls.map((call) => call.failures.length),
      [1, 0, 0],
    )
    equal(h.controller.shapes.length, 1)
    equal(h.controller.shapes[0].iteration, 8)
    equal(h.controller.poolCalls[1].domains[0].length, 2)
    equal(h.controller.poolCalls[1].answer, null)
    equal(h.controller.poolCalls[2].answer, null)
    checkSlots(h)
  } finally {
    h.restore()
  }
})

test("ordinary Grid work remains capped at 3000 steps and cancels on continuation", () => {
  const h = harness("unknown")
  try {
    const outcome = run(
      h,
      false,
      () =>
        h.controller.starts.length === 2 && h.controller.starts[1].steps > 0,
    )
    equal(outcome.done, false)
    equal(h.controller.starts[0].steps, 3000)
    equal(h.controller.starts[0].cancels, 1)
    equal(h.controller.shapes.length, 0)
    equal(h.controller.poolCalls.length, 0)
    checkSlots(h)
  } finally {
    h.restore()
  }
})

test("a completed unresolved supplied crossing preserves the 1200-iteration cap", () => {
  const h = harness("cross")
  try {
    const outcome = run(h)
    equal(outcome.done, true)
    equal(outcome.result, null)
    equal(h.controller.starts.length, 1200)
    equal(h.controller.starts[0].iteration, 0)
    equal(h.controller.starts.at(-1)!.iteration, 1199)
    equal(h.controller.poolCalls.length, 149)
    equal(h.controller.shapes.length, 149)
    ok(h.controller.shapes.every((shape) => shape.result.length === 0))
    equal(new Set(h.controller.shapes.map((shape) => shape.work)).size, 1)
    equal(h.controller.shapes[0].work.size, 1)
    checkSlots(h)
  } finally {
    h.restore()
  }
})

test("the actual pool holds its first eight, caps at48, and readmits evicted signatures", () => {
  const h = harness("cross", true)
  try {
    const outcome = run(
      h,
      false,
      () => h.controller.poolCalls.at(-1)?.iteration === 112,
    )
    equal(outcome.done, false)
    const first = h.controller.poolCalls[0].domains[0].at(-1)!
    const ninthCall = h.controller.poolCalls.find(
      (call) => call.iteration === 16,
    )!
    const firstNine = [...ninthCall.domains[0]].reverse()
    equal(firstNine.length, 9)
    const held = firstNine.slice(0, 8),
      ninth = firstNine[8]
    const capped = h.controller.poolCalls.find((call) => call.iteration === 96)!
      .domains[0]
    equal(capped.length, 48)
    ok(held.every((candidate) => capped.includes(candidate)))
    ok(!capped.includes(ninth))
    const later = h.controller.poolCalls.find((call) => call.iteration === 104)!
      .domains[0]
    equal(later.length, 48)
    const readmitted = later.find(
      (candidate) =>
        JSON.stringify(candidate.trace.route) ===
        JSON.stringify(ninth.trace.route),
    )!
    ok(readmitted)
    ok(readmitted !== ninth)
    ok(readmitted.id > ninth.id)
    equal(readmitted.scene, ninth.scene)
    equal(readmitted.connection, ninth.connection)
    equal(readmitted.escapes, ninth.escapes)
    ok(held.every((candidate) => later.includes(candidate)))
    equal(
      later.filter(
        (candidate) =>
          JSON.stringify(candidate.trace.route) ===
          JSON.stringify(first.trace.route),
      ).length,
      1,
    )
    equal(
      Math.max(
        ...h.controller.poolCalls.flatMap((call) =>
          call.domains.map((domain) => domain.length),
        ),
      ),
      48,
    )
    const rawB = h.controller.poolCalls[0].domains[1][0]
    equal(
      h.controller.comparisons.filter(
        ([a, b]) =>
          (a === first.trace.route && b === rawB.trace.route) ||
          (a === rawB.trace.route && b === first.trace.route),
      ).length,
      1,
    )
    ok(h.controller.shapes.every((shape) => shape.result.length === 0))
    checkSlots(h)
  } finally {
    h.restore()
  }
})

const requested = process.argv[2]
const selected = cases.filter(
  ({ name }) => !requested || name.includes(requested),
)
ok(selected.length, "No matching lifecycle cases; refusing an empty success")
let completed = 0
try {
  for (const item of selected) {
    item.work()
    completed++
    process.stdout.write(`PASS ${item.name}\n`)
  }
  process.stdout.write(
    `${JSON.stringify({ mode: "MOCK_ONLY", registeredCases: cases.length, completedCases: completed, assertions, actualGridConstructedOrAdvanced: false, actualNegotiationQueue: true, realGeometryAndACAndCSPAndFinalization: true, nativeCheckerScope: "two supplied toy paths only", full43Or49: false, positiveCacheAfterCallerEvictionQualified: false })}\n`,
  )
} finally {
  prohibitedStep.mockRestore()
  prohibitedConstructor.mockRestore()
}

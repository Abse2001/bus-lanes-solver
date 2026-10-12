import { mock } from "bun:test"
import assert from "node:assert/strict"
import type { SimpleRouteJson } from "../../lib/types"

// This direct-run fixture is not discovered as a test file. All export doubles
// remain in this subprocess; the ordinary suite retains the real Grid exports.
let assertions = 0
const equal = (actual: unknown, expected: unknown) => {
  assertions++
  assert.equal(actual, expected)
}
const deepEqual = (actual: unknown, expected: unknown) => {
  assertions++
  assert.deepEqual(actual, expected)
}
const throws = (work: () => unknown, pattern: RegExp) => {
  assertions++
  assert.throws(work, pattern)
}
const counters = {
  gridConstructors: 0,
  projectorConstructors: 0,
  connectivityConstructors: 0,
  nativeProducerFactories: 0,
  steps: 0,
}
const originalGrid = await import("../../lib/grid-visibility")
deepEqual(Object.keys(originalGrid).sort(), ["GridHistoryProjector", "GridVisibilitySearch"])
class ProhibitedGrid {
  constructor() {
    counters.gridConstructors++
    throw Error("Grid construction is prohibited in this boundary test")
  }
  step() {
    counters.steps++
    throw Error("Grid advancement is prohibited")
  }
}
class ProhibitedProjector {
  constructor() {
    counters.projectorConstructors++
    throw Error("Projector construction is prohibited in this boundary test")
  }
  step() {
    counters.steps++
    throw Error("Projector advancement is prohibited")
  }
}
mock.module(new URL("../../lib/grid-visibility.ts", import.meta.url).pathname, () => ({
  ...originalGrid,
  GridVisibilitySearch: ProhibitedGrid,
  GridHistoryProjector: ProhibitedProjector,
}))
const originalConnectivity = await import("../../lib/single-layer-connectivity-solver")
const originalNative = await import("../../lib/route-matched-native-single-carrier")
deepEqual(Object.keys(originalConnectivity).sort(), ["SingleLayerConnectivitySolver"])
deepEqual(Object.keys(originalNative).sort(), ["nativeSingleCarrierEligible", "routeMatchedNativeSingleCarrier"])
class ProhibitedConnectivityProducer {
  constructor() {
    counters.connectivityConstructors++
    console.log(JSON.stringify({ boundaryNegativeObserved: "PROHIBITED_CONNECTIVITY_PRODUCER_REACHED", ...counters }))
    throw Error("PROHIBITED_CONNECTIVITY_PRODUCER_REACHED")
  }
  step() {
    counters.steps++
    throw Error("Producer advancement is prohibited")
  }
}
mock.module(new URL("../../lib/single-layer-connectivity-solver.ts", import.meta.url).pathname, () => ({
  ...originalConnectivity,
  SingleLayerConnectivitySolver: ProhibitedConnectivityProducer,
}))
mock.module(new URL("../../lib/route-matched-native-single-carrier.ts", import.meta.url).pathname, () => ({
  ...originalNative,
  routeMatchedNativeSingleCarrier: () => {
    counters.nativeProducerFactories++
    throw Error("PROHIBITED_NATIVE_PRODUCER_REACHED")
  },
}))
const { BusLanesPipelineSolver } = await import("../../lib/bus-lanes-pipeline-solver")
const source: SimpleRouteJson = {
  layerCount: 4,
  allowedLayers: ["top", "bottom"],
  minTraceWidth: 0.1,
  obstacles: [],
  bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5 },
  connections: ["A", "B"].map((name, y) => ({
    name,
    pointsToConnect: [{ x: -2, y, layer: "top" }, { x: 2, y, layer: "top" }],
  })),
  buses: [{ busId: "bus", connectionNames: ["A", "B"] }],
}
const original = structuredClone(source)
const defaults = { smoothTuning: true, denseSearch: true }
let constructorAttempts = 0, successfulConstructors = 0, rejectedConstructors = 0
const construct = (options: Record<string, unknown>, candidate = source) => {
  constructorAttempts++
  const candidateBefore = structuredClone(candidate)
  const solver = new BusLanesPipelineSolver(
    candidate,
    options as ConstructorParameters<typeof BusLanesPipelineSolver>[1],
  )
  successfulConstructors++
  equal(solver.solved, false)
  equal(solver.failed, false)
  deepEqual(source, original)
  deepEqual(candidate, candidateBefore)
  deepEqual(solver.getConstructorParams()[0], candidateBefore)
  return solver.getConstructorParams()[1]
}
const forms = [
  (field: string, value: unknown): Record<string, unknown> => Object.create({ [field]: value }),
  (field: string, value: unknown): Record<string, unknown> => Object.defineProperty({}, field, { value }),
]
const fields = ["maxBusViaCountSkew", "maxPairViaCountSkew"] as const
const started = performance.now()
deepEqual(construct({}), defaults)
for (const field of fields) {
  for (const form of forms) {
    const options = form(field, 0)
    deepEqual(construct(options), { ...defaults, [field]: 0 })
    equal(options[field], 0)
    deepEqual(construct(form(field, undefined)), defaults)
    for (const value of [Infinity, -1, NaN]) {
      const invalid = form(field, value)
      throws(() => construct(invalid), /nonnegative integer/)
      rejectedConstructors++
      deepEqual(source, original)
      equal(invalid[field], value)
    }
  }
}
// An own enumerable undefined property was already retained by the legacy
// option spread; normalization must preserve that inert parameter shape too.
deepEqual(construct({ maxBusViaCountSkew: undefined }), {
  ...defaults, maxBusViaCountSkew: undefined,
})
let unsupportedGoalCases = 0
const unsupported = (options: Record<string, unknown>, candidate = source) => {
  throws(() => construct(options, candidate), /Via-count constraints are unsupported for this routing goal/)
  unsupportedGoalCases++
  rejectedConstructors++
  deepEqual(source, original)
  equal(counters.connectivityConstructors, 0)
  equal(counters.nativeProducerFactories, 0)
}
for (const form of forms) {
  const options = form("goal", "connectivity")
  options.maxBusViaCountSkew = 0
  unsupported(options)
}
unsupported({ goal: "connectivity", maxBusViaCountSkew: 0 })
const inner = structuredClone(source)
inner.allowedLayers = ["inner1"]
inner.differentialPairs = [{ connectionNames: ["A", "B"], lengthTolerance: 0.127 }]
const innerBefore = structuredClone(inner)
equal(originalNative.nativeSingleCarrierEligible(inner), true)
unsupported({ maxPairViaCountSkew: 0 }, inner)
for (const form of forms) {
  const options = form("fanout", "none")
  options.maxPairViaCountSkew = 0
  deepEqual(construct(options, inner), { ...defaults, maxPairViaCountSkew: 0 })
}
deepEqual(inner, innerBefore)
deepEqual(counters, {
  gridConstructors: 0, projectorConstructors: 0,
  connectivityConstructors: 0, nativeProducerFactories: 0, steps: 0,
})
equal(constructorAttempts, 28)
equal(successfulConstructors, 12)
equal(rejectedConstructors, 16)
assert.ok(performance.now() - started < 1500)
assertions++
console.log(JSON.stringify({
  mode: "PROCESS_ISOLATED_MOCK_CONSTRUCTOR_BOUNDARY",
  actualPipelineConstructor: true,
  constructorAttempts, successfulConstructors, rejectedConstructors, assertions,
  unsupportedGoalCases,
  gridConstructors: counters.gridConstructors,
  projectorConstructors: counters.projectorConstructors,
  connectivityConstructors: counters.connectivityConstructors,
  nativeProducerFactories: counters.nativeProducerFactories,
  solverOrGridStepCalls: counters.steps,
  originalGridRuntimeExportKeys: Object.keys(originalGrid).sort(),
  inputUnchanged: JSON.stringify(source) === JSON.stringify(original),
  physicalRoutingQualified: false,
}))

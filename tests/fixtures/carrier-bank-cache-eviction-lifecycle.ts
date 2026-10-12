import assert from "node:assert/strict"
import { mock, spyOn } from "bun:test"
import type { FlexibleSignalState } from "../../lib/flexible-signal-state"
import type { Point, SimpleRouteJson, Trace, Wire } from "../../lib/types"
import type { Copper, VectorScene } from "../../lib/vector-scene"
import type { CarrierShapeCandidate } from "../../lib/finalize-carrier-arc-pair"

// Direct-run MOCK ONLY. All mutations below concern the doubles' controller;
// source banks, cache, certificate, queue and input scene are never edited.
type Candidate = CarrierShapeCandidate & { id: number; scene: VectorScene }
let assertions = 0
const equal = (a: unknown, b: unknown) => { assertions++; assert.strictEqual(a, b) }
const deep = (a: unknown, b: unknown) => { assertions++; assert.deepStrictEqual(a, b) }
const ok = (value: unknown, message: string) => { assertions++; assert.ok(value, message) }
const signature = (candidate: CarrierShapeCandidate, body = candidate.trace) => JSON.stringify([candidate.escapes.map((escape) => escape.route), body.route])
const siteKey = (scene: VectorScene) => JSON.stringify(scene.connection.pointsToConnect)
interface Start { name: string; scene: VectorScene; iteration: number; visit: number; steps: number; cancels: number }
interface Positive { original: Candidate; blocker: Candidate; body: Trace; key: string; originalEvicted: boolean }
const starts: Start[] = []
const nativeSites = new Map<string, VectorScene[]>()
const visits = new Map<string, { iteration: number; visit: number }>()
const positives: Positive[] = []
const poolCalls: Array<{ iteration: number; domains: readonly (readonly Candidate[])[]; failures: number; selected: Candidate[] | null }> = []
const evictions: Array<{ id: number; name: string; iteration: number; body: string }> = []
let pending: Positive | undefined
let regenerated: Candidate | undefined
let reoffer: { original: Candidate; body: Trace; iteration: number; previousId: number } | undefined
let admitted: Candidate | undefined
let nativeSteps = 0
let normalizations = 0
let currentIteration = -1
let stoppedFlood = false

const actualGrid = await import("../../lib/grid-visibility")
const realGridPrototype = actualGrid.GridVisibilitySearch.prototype
const callableGrid = actualGrid as unknown as { GridVisibilitySearch: (...args: unknown[]) => unknown }
const constructorGuard = spyOn(callableGrid, "GridVisibilitySearch").mockImplementation(() => { throw Error("Actual Grid construction prohibited") })
const stepGuard = spyOn(realGridPrototype, "step").mockImplementation(() => { throw Error("Actual Grid advancement prohibited") })
class Projector { readonly cellCount = 1; penalizeIntersection() {} }
class ControlledGrid {
  solved = false
  failed = false
  result: Point[] = []
  readonly observed?: Start
  constructor(readonly scene: VectorScene, readonly start: Point, readonly end: Point, _soft: Copper[] = [], penalty = 0, _history?: Float32Array, options?: unknown) {
    if (penalty < 10) {
      const sites = nativeSites.get(scene.connection.name) ?? []
      sites.push(scene); nativeSites.set(scene.connection.name, sites)
      return
    }
    currentIteration = penalty - 10
    const name = scene.connection.name
    const previous = visits.get(name)
    const visit = previous?.iteration === currentIteration ? previous.visit : (previous?.visit ?? -1) + 1
    visits.set(name, { iteration: currentIteration, visit })
    ok(nativeSites.get(name)!.includes(scene), "Every carrier uses its exact original SiteOption scene")
    deep(options, { checkReachability: true, maxLength: Infinity, paretoLength: false })
    this.observed = { name, scene, iteration: currentIteration, visit, steps: 0, cancels: 0 }
    starts.push(this.observed)
  }
  step() {
    if (!this.observed) { nativeSteps++; this.result = [this.start, this.end]; this.solved = true; return }
    this.observed.steps++
    if (this.observed.name === "A") {
      if (pending && !regenerated && siteKey(this.scene) === siteKey(pending.original.scene)) {
        this.result = pending.original.trace.route.map(({ x, y }) => ({ x, y }))
      } else if (stoppedFlood || this.observed.visit < 3) {
        this.result = [this.start, { x: this.end.x, y: this.start.y }, this.end]
      } else {
        const shift = this.observed.visit * 0.0001
        this.result = [this.start, { x: this.end.x + shift, y: this.start.y }, { x: this.end.x + shift, y: this.end.y }, this.end]
      }
    } else if (this.observed.name === "C" && reoffer) {
      this.result = [this.start, { x: 0.2, y: 2.1 }, { x: 0.2, y: 3.2 }, { x: 0.5, y: 3.5 }, { x: 2.7, y: 3.5 }, { x: 3, y: 3.2 }, this.end]
    } else this.result = [this.start, this.end]
    this.solved = true
  }
  cancel() { if (this.observed) this.observed.cancels++ }
}
mock.module("../../lib/grid-visibility", () => ({ ...actualGrid, GridVisibilitySearch: ControlledGrid, GridHistoryProjector: Projector }))
const { negotiateSignalSites } = await import("../../lib/negotiate-signal-sites")
const dogbones = await import("../../lib/alternate-signal-dogbones")
const pool = await import("../../lib/solve-signal-candidate-pool")
const helper = await import("../../lib/finalize-carrier-arc-pair")
const normalize = await import("../../lib/normalize-surface-carriers")
const actualSolve = pool.solveSignalCandidatePool
const actualFinalize = helper.finalizeCarrierArcPair
const actualNormalize = normalize.normalizeSurfaceCarriers
const actualSplice = Array.prototype.splice

const native: SimpleRouteJson = {
  layerCount: 4, allowedLayers: ["bottom"], minTraceWidth: 0.1,
  minTraceToPadEdgeClearance: 0.1, minBoardEdgeClearance: 0.1,
  minViaPadDiameter: 0.3, minViaHoleDiameter: 0.15, minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
  bounds: { minX: -2, maxX: 6, minY: -2, maxY: 6 }, obstacles: [], traces: [],
  connections: [
    { name: "A", pointsToConnect: [{ x: 0, y: 0, layer: "top" }, { x: 3, y: 3, layer: "top" }] },
    { name: "B", pointsToConnect: [{ x: 1.45, y: 0.1, layer: "bottom" }, { x: 1.45, y: 1, layer: "bottom" }] },
    { name: "C", pointsToConnect: [{ x: 1, y: 1.3, layer: "bottom" }, { x: 3, y: 1.3, layer: "bottom" }] },
  ],
}
const state: FlexibleSignalState = { native, pending: structuredClone(native), traces: [], retained: [], escapes: [] }
const before = structuredClone(state)
const context = JSON.stringify(native)
const dogboneSpy = spyOn(dogbones, "routeAlternateSignalDogbones").mockImplementation((input, _options, variant) => {
  const connection = input.connections[0]
  if (connection.name !== "A") throw Error("B and C offer one native surface site")
  const values = [variant % 2 === 0 ? 0.4 : 0.8, 1.4 + variant * 0.4]
  const traces: Trace[] = values.map((value, index) => ({
    type: "pcb_trace", pcb_trace_id: `mock_owned_A_${index}_${variant}`, connection_name: "A", source_trace_id: "A",
    route: [
      { ...connection.pointsToConnect[index], route_type: "wire", width: 0.1 },
      { x: value, y: value, route_type: "wire", layer: "top", width: 0.1 },
      { x: value, y: value, route_type: "via", from_layer: "top", to_layer: "bottom", layers: ["top", "inner1", "inner2", "bottom"], via_diameter: 0.3, via_hole_diameter: 0.15 },
      { x: value, y: value, route_type: "wire", layer: "bottom", width: 0.1 },
    ],
  }))
  return { connections: [{ ...connection, pointsToConnect: traces.map((body) => body.route.at(-1)!) }], traces } as ReturnType<typeof dogbones.routeAlternateSignalDogbones>
})
const normalizationSpy = spyOn(normalize, "normalizeSurfaceCarriers").mockImplementation((...args) => { normalizations++; return actualNormalize(...args) })
const spliceSpy = spyOn(Array.prototype, "splice").mockImplementation(function (this: Candidate[], ...args: unknown[]) {
  const watched = args[0] === 8 && args[1] === 1 && this.length === 49 && typeof this[8]?.id === "number" && this[8]?.connection?.name === "A"
  const result = Reflect.apply(actualSplice, this, args) as Candidate[]
  if (watched) {
    const evicted = result[0]
    evictions.push({ id: evicted.id, name: evicted.connection.name, iteration: currentIteration, body: signature(evicted) })
    for (const record of positives) if (record.original === evicted) record.originalEvicted = true
    if (!pending) {
      const newest = this.at(-1)!
      const record = positives.find((positive) => positive.originalEvicted && signature(positive.original, positive.body) === signature(evicted) && !this.some((candidate) => signature(candidate) === signature(positive.original, positive.body)) && siteKey(newest.scene) !== siteKey(positive.original.scene))
      if (record) { pending = record; stoppedFlood = true }
    }
  }
  return result
})
const solveSpy = spyOn(pool, "solveSignalCandidatePool").mockImplementation(function <T>(...args: Parameters<typeof actualSolve<T>>) {
  equal(args[2], 4000); equal(args[3], 1_000_000); equal(typeof args[4], "function")
  const domains = args[0] as readonly (readonly Candidate[])[]
  const record = { iteration: currentIteration, domains, failures: 0, selected: null as Candidate[] | null }
  poolCalls.push(record)
  if (pending && !regenerated) {
    const matching = domains.flat().find((candidate) => candidate.connection.name === "A" && signature(candidate) === signature(pending!.original))
    if (matching && matching !== pending.original) regenerated = matching
  }
  if (reoffer && !admitted) admitted = domains.flat().find((candidate) => signature(candidate) === signature(reoffer!.original, reoffer!.body))
  const callback = args[4]
  const answer = actualSolve<T>(args[0], args[1], args[2], args[3], callback ? (failure) => { record.failures++; callback(failure) } : undefined)
  record.selected = answer as Candidate[] | null
  return answer
})
const helperSpy = spyOn(helper, "finalizeCarrierArcPair").mockImplementation(function <T extends CarrierShapeCandidate>(...args: Parameters<typeof actualFinalize<T>>) {
  equal(JSON.stringify(args[0]), context)
  deep(args[1], [])
  const previousKeys = new Set(args[4].keys())
  const previousNormalizations = normalizations
  const result = actualFinalize<T>(...args)
  const a = result.find((item) => item.original.connection.name === "A")
  const b = result.find((item) => item.original.connection.name === "B")
  if (a && b) {
    const original = a.original as unknown as Candidate
    const blocker = b.original as unknown as Candidate
    const key = [...args[4].keys()].find((key) => {
      const cached = args[4].get(key)
      return cached && JSON.stringify(cached) === JSON.stringify(result.map((item) => item.trace.route))
    })!
    if (normalizations > previousNormalizations) positives.push({ original, blocker, body: a.trace, key, originalEvicted: false })
    else if (!reoffer && pending && regenerated === original && previousKeys.has(key) && !args[2].flat().some((candidate) => signature(candidate) === signature(original, a.trace))) {
      reoffer = { original, body: a.trace, iteration: currentIteration, previousId: pending.original.id }
    }
  }
  return result
})

const iterator = negotiateSignalSites(state, new Set(["A", "B", "C"]), false, false, {
  allowExpandedSites: false,
  onSiteDomainFailure: () => { throw Error("The offered native approaches must remain compatible") },
})
let next = iterator.next()
let yields = 0
try {
  while (!next.done && yields < 50_000) { next = iterator.next(); yields++ }
  const diagnostic = { mode: "MOCK_ONLY", yields, done: !!next.done, returnedRoutes: next.done && next.value ? next.value.traces.length : 0, nativeSiteCounts: [...nativeSites].map(([name, sites]) => [name, sites.length]), starts: starts.length, selects: poolCalls.length, positives: positives.length, evictions: evictions.length, pending: pending ? { originalId: pending.original.id, originalSite: siteKey(pending.original.scene), originalEvicted: pending.originalEvicted } : null, regeneratedId: regenerated?.id, reoffer: reoffer ? { iteration: reoffer.iteration, originalId: reoffer.original.id } : null, admittedId: admitted?.id, lastIteration: starts.at(-1)?.iteration, maxPool: Math.max(...poolCalls.flatMap((call) => call.domains.map((domain) => domain.length))) }
  process.stdout.write(`${JSON.stringify(diagnostic)}\n`)
  ok(yields < 50_000, "Explicit mock yield budget remains unchanged")
  equal(nativeSites.get("A")!.length, 8)
  equal(nativeSites.get("B")!.length, 1)
  equal(nativeSites.get("C")!.length, 1)
  ok(pending, "Actual source48 eviction must identify an evicted cached body and raw reference")
  ok(regenerated && regenerated.id > pending!.original.id, "A normal scheduled search must regenerate the evicted raw geometry at fresh refs")
  ok(reoffer, "The actual helper must reoffer an evicted cached positive without new cleanup")
  ok(admitted, "Normal addCandidate must admit the cached body after evicted signature deletion")
  ok(admitted!.id > reoffer!.original.id, "Reattached copper receives a fresh candidate ID")
  equal(admitted!.scene, reoffer!.original.scene)
  equal(admitted!.connection, reoffer!.original.connection)
  equal(admitted!.escapes, reoffer!.original.escapes)
  equal(admitted!.escapeCopper, reoffer!.original.escapeCopper)
  ok(next.done && next.value && next.value.traces.length === 3, "The next scheduled real CSP must select all three compatible supplied toy routes")
  ok(poolCalls.filter((call) => call.iteration < reoffer!.iteration).every((call) => call.selected === null), "C keeps genuine pre-reoffer whole-pool assignments unresolved")
  equal(new Set(poolCalls.map((call) => call.iteration)).size, poolCalls.length)
  for (const call of poolCalls) { equal(call.iteration % 8, 0); for (const bank of call.domains) ok(bank.length <= 48, "Original48 bank cap") }
  for (const start of starts) { equal(start.steps, 1); equal(start.cancels, 1); ok(start.iteration < 1200, "Original1200 iteration cap") }
  deep(state, before)
  equal(constructorGuard.mock.calls.length, 0)
  equal(stepGuard.mock.calls.length, 0)
  process.stdout.write(`${JSON.stringify({ ...diagnostic, assertions, actualGridConstructedOrAdvanced: false, realQueueCopperACAndCSPAndHelper: true, actualCacheEvictionReofferAndAdmission: true, full43Or49: false })}\n`)
} finally {
  if (!next.done) iterator.return(null)
  dogboneSpy.mockRestore(); normalizationSpy.mockRestore(); spliceSpy.mockRestore(); solveSpy.mockRestore(); helperSpy.mockRestore()
  stepGuard.mockRestore(); constructorGuard.mockRestore()
}

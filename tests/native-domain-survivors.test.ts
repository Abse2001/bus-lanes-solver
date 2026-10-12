import { expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import * as dogbones from "../lib/alternate-signal-dogbones"
import { CopperConflictIndex } from "../lib/copper-conflict-index"
import { generatedEscapeHolesConflict } from "../lib/expanded-signal-sites"
import { finishSurfaceTiming } from "../lib/finish-surface-timing"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import {
  negotiateSignalSites,
  type SignalSiteDomainFailure,
} from "../lib/negotiate-signal-sites"
import * as pruning from "../lib/prune-candidate-domains"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"
import { fixedCopper } from "../lib/vector-scene"

const width = 0.1016
function octilinear(a: Point, b: Point): Point[] {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const bend =
    Math.abs(dx) > Math.abs(dy)
      ? { x: b.x - Math.sign(dx) * Math.abs(dy), y: a.y }
      : { x: a.x, y: b.y - Math.sign(dy) * Math.abs(dx) }
  return [a, bend, b].filter(
    (point, index, points) =>
      !index ||
      Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) >
        1e-8,
  )
}
function fixture() {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: width,
    minTraceToPadEdgeClearance: width,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    bounds: { minX: -3, maxX: 3, minY: -1, maxY: 6 },
    connections: ["A", "B"].map((name, index) => ({
      name,
      pointsToConnect: [0, 4].map((y) => ({
        x: index ? 0.8 : -0.8,
        y,
        layer: "top",
      })),
    })),
    buses: ["A", "B"].map((name) => ({
      busId: name,
      connectionNames: [name],
      allowedLayers: ["bottom"],
    })),
    obstacles: [],
    traces: [],
  }
  for (const connection of native.connections)
    for (const point of connection.pointsToConnect)
      native.obstacles.push({
        type: "rect",
        shape: "circle",
        center: point,
        width: 0.25,
        height: 0.25,
        layers: ["top"],
        connectedTo: [connection.name],
      })
  const escape = (
    name: string,
    end: number,
    viaX: number,
    viaY: number,
  ): Trace => {
    const point = native.connections.find(
      (connection) => connection.name === name,
    )!.pointsToConnect[end]
    return {
      type: "pcb_trace",
      pcb_trace_id: `owned_${name}_${end}_${viaX}`,
      connection_name: name,
      source_trace_id: name,
      route: [
        ...octilinear(point, { x: viaX, y: viaY }).map((head) => ({
          ...head,
          layer: "top",
          route_type: "wire" as const,
          width,
        })),
        {
          x: viaX,
          y: viaY,
          route_type: "via",
          from_layer: "top",
          to_layer: "bottom",
          layers: ["top", "inner1", "inner2", "bottom"],
          via_diameter: 0.4572,
          via_hole_diameter: 0.254,
        },
        { x: viaX, y: viaY, layer: "bottom", route_type: "wire", width },
      ],
    }
  }
  const option = (name: string, cpuX: number, ramX: number) => {
    const escapes = [escape(name, 0, cpuX, 0.4), escape(name, 1, ramX, 4.8)]
    return {
      escapes,
      escapeCopper: fixedCopper({ ...native, obstacles: [], traces: escapes }),
    }
  }
  const bad = option("A", 0.4, -0.4),
    good = option("A", -0.4, -0.4),
    otherGood = option("A", -0.4, -1.2),
    b = option("B", 0.4, 0.4)
  const index = new CopperConflictIndex()
  const compatible = (a: typeof bad, b: typeof bad) =>
    !generatedEscapeHolesConflict(native, a.escapes, b.escapes) &&
    !index.firstConflict(a.escapeCopper, b.escapeCopper, width - 1e-8)
  const carrier = (name: string, owned: Trace[]): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `cached_${name}`,
    connection_name: name,
    source_trace_id: name,
    route: octilinear(owned[0].route.at(-1)!, owned[1].route.at(-1)!).map(
      (point) => ({
        ...point,
        route_type: "wire",
        layer: "bottom",
        width,
      }),
    ) as Wire[],
  })
  const state = (cached = bad): FlexibleSignalState => ({
    native,
    pending: {
      ...native,
      connections: native.connections.map((connection) => ({
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((point) => ({
          ...point,
          layer: "bottom",
        })),
      })),
    },
    escapes: cached.escapes,
    retained: [],
    traces: [carrier("A", cached.escapes)],
  })
  return { native, bad, good, otherGood, b, compatible, carrier, state }
}
function drc(native: SimpleRouteJson, traces: Trace[]) {
  return validateRoutedCopperDrc({
    inputSrj: native,
    routedSrj: { ...native, traces },
    clearance: width,
    allowBlindAndBuriedVias: false,
  } as Parameters<typeof validateRoutedCopperDrc>[0])
}

test("real manufactured AC removes only the unsupported CPU landing and preserves surviving references and order", () => {
  const { native, bad, good, otherGood, b, compatible, carrier } = fixture()
  const input = [[bad, good, otherGood], [b]],
    before = structuredClone({ native, input })
  for (const option of input.flat()) {
    expect(routeAnglesAreConventional(option.escapes)).toBe(true)
    expect(drc(native, option.escapes)).toMatchObject({
      valid: true,
      issues: [],
    })
    for (const trace of option.escapes)
      expect(
        trace.route.find((point) => point.route_type === "via"),
      ).toMatchObject({
        layers: ["top", "inner1", "inner2", "bottom"],
        via_diameter: 0.4572,
        via_hole_diameter: 0.254,
      })
  }
  expect(routeAnglesAreConventional([carrier("A", bad.escapes)])).toBe(true)
  expect(compatible(bad, b)).toBe(false)
  expect(compatible(good, b)).toBe(true)
  const survivors = pruning.pruneCandidateDomains(input, compatible)
  expect(survivors).toEqual([[good, otherGood], [b]])
  expect(survivors![0][0]).toBe(good)
  expect(survivors![0][1]).toBe(otherGood)
  expect(survivors![1][0]).toBe(b)
  expect(drc(native, [...good.escapes, ...b.escapes])).toMatchObject({
    valid: true,
    issues: [],
  })
  expect({ native, input }).toEqual(before)
})

test("capped physical support checks retain unproved choices while healthy domains remain byte-identical", () => {
  const { bad, good, otherGood, b, compatible } = fixture()
  for (const maxSupportChecks of [0, 1]) {
    const input = [[bad, good], [b]],
      failures: unknown[] = []
    const retained = pruning.pruneCandidateDomains(
      input,
      compatible,
      maxSupportChecks,
      (failure) => failures.push(failure),
    )
    expect(retained).toEqual(input)
    expect(retained![0][0]).toBe(bad)
    expect(failures).toEqual([])
  }
  const healthy = [[good, otherGood], [b]]
  const retained = pruning.pruneCandidateDomains(healthy, compatible)
  expect(retained).toEqual(healthy)
  expect(retained![0][0]).toBe(good)
  expect(retained![0][1]).toBe(otherGood)
})

function negotiate(cachedGood: boolean, partial: boolean, feedback = true) {
  const f = fixture(),
    state = f.state(cachedGood ? f.good : f.bad),
    before = structuredClone(state)
  const failures: SignalSiteDomainFailure[] = []
  const carrierStarts: Array<{ name: string; x: number; soft: boolean }> = []
  let nativeAcFinished = false,
    removedCachedOption = false
  const originalPrune = pruning.pruneCandidateDomains
  const ac = spyOn(pruning, "pruneCandidateDomains").mockImplementation(
    (...args) => {
      const result = originalPrune(...args)
      if (typeof args[3] === "function") {
        nativeAcFinished = true
        const cachedSite = args[0][0].find((option) =>
          (option as unknown as { escapes: Trace[] }).escapes[0].route.some(
            (point) =>
              point.route_type === "via" &&
              point.x === (cachedGood ? -0.4 : 0.4),
          ),
        )
        expect(cachedSite).toBeDefined()
        if (cachedSite === undefined)
          throw new Error("Cached physical site disappeared before AC")
        removedCachedOption = !!result && !result[0].includes(cachedSite)
      }
      return result
    },
  )
  const generated = spyOn(
    dogbones,
    "routeAlternateSignalDogbones",
  ).mockImplementation((input, _options, attempt) => {
    const connection = input.connections[0],
      owned =
        connection.name === "B"
          ? f.b
          : attempt === 0 && !cachedGood
            ? f.bad
            : f.good
    return {
      connections: [
        {
          ...connection,
          pointsToConnect: owned.escapes.map((trace) => trace.route.at(-1)!),
        },
      ],
      traces: owned.escapes,
    } as ReturnType<typeof dogbones.routeAlternateSignalDogbones>
  })
  const originalStep = GridVisibilitySearch.prototype.step
  const grid = spyOn(GridVisibilitySearch.prototype, "step").mockImplementation(
    function (this: GridVisibilitySearch) {
      const runtime = this as unknown as {
        penalty: number
        hasSoftCopper: boolean
      }
      if (nativeAcFinished && runtime.penalty >= 10)
        carrierStarts.push({
          name: this.scene.connection.name,
          x: this.start.x,
          soft: runtime.hasSoftCopper,
        })
      return originalStep.call(this)
    },
  )
  const work = negotiateSignalSites(
    state,
    new Set(["A", "B"]),
    partial,
    false,
    {
      allowExpandedSites: false,
      retainExistingRoutes: true,
      ...(feedback
        ? {
            onSiteDomainFailure: (failure: SignalSiteDomainFailure) =>
              failures.push(failure),
          }
        : {}),
    },
  )
  let next = work.next()
  try {
    for (let steps = 0; !next.done && steps < 10000; steps++) next = work.next()
    expect(next.done).toBe(true)
    expect(next.value).toBeTruthy()
    expect(failures).toEqual([])
    expect(state).toEqual(before)
    return { f, result: next.value!, carrierStarts, removedCachedOption }
  } finally {
    if (!next.done) work.return(null)
    grid.mockRestore()
    generated.mockRestore()
    ac.mockRestore()
  }
}

test("the real complete negotiator never reseeds or reroutes an AC-removed cached native site", () => {
  const { f, result, carrierStarts, removedCachedOption } = negotiate(
    false,
    false,
  )
  expect(removedCachedOption).toBe(true)
  expect(carrierStarts[0]).toMatchObject({ name: "A", x: -0.4, soft: false })
  expect(
    carrierStarts.some((search) => search.name === "A" && search.x === 0.4),
  ).toBe(false)
  expect(result.traces).toHaveLength(2)
  // The low-level negotiator returns raw grid carriers. Use the normal final
  // geometry stage before asserting the public angle/physical acceptance.
  const finish = finishSurfaceTiming(
    result,
    { smoothTuning: true, denseSearch: true },
    { maxSteps: 2000 },
  )
  let finished = finish.next()
  try {
    for (let steps = 0; !finished.done && steps < 2001; steps++)
      finished = finish.next()
    expect(finished.done).toBe(true)
    expect(finished.value).toBeTruthy()
  } finally {
    if (!finished.done) finish.return(null)
  }
  const accepted = finished.value!
  const joined = accepted.traces.map((trace) =>
    joinSignalEscapes(
      trace,
      accepted.escapes.filter(
        (escape) => escape.connection_name === trace.connection_name,
      ),
    ),
  )
  expect(routeAnglesAreConventional(joined)).toBe(true)
  expect(drc(f.native, joined)).toMatchObject({ valid: true, issues: [] })
})

test("partial negotiation preserves the cached unsupported site instead of consuming complete-assignment survivors", () => {
  const { result, carrierStarts, removedCachedOption } = negotiate(false, true)
  expect(removedCachedOption).toBe(true)
  // The original A site remains a routed seed and soft copper for the first B
  // search. A partial result may omit A and must retain that search policy.
  expect(carrierStarts[0]).toMatchObject({ name: "B", x: 0.4, soft: true })
  expect(result.traces).toHaveLength(1)
})

test("healthy retained carriers produce the same physical output with native AC enabled or absent", () => {
  const enabled = negotiate(true, false),
    absent = negotiate(true, false, false)
  expect(enabled.removedCachedOption).toBe(false)
  expect(enabled.result).toEqual(absent.result)
  expect(
    enabled.result.traces.find((trace) => trace.connection_name === "A"),
  ).toEqual(enabled.f.carrier("A", enabled.f.good.escapes))
})

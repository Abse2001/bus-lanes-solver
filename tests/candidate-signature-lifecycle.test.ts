import { expect, spyOn, test } from "bun:test"
import { validateRoutedCopperDrc } from "@tscircuit/fanout-solver"
import * as dogbones from "../lib/alternate-signal-dogbones"
import type { FlexibleSignalState } from "../lib/flexible-signal-state"
import { GridVisibilitySearch } from "../lib/grid-visibility"
import { joinSignalEscapes } from "../lib/join-signal-escapes"
import { negotiateSignalSites } from "../lib/negotiate-signal-sites"
import { routeAnglesAreConventional } from "../lib/route-angle-validation"
import * as poolSolver from "../lib/solve-signal-candidate-pool"
import type { Point, SimpleRouteJson, Trace, Wire } from "../lib/types"

const width = 0.1016
function toyFixture() {
  const native: SimpleRouteJson = {
    layerCount: 4,
    allowedLayers: ["top", "bottom"],
    minTraceWidth: width,
    minTraceToPadEdgeClearance: width,
    minViaPadDiameter: 0.4572,
    minViaHoleDiameter: 0.254,
    minBoardEdgeClearance: 0.1016,
    minViaHoleEdgeToViaHoleEdgeClearance: 0.1,
    bounds: { minX: -4, maxX: 4, minY: -24, maxY: 24 },
    connections: [
      {
        name: "A",
        pointsToConnect: [
          { x: -2, y: 0, layer: "top" },
          { x: 2, y: 0, layer: "top" },
        ],
      },
      ...["B", "C"].map((name, index) => ({
        name,
        pointsToConnect: [-20, 20].map((y) => ({ x: index, y, layer: "top" })),
      })),
    ],
    buses: [{ busId: "C_top", connectionNames: ["C"], allowedLayers: ["top"] }],
    obstacles: [],
    traces: [],
  }
  for (const connection of native.connections)
    for (const point of connection.pointsToConnect)
      native.obstacles.push({
        type: "rect",
        shape: "circle",
        center: point,
        width: 0.3,
        height: 0.3,
        layers: ["top"],
        connectedTo: [connection.name],
      })
  const land = (name: string, end: number) =>
    name === "A"
      ? { x: end ? 2.4 : -2.4, y: 0.4 }
      : { x: name === "B" ? -0.4 : 1.4, y: end ? 20.4 : -20.4 }
  const escape = (name: string, end: number, alternate = false): Trace => {
    const start = native.connections.find(
      (connection) => connection.name === name,
    )!.pointsToConnect[end]
    const via = land(name, end),
      side = end ? 1 : -1
    const head =
      alternate && name === "B"
        ? [
            start,
            { x: 0.4, y: start.y + side * 0.4 },
            { x: 0.4, y: start.y + side },
            { x: 0, y: start.y + side * 1.4 },
            { x: -0.4, y: start.y + side * 1.4 },
            { x: -0.8, y: start.y + side },
            { x: -0.8, y: start.y + side * 0.8 },
            via,
          ]
        : [start, via]
    return {
      type: "pcb_trace",
      pcb_trace_id: `${name}_${end}_${alternate ? "alternate" : "initial"}`,
      connection_name: name,
      source_trace_id: name,
      route: [
        ...head.map((point) => ({
          ...point,
          route_type: "wire" as const,
          layer: "top",
          width,
        })),
        {
          ...via,
          route_type: "via",
          from_layer: "top",
          to_layer: "bottom",
          layers: ["top", "inner1", "inner2", "bottom"],
          via_diameter: 0.4572,
          via_hole_diameter: 0.254,
        },
        { ...via, route_type: "wire", layer: "bottom", width },
      ],
    }
  }
  const carrier = (name: string, layer: string, points: Point[]): Trace => ({
    type: "pcb_trace",
    pcb_trace_id: `cached_${name}`,
    connection_name: name,
    source_trace_id: name,
    route: points.map((point) => ({
      ...point,
      layer,
      route_type: "wire",
      width,
    })),
  })
  const initialB = [escape("B", 0), escape("B", 1)]
  const b = carrier("B", "bottom", [land("B", 0), land("B", 1)])
  const c = carrier("C", "top", native.connections[2].pointsToConnect)
  const state: FlexibleSignalState = {
    native,
    pending: {
      ...native,
      connections: native.connections.map((connection) => ({
        ...connection,
        pointsToConnect: connection.pointsToConnect.map((point) => ({
          ...point,
          layer: connection.name === "B" ? "bottom" : "top",
        })),
      })),
    },
    retained: [],
    traces: [b, c],
    escapes: initialB,
  }
  return { native, state, land, escape }
}
interface ObservedCandidate {
  id: number
  connection: { name: string }
  layer: string
  trace: Trace
  escapes: Trace[]
}
function geometry(candidate: ObservedCandidate) {
  return JSON.stringify([
    candidate.escapes.map((trace) => trace.route),
    candidate.trace.route,
  ])
}

test("actual negotiation readmits evicted physical geometry while preserving held signatures and the 48-candidate pool", () => {
  const f = toyFixture(),
    before = structuredClone(f.state)
  let aVisits = 0,
    changedOthers = false,
    bRerouted = false,
    regenerated = false,
    delayedCSearches = 0
  let firstBottom: ObservedCandidate | undefined,
    finalBottom: ObservedCandidate | undefined
  let pinned: ObservedCandidate[] | undefined,
    sawEviction = false,
    heldDuplicateChecks = 0
  let selectedAfterChange: ObservedCandidate[] | undefined,
    finalPools: ObservedCandidate[][] | undefined
  const originalSolve = poolSolver.solveSignalCandidatePool
  const observePool = spyOn(
    poolSolver,
    "solveSignalCandidatePool",
  ).mockImplementation((...args) => {
    const physical = args[0] as unknown as readonly ObservedCandidate[][]
    const copy = physical.map((domain) => [...domain])
    const a = copy[0],
      bottom = a.find((candidate) => candidate.layer === "bottom")
    expect(a.length).toBeLessThanOrEqual(48)
    if (a.length >= 8) {
      const firstEight = a.slice(-8).reverse()
      if (!pinned) pinned = firstEight
      else
        for (const [index, candidate] of firstEight.entries())
          expect(candidate).toBe(pinned[index])
    }
    const held = a.filter(
      (candidate) =>
        candidate.trace.route[1]?.y === 0.3 && candidate.layer === "top",
    )
    if (aVisits >= 9) {
      expect(held).toHaveLength(1)
      heldDuplicateChecks++
    }
    if (bottom && !firstBottom) {
      firstBottom = bottom
      expect(a).toHaveLength(9)
      expect(a[0]).toBe(bottom)
    }
    if (firstBottom && !bottom && a.length === 48) sawEviction = true
    const selected = originalSolve(...args)
    if (changedOthers && regenerated && selected) {
      selectedAfterChange = selected as unknown as ObservedCandidate[]
      finalBottom = bottom
      finalPools = copy
    }
    return selected
  })
  const generated = spyOn(
    dogbones,
    "routeAlternateSignalDogbones",
  ).mockImplementation((input) => {
    const connection = input.connections[0]
    const escapes = [
      f.escape(connection.name, 0, true),
      f.escape(connection.name, 1, true),
    ]
    return {
      connections: [
        {
          ...connection,
          pointsToConnect: escapes.map((trace) => trace.route.at(-1)!),
        },
      ],
      traces: escapes,
    } as ReturnType<typeof dogbones.routeAlternateSignalDogbones>
  })
  // Controlled carrier results exercise the actual hit/displacement queue,
  // physical compatibility, arc pruning, pool cap, and CSP implementation.
  // This is a deterministic lifecycle fixture, not a G350 routing result.
  const carriers = spyOn(
    GridVisibilitySearch.prototype,
    "step",
  ).mockImplementation(function (this: GridVisibilitySearch) {
    const name = this.scene.connection.name,
      layer = this.scene.connection.pointsToConnect[0].layer
    const nativeEnds = f.native.connections.find(
      (connection) => connection.name === name,
    )!.pointsToConnect
    const directNative =
      layer === "top" &&
      this.start.x === nativeEnds[0].x &&
      this.start.y === nativeEnds[0].y &&
      this.end.x === nativeEnds[1].x &&
      this.end.y === nativeEnds[1].y
    const directBottom =
      layer === "bottom" &&
      this.start.x === f.land(name, 0).x &&
      this.end.x === f.land(name, 1).x
    if (!directNative && !directBottom) {
      this.failed = true
      return
    }
    const penalty = (this as unknown as { penalty: number }).penalty
    let route: Point[] = [this.start, this.end]
    if (penalty >= 10) {
      if (name === "A" && layer === "top") {
        const visit = aVisits++
        const height = visit === 8 || changedOthers ? 0.3 : 0.3 + visit * 0.02
        route = [
          this.start,
          { x: -2 + height, y: height },
          { x: 2 - height, y: height },
          this.end,
        ]
      } else if (name === "A") {
        if (aVisits !== 9 && !changedOthers) {
          this.failed = true
          return
        }
        if (changedOthers) regenerated = true
      } else if (name === "B" && layer === "top") {
        if (!changedOthers) {
          this.failed = true
          return
        }
        bRerouted = true
      } else if (name === "C") {
        if (aVisits >= 49 && !bRerouted) {
          changedOthers = true
          route = [
            this.start,
            { x: 1.8, y: -20.8 },
            { x: 1.8, y: -21.2 },
            { x: 1.4, y: -21.6 },
            { x: 0, y: -21.6 },
            { x: -0.4, y: -21.2 },
            { x: -0.4, y: -18.8 },
            { x: 1, y: -17.4 },
            this.end,
          ]
        } else if (changedOthers && regenerated && delayedCSearches++ < 8) {
          this.failed = true
          return
        }
      }
    }
    this.result = route
    this.solved = true
  })
  const work = negotiateSignalSites(
    f.state,
    new Set(["A", "B", "C"]),
    false,
    false,
    { allowExpandedSites: false, retainExistingRoutes: true },
  )
  let next = work.next(),
    yields = 0
  try {
    while (!next.done && yields++ < 10000) next = work.next()
    expect(next.done).toBe(true)
    expect(next.value).toBeTruthy()
    expect(yields).toBeLessThan(10000)
    expect(aVisits).toBeGreaterThanOrEqual(50)
    expect(sawEviction).toBe(true)
    expect(heldDuplicateChecks).toBeGreaterThan(0)
    expect(firstBottom).toBeDefined()
    expect(finalBottom).toBeDefined()
    expect(finalBottom).not.toBe(firstBottom)
    expect(geometry(finalBottom!)).toBe(geometry(firstBottom!))
    expect(selectedAfterChange?.[0]).toBe(finalBottom)
    expect(finalPools?.[0]).toHaveLength(48)
    const bBottom = finalPools![1].filter(
      (candidate) => candidate.layer === "bottom",
    )
    expect(bBottom).toHaveLength(2)
    expect(bBottom[0].trace.route).toEqual(bBottom[1].trace.route)
    expect(bBottom[0].escapes.map((trace) => trace.route)).not.toEqual(
      bBottom[1].escapes.map((trace) => trace.route),
    )
    for (const candidate of bBottom) {
      const joined = joinSignalEscapes(candidate.trace, candidate.escapes)
      expect(routeAnglesAreConventional([joined])).toBe(true)
      expect(
        validateRoutedCopperDrc({
          inputSrj: f.native,
          routedSrj: { ...f.native, traces: [joined] },
          clearance: width,
          allowBlindAndBuriedVias: false,
        } as Parameters<typeof validateRoutedCopperDrc>[0]),
      ).toMatchObject({ valid: true, issues: [] })
    }
    const selected = selectedAfterChange!
    const joined = selected.map((candidate) =>
      joinSignalEscapes(candidate.trace, candidate.escapes),
    )
    expect(routeAnglesAreConventional(joined)).toBe(true)
    expect(joined).toHaveLength(3)
    const drc = validateRoutedCopperDrc({
      inputSrj: f.native,
      routedSrj: { ...f.native, traces: joined },
      clearance: width,
      allowBlindAndBuriedVias: false,
    } as Parameters<typeof validateRoutedCopperDrc>[0])
    expect(drc).toMatchObject({ valid: true, issues: [] })
    const vias = joined.flatMap((trace) =>
      trace.route.filter((point) => point.route_type === "via"),
    )
    expect(vias).toHaveLength(2)
    for (const via of vias)
      expect(via).toMatchObject({
        layers: ["top", "inner1", "inner2", "bottom"],
        via_diameter: 0.4572,
        via_hole_diameter: 0.254,
      })
    expect(f.state).toEqual(before)
  } finally {
    if (!next.done) work.return(null)
    carriers.mockRestore()
    generated.mockRestore()
    observePool.mockRestore()
  }
})
